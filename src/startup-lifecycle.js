/**
 * Owns the asynchronous Harness startup lifecycle.
 *
 * Every start receives a monotonically increasing generation token. A token may
 * only publish the server/origin while it is current; cleanup is compare-and-
 * swap guarded, so a stale startup can stop only the HarnessServer it created.
 * This seam intentionally has no Electron dependency so races can be tested
 * deterministically with controlled promises.
 */
export function createHarnessLifecycleOwner({ isQuitting = () => false, onPublish = () => {}, onClear = () => {} } = {}) {
  if (typeof isQuitting !== 'function') throw new TypeError('Invalid lifecycle quit predicate')
  if (typeof onPublish !== 'function') throw new TypeError('Invalid lifecycle publish callback')
  if (typeof onClear !== 'function') throw new TypeError('Invalid lifecycle clear callback')

  let generation = 0
  let published
  let unsafe = false
  let cleanupError
  const localServers = new Map()
  const stoppingServers = new Map()

  function markUnsafe(error) {
    const normalized = error instanceof Error ? error : new Error(String(error ?? 'Harness lifecycle cleanup failed'))
    unsafe = true
    if (cleanupError === undefined || cleanupError === normalized) {
      cleanupError = normalized
    } else if (!(cleanupError instanceof AggregateError) || !cleanupError.errors.includes(normalized)) {
      cleanupError = new AggregateError(
        [cleanupError, normalized],
        `Harness lifecycle cleanup incomplete: ${cleanupError?.message ?? String(cleanupError)}; ${normalized.message}`,
      )
    }
    return cleanupError
  }

  function unsafeFailure() {
    return cleanupError ?? new Error('Harness lifecycle is unsafe after incomplete cleanup')
  }

  function begin() {
    if (unsafe) throw unsafeFailure()
    generation += 1
    return generation
  }

  function invalidate() {
    generation += 1
    return generation
  }

  function isCurrent(token) {
    return token === generation && !isQuitting() && !unsafe
  }

  function attach(token, harnessServer) {
    if (!Number.isSafeInteger(token) || token < 1) throw new TypeError('Invalid lifecycle generation')
    if (harnessServer === undefined || harnessServer === null || typeof harnessServer.stop !== 'function') {
      throw new TypeError('Invalid HarnessServer')
    }
    if (unsafe) return false
    // A generation may only attach while it owns the current token. In
    // particular, do not retain a stale server after stopOlder() has already
    // taken its snapshot; that would leave an untracked child behind.
    if (!isCurrent(token)) return false
    for (const [candidate, server] of localServers) {
      if (candidate !== token && server === harnessServer) return false
    }
    if (stoppingServers.has(harnessServer)) return false
    if (published !== undefined && published.generation !== token && published.server === harnessServer) return false
    localServers.set(token, harnessServer)
    return true
  }

  function isPublished(token, harnessServer) {
    return published?.generation === token && published.server === harnessServer
  }

  /** Publish only if the caller still owns this generation and local server. */
  function publish(token, harnessServer, origin) {
    if (unsafe || !isCurrent(token) || localServers.get(token) !== harnessServer) return false
    if (published !== undefined && !isPublished(token, harnessServer)) return false
    if (typeof origin !== 'string' || origin.length === 0) throw new TypeError('Invalid Harness origin')
    const previous = published
    published = Object.freeze({ generation: token, server: harnessServer, origin })
    onPublish(published, previous)
    return true
  }

  /** Clear only the exact publication still owned by this generation/server. */
  function clearPublished(token, harnessServer) {
    if (!isPublished(token, harnessServer)) return false
    const previous = published
    published = undefined
    onClear(previous)
    return true
  }

  async function stopLocal(token, harnessServer) {
    if (localServers.get(token) !== harnessServer) return false
    // Never let an old token stop a server that has since been published by a
    // newer token. This also protects the edge case where a caller accidentally
    // tries to reuse one HarnessServer object across generations.
    if (published?.server === harnessServer && published.generation !== token) {
      localServers.delete(token)
      return false
    }

    // A stale generation cannot clear a newer publication because this is an
    // exact token/server compare-and-swap.
    clearPublished(token, harnessServer)
    let stopping = stoppingServers.get(harnessServer)
    if (stopping === undefined) {
      try { stopping = Promise.resolve(harnessServer.stop()) } catch (error) { stopping = Promise.reject(error) }
      stoppingServers.set(harnessServer, stopping)
    }
    let completed = false
    try {
      await stopping
      completed = true
    } catch (error) {
      throw markUnsafe(error)
    } finally {
      // Keep an unresolved local server tracked after rejected cleanup. The
      // unsafe latch blocks replacement, while a later stopAll can still make
      // the exact owner retry/idempotently surface the same failure.
      if (completed && localServers.get(token) === harnessServer) localServers.delete(token)
      if (stoppingServers.get(harnessServer) === stopping) stoppingServers.delete(harnessServer)
    }
    return true
  }

  async function surfaceCleanupFailures(promises, label) {
    const results = await Promise.allSettled(promises)
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length > 0) {
      const failure = failures.length === 1
        ? failures[0]
        : new AggregateError(failures, `${label} cleanup incomplete: ${failures.map(error => error?.message ?? String(error)).join('; ')}`)
      throw markUnsafe(failure)
    }
    if (unsafe) throw unsafeFailure()
  }

  async function stopOlder(token) {
    const older = [...localServers.entries()]
      .filter(([candidate]) => candidate < token)
      .map(([candidate, harnessServer]) => [candidate, harnessServer])
    await surfaceCleanupFailures(older.map(([candidate, harnessServer]) => stopLocal(candidate, harnessServer)), 'Older Harness')
  }

  async function stopAll() {
    const owned = [...localServers.entries()]
    // Invalidate before cleanup so no in-flight await can publish after quit.
    invalidate()
    await surfaceCleanupFailures(owned.map(([token, harnessServer]) => stopLocal(token, harnessServer)), 'Harness')
  }

  /**
   * Run one asynchronous startup transaction with an owned generation context.
   * The callback may return false when a generation loses the race; in that
   * case, or when it throws, any still-attached local server is stopped by the
   * owner before the result is released to the caller.
   */
  async function run(task, { stopOlder: stopPrevious = false } = {}) {
    if (typeof task !== 'function') throw new TypeError('Invalid lifecycle task')
    const token = begin()
    const context = Object.freeze({
      generation: token,
      isCurrent: () => isCurrent(token),
      isPublished: harnessServer => isPublished(token, harnessServer),
      attach: harnessServer => attach(token, harnessServer),
      publish: (harnessServer, origin) => publish(token, harnessServer, origin),
      stop: harnessServer => stopLocal(token, harnessServer),
    })
    let completed = false
    try {
      if (stopPrevious) await stopOlder(token)
      if (!isCurrent(token)) return false
      const result = await task(context)
      completed = result === true
      return result
    } finally {
      const owned = localServers.get(token)
      if (owned !== undefined && (!completed || !isCurrent(token))) {
        await stopLocal(token, owned)
      }
    }
  }

  return Object.freeze({
    attach,
    begin,
    clearPublished,
    get cleanupError() { return cleanupError },
    get generation() { return generation },
    get published() { return published },
    get unsafe() { return unsafe },
    invalidate,
    isCurrent,
    isPublished,
    markUnsafe,
    publish,
    run,
    stopAll,
    stopLocal,
    stopOlder,
    status() {
      return Object.freeze({ generation, published, unsafe, cleanupError })
    },
    statusSnapshot() { return this.status() },
  })
}
