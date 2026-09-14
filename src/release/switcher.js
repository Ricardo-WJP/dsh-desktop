import { randomUUID as randomUUIDDefault } from 'node:crypto'
import { SnapshotStore } from './snapshot-store.js'
import { validateReleasePointer } from './state-store.js'

export const DEFAULT_OBSERVE_DURATION = 120_000
export const DEFAULT_RECOVERY_OBSERVE_DURATION = 5_000
export const DEFAULT_SNAPSHOT_EXCLUSIONS = Object.freeze(['profiles/node_modules'])

const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MANIFEST_SHA256 = /^[a-f0-9]{64}$/i
const PENDING_PHASES = Object.freeze([
  'prepared',
  'snapshot-published',
  'active-published',
  'observing',
  'restoring',
])

export class ReleaseSwitcherError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'ReleaseSwitcherError'
    if (options?.phase !== undefined) this.phase = options.phase
    if (options?.recoveryError !== undefined) this.recoveryError = options.recoveryError
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function errorChainHasCode(error, expectedCode) {
  const visited = new Set()
  let current = error
  while (isObject(current) && !visited.has(current)) {
    visited.add(current)
    if (current.code === expectedCode) return true
    current = current.cause
  }
  return false
}

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  throw new DOMException(reason === undefined ? 'The operation was aborted' : String(reason), 'AbortError')
}

function canonicalTimestamp(now) {
  const value = typeof now === 'function' ? now() : now
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid release transaction timestamp')
  return date.toISOString()
}

function safeSnapshotId(value, label = 'snapshot id') {
  if (typeof value !== 'string' || !SNAPSHOT_ID.test(value)) throw new TypeError(`Invalid ${label}`)
  return value
}

function pointerOrNull(value) {
  if (value === undefined || value === null) return null
  return validateReleasePointer(value)
}

function samePointer(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return left === right
  return left.schemaVersion === right.schemaVersion
    && left.releaseId === right.releaseId
    && left.manifestSha256 === right.manifestSha256
    && left.activatedAt === right.activatedAt
}

function adapterFailure(result) {
  if (result === false || result === null) return true
  if (!isObject(result)) return false
  if (result.success === false || result.ok === false || result.ready === false) return true
  if (typeof result.status === 'string' && ['failed', 'error', 'not-ready', 'unready'].includes(result.status)) return true
  return false
}

function stopConfirmed(result) {
  return result === true || result?.success === true || result?.ok === true
}

function checkpointNames(point) {
  const segments = point.split(':')
  const operation = segments.shift() ?? point
  const suffix = segments.join('-')
  const camelSuffix = suffix
    .split('-')
    .filter(Boolean)
    .map((part, index) => index === 0 ? part : `${part[0].toUpperCase()}${part.slice(1)}`)
    .join('')
  const capitalized = camelSuffix === '' ? '' : `${camelSuffix[0].toUpperCase()}${camelSuffix.slice(1)}`
  return [...new Set([
    point,
    `${operation}.${suffix}`,
    `${operation}_${suffix}`,
    `${operation}-${suffix}`,
    suffix,
    `after-${suffix}`,
    `${operation}:after-${suffix}`,
    `${operation}:after${capitalized}`,
    `after${capitalized}`,
  ].filter(Boolean))]
}

function failureFrom(value, fallback) {
  if (value instanceof Error) return value
  return new ReleaseSwitcherError(fallback ?? String(value))
}

function actionOptions(value) {
  if (value === undefined) return {}
  if (isObject(value)) return value
  if (typeof value === 'string') return { candidateId: value }
  throw new TypeError('Release operation options must be an object')
}

function resolvedReleaseOptions(value) {
  if (!isObject(value)) throw new TypeError('Candidate resolver must return an object')
  if (!Object.hasOwn(value, 'candidate') || value.candidate === undefined || value.candidate === null) {
    throw new TypeError('Candidate resolver must return a verified candidate')
  }
  if (!Object.hasOwn(value, 'pointer')) throw new TypeError('Candidate resolver must return a release pointer')
  if (!Object.hasOwn(value, 'recipe') || value.recipe === undefined || value.recipe === null) {
    throw new TypeError('Candidate resolver must return an activation recipe')
  }
  return value
}

export class ReleaseSwitcher {
  constructor(options = {}) {
    if (!isObject(options)) throw new TypeError('ReleaseSwitcher options must be an object')

    this.stateStore = options.stateStore ?? options.state
    this.dataRoot = options.dataRoot
    this.candidateResolver = options.candidateResolver
    this.stopOwned = options.stopOwned
    this.startRelease = options.startRelease
    this.observeRelease = options.observeRelease
    this.preserveDataOnSwitch = options.preserveDataOnSwitch === true
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
    this.now = options.now ?? (() => new Date())
    this.observeDuration = options.observeDuration ?? DEFAULT_OBSERVE_DURATION
    this.recoveryObserveDuration = options.recoveryObserveDuration
      ?? (options.observeDuration === 0 ? 0 : DEFAULT_RECOVERY_OBSERVE_DURATION)
    this.snapshotExcludedRelativePaths = options.snapshotExcludedRelativePaths
      ?? options.excludedRelativePaths
      ?? DEFAULT_SNAPSHOT_EXCLUSIONS
    if (!Array.isArray(this.snapshotExcludedRelativePaths)) throw new TypeError('snapshotExcludedRelativePaths must be an array')
    this.snapshotExcludedRelativePaths = Object.freeze([...this.snapshotExcludedRelativePaths])
    this.faults = options.faults ?? options.failurePoints ?? options.faultCheckpoints
    this.randomUUID = options.randomUUID ?? randomUUIDDefault

    if (!isObject(this.stateStore)) throw new TypeError('ReleaseSwitcher requires a stateStore')
    for (const method of ['readActive', 'readLastKnownGood', 'writeActive', 'writeLastKnownGood', 'readPending', 'writePending', 'clearPending']) {
      if (typeof this.stateStore[method] !== 'function') throw new TypeError(`stateStore.${method} must be a function`)
    }
    if (typeof this.candidateResolver !== 'function') throw new TypeError('candidateResolver must be a function')
    if (typeof this.stopOwned !== 'function') throw new TypeError('stopOwned must be a function')
    if (typeof this.startRelease !== 'function') throw new TypeError('startRelease must be a function')
    if (typeof this.observeRelease !== 'function') throw new TypeError('observeRelease must be a function')
    if (typeof this.dataRoot !== 'string' || this.dataRoot === '' || this.dataRoot.includes('\0')) {
      throw new TypeError('dataRoot must be a non-empty path')
    }

    this.snapshotStore = options.snapshotStore
      ?? new SnapshotStore({
        sourceRoot: this.dataRoot,
        dataRoot: this.dataRoot,
        snapshotRoot: options.snapshotRoot,
        excludedRelativePaths: this.snapshotExcludedRelativePaths,
      })
    if (!isObject(this.snapshotStore)) throw new TypeError('ReleaseSwitcher requires a snapshotStore')
    for (const method of ['create', 'restore']) {
      if (typeof this.snapshotStore[method] !== 'function') throw new TypeError(`snapshotStore.${method} must be a function`)
    }
  }

  _progress(stage, details = {}) {
    try {
      this.onProgress({ stage, ...details })
    } catch {
      // Recovery state must not depend on the diagnostic sink staying alive.
    }
  }

  async switch(candidateId, options = {}) {
    const operationOptions = actionOptions(options)
    const signal = operationOptions.signal
    throwIfAborted(signal)
    this._assertNoPending()

    const target = await this._resolveCandidate(candidateId, signal)
    const expectedManifestSha256 = operationOptions.expectedManifestSha256
    if (expectedManifestSha256 !== undefined) {
      if (typeof expectedManifestSha256 !== 'string' || !MANIFEST_SHA256.test(expectedManifestSha256)) {
        throw new TypeError('Invalid expected candidate manifest SHA-256')
      }
      if (target.pointer.manifestSha256 !== expectedManifestSha256.toLowerCase()) {
        throw new ReleaseSwitcherError(`Candidate ${candidateId} manifest changed after verification`)
      }
    }
    const previousActive = pointerOrNull(this.stateStore.readActive() ?? this.stateStore.readLastKnownGood())
    if (previousActive === null) throw new ReleaseSwitcherError('No active or last-known-good release is available for switching')
    const startedAt = canonicalTimestamp(this.now)
    let pending = this._newPending({
      operation: 'switch',
      previousActive,
      targetActive: target.pointer,
      startedAt,
    })
    pending = this._writeInitialPending(pending)
    await this._fault('switch:pending-prepared', { pending, release: target, signal })

    return this._forwardSwitch({
      pending,
      target,
      signal,
      stopped: false,
      startedAt,
    })
  }

  switchTo(candidateId, options = {}) {
    return this.switch(candidateId, options)
  }

  async manualRollback(snapshotId, options = {}) {
    const operationOptions = typeof options === 'string' ? { candidateId: options } : actionOptions(options)
    const signal = operationOptions.signal
    throwIfAborted(signal)
    safeSnapshotId(snapshotId)
    this._assertNoPending()

    const previousActive = pointerOrNull(this.stateStore.readActive() ?? this.stateStore.readLastKnownGood())
    if (previousActive === null) throw new ReleaseSwitcherError('No active or last-known-good release is available for rollback')
    const target = await this._resolveRollbackTarget(operationOptions, signal)
    const startedAt = canonicalTimestamp(this.now)
    let pending = this._newPending({
      operation: 'rollback',
      previousActive,
      targetActive: target.pointer,
      snapshotId,
      startedAt,
    })
    pending = this._writeInitialPending(pending)
    await this._fault('rollback:pending-prepared', { pending, release: target, signal })

    return this._forwardRollback({
      pending,
      target,
      signal,
      stopped: false,
      restoreCompleted: false,
      startedAt,
    })
  }

  rollback(snapshotId, options = {}) {
    return this.manualRollback(snapshotId, options)
  }

  async recoverPending(options = {}) {
    const operationOptions = actionOptions(options)
    const signal = operationOptions.signal
    throwIfAborted(signal)
    let pending = this.stateStore.readPending()
    if (pending === undefined || pending === null) return { status: 'idle', pending: null }
    if (!PENDING_PHASES.includes(pending.phase)) throw new ReleaseSwitcherError(`Unsupported pending phase ${String(pending.phase)}`)
    this._progress('recover-start', { operation: pending.operation, phase: pending.phase })

    if (pending.phase === 'restoring') {
      try {
        this._progress('recover-published-start', { phase: pending.phase })
        await this._recoverPublished({ pending, signal })
        this._progress('recover-complete', { operation: pending.operation, phase: pending.phase })
        return { status: 'recovered', operation: pending.operation, phase: 'restoring' }
      } catch (error) {
        return this._recoverRestoringWithoutSnapshot({ pending, signal, error })
      }
    }

    const active = pointerOrNull(this.stateStore.readActive())
    const activeWasPublished = pending.targetActive !== null && samePointer(active, pending.targetActive)
    if (pending.phase === 'active-published' || pending.phase === 'observing' || activeWasPublished) {
      await this._recoverPublished({ pending, signal })
      return { status: 'recovered', operation: pending.operation, phase: pending.phase }
    }

    if (pending.operation === 'switch') {
      const target = await this._resolvePointerRelease(pending.targetActive, signal)
      return this._forwardSwitch({
        pending,
        target,
        signal,
        stopped: false,
        startedAt: pending.startedAt,
      })
    }

    const target = await this._resolvePointerRelease(pending.targetActive, signal)
    return this._forwardRollback({
      pending,
      target,
      signal,
      stopped: false,
      restoreCompleted: false,
      startedAt: pending.startedAt,
    })
  }

  _assertNoPending() {
    const pending = this.stateStore.readPending()
    if (pending !== undefined && pending !== null) {
      throw new ReleaseSwitcherError('Pending release transaction must be recovered before starting another operation', { phase: pending.phase })
    }
  }

  _writeInitialPending(pending) {
    // Candidate resolution can yield after the entry guard. Re-check at the
    // synchronous publication boundary so an intervening journal is preserved.
    this._assertNoPending()
    return this._writePending(pending)
  }

  _newPending({ operation, previousActive, targetActive, snapshotId = null, rescueSnapshotId = null, startedAt }) {
    return {
      operation,
      ...(operation === 'switch' && this.preserveDataOnSwitch ? { dataPolicy: 'preserve' } : {}),
      phase: 'prepared',
      previousActive,
      targetActive,
      snapshotId,
      rescueSnapshotId,
      startedAt,
    }
  }

  _writePending(pending) {
    const written = this.stateStore.writePending(pending)
    return written ?? pending
  }

  _updatePending(pending, changes) {
    return this._writePending({ ...pending, ...changes })
  }

  async _resolveCandidate(candidateId, signal, resolverOptions = {}) {
    if (typeof candidateId !== 'string' || candidateId === '') throw new TypeError('candidateId must be a non-empty string')
    throwIfAborted(signal)
    const resolved = resolvedReleaseOptions(await this.candidateResolver(candidateId, {
      ...(isObject(resolverOptions) ? resolverOptions : {}),
      signal,
    }))
    const pointer = validateReleasePointer(resolved.pointer)
    if (pointer.releaseId !== candidateId) throw new ReleaseSwitcherError(`Candidate pointer ${pointer.releaseId} does not match ${candidateId}`)
    if (resolved.pointer === pointer) return resolved
    return { ...resolved, pointer }
  }

  async _resolvePointerRelease(expectedPointer, signal, resolverOptions = {}) {
    if (expectedPointer === null || expectedPointer === undefined) {
      throw new ReleaseSwitcherError('Pending transaction has no release pointer to resolve')
    }
    const resolved = await this._resolveCandidate(expectedPointer.releaseId, signal, resolverOptions)
    if (resolved.pointer.manifestSha256 !== expectedPointer.manifestSha256) {
      throw new ReleaseSwitcherError(`Resolved release ${expectedPointer.releaseId} does not match the pending manifest`)
    }
    if (samePointer(resolved.pointer, expectedPointer)) return resolved
    return { ...resolved, pointer: expectedPointer }
  }

  async _resolveRollbackTarget(options, signal) {
    const direct = options.targetRelease ?? options.release ?? options.target
      ?? (Object.hasOwn(options, 'candidate') && Object.hasOwn(options, 'pointer') && Object.hasOwn(options, 'recipe') ? options : undefined)
    if (direct !== undefined) {
      const resolved = resolvedReleaseOptions(direct)
      const pointer = validateReleasePointer(resolved.pointer)
      return resolved.pointer === pointer ? resolved : { ...resolved, pointer }
    }

    const candidateId = options.candidateId ?? options.targetCandidateId
    if (candidateId !== undefined) return this._resolveCandidate(candidateId, signal)

    const pointer = pointerOrNull(options.targetPointer ?? this.stateStore.readLastKnownGood())
    if (pointer === null) throw new ReleaseSwitcherError('Rollback requires a last-known-good release or target parameters')
    return this._resolvePointerRelease(pointer, signal)
  }

  _snapshotId(prefix) {
    const token = String(this.randomUUID())
    const value = `${prefix}-${token}`
    return safeSnapshotId(value.slice(0, 128))
  }

  async _createSnapshot(kind, startedAt, signal) {
    const requestedId = this._snapshotId(kind === 'rescue' ? 'rescue' : 'pre-switch')
    throwIfAborted(signal)
    const result = await this.snapshotStore.create({
      kind,
      snapshotId: requestedId,
      sourceRoot: this.dataRoot,
      dataRoot: this.dataRoot,
      createdAt: startedAt,
      excludedRelativePaths: this.snapshotExcludedRelativePaths,
      signal,
    })
    if (adapterFailure(result)) throw new ReleaseSwitcherError(`snapshotStore.create did not complete for ${kind}`)
    const snapshotId = result?.snapshotId ?? result?.id ?? requestedId
    safeSnapshotId(snapshotId, `${kind} snapshot id`)
    return { result, snapshotId }
  }

  async _restoreSnapshot(snapshotId, signal) {
    safeSnapshotId(snapshotId)
    throwIfAborted(signal)
    const result = await this.snapshotStore.restore({
      snapshotId,
      id: snapshotId,
      sourceRoot: this.dataRoot,
      dataRoot: this.dataRoot,
      excludedRelativePaths: this.snapshotExcludedRelativePaths,
      signal,
    })
    if (adapterFailure(result)) throw new ReleaseSwitcherError(`snapshotStore.restore did not complete for ${snapshotId}`)
    return result
  }

  async _stop(signal) {
    throwIfAborted(signal)
    const result = await this.stopOwned({ signal })
    if (!stopConfirmed(result)) throw new ReleaseSwitcherError('stopOwned did not confirm that owned processes stopped')
    return result
  }

  async _startAndObserve(release, signal, { durationMs } = {}) {
    throwIfAborted(signal)
    const started = await this.startRelease(release, { signal })
    if (adapterFailure(started)) throw new ReleaseSwitcherError(`Release ${release.pointer.releaseId} did not become ready to start`)
    throwIfAborted(signal)
    const observationDuration = durationMs === undefined ? this._observeDuration(release) : durationMs
    if (typeof observationDuration !== 'number' || !Number.isFinite(observationDuration) || observationDuration < 0) {
      throw new TypeError('recoveryObserveDuration must be a non-negative finite number')
    }
    const observed = await this.observeRelease(release, { signal, durationMs: observationDuration })
    if (adapterFailure(observed)) throw new ReleaseSwitcherError(`Release ${release.pointer.releaseId} failed observation`)
    return { started, observed, durationMs: observationDuration }
  }

  _observeDuration(release) {
    const value = typeof this.observeDuration === 'function'
      ? this.observeDuration({ release })
      : this.observeDuration
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError('observeDuration must be a non-negative finite number')
    return value
  }

  async _fault(point, context = {}) {
    const faults = this.faults
    if (faults === undefined || faults === null) return
    const payload = { ...context, point }
    if (typeof faults === 'function') {
      const result = await faults(point, payload)
      if (result instanceof Error) throw result
      if (result === false) throw new ReleaseSwitcherError(`Injected fault at ${point}`)
      return
    }
    if (!isObject(faults)) return
    for (const name of checkpointNames(point)) {
      const fault = faults[name]
      if (fault === undefined) continue
      if (typeof fault === 'function') {
        const result = await fault(payload)
        if (result instanceof Error) throw result
        if (result === false || result === true) throw new ReleaseSwitcherError(`Injected fault at ${point}`)
      } else if (fault instanceof Error) {
        throw fault
      } else if (fault) {
        throw new ReleaseSwitcherError(`Injected fault at ${point}`)
      }
      return
    }
  }

  async _forwardSwitch({ pending, target, signal, stopped, startedAt }) {
    let stopCompleted = stopped
    let activeWriteAttempted = false
    let snapshotCreated = false
    let cleanupError

    try {
      if (pending.phase === 'prepared') {
        await this._stop(signal)
        stopCompleted = true
        await this._fault('switch:stop-owned', { pending, release: target, signal })

        const snapshot = await this._createSnapshot('pre-switch', startedAt, signal)
        snapshotCreated = true
        pending = this._updatePending(pending, { phase: 'snapshot-published', snapshotId: snapshot.snapshotId })
        await this._fault('switch:snapshot-published', { pending, release: target, signal })
      }

      if (pending.phase !== 'snapshot-published') throw new ReleaseSwitcherError(`Cannot continue switch from phase ${pending.phase}`)
      if (!stopCompleted) {
        await this._stop(signal)
        stopCompleted = true
        await this._fault('switch:stop-owned', { pending, release: target, signal })
      }

      this.stateStore.writeLastKnownGood(pending.previousActive)
      await this._fault('switch:lkg-old', { pending, release: target, signal })

      activeWriteAttempted = true
      this.stateStore.writeActive(target.pointer)
      await this._fault('switch:active-written', { pending, release: target, signal })

      pending = this._updatePending(pending, { phase: 'active-published' })
      await this._fault('switch:active-published', { pending, release: target, signal })

      await this._startAndObserveInPhases(target, pending, signal, 'switch')
      pending = this._updatePending(pending, { phase: 'observing' })
      await this._fault('switch:observing', { pending, release: target, signal })

      await this._observeOnly(target, signal)
      await this._fault('switch:observed', { pending, release: target, signal })

      this.stateStore.writeLastKnownGood(target.pointer)
      await this._fault('switch:lkg-target', { pending, release: target, signal })
      if (pending.previousActive?.releaseId !== target.pointer.releaseId) this.stateStore.writePrevious?.(pending.previousActive)
      this.stateStore.clearPending()
      return {
        status: 'switched',
        operation: 'switch',
        release: target,
        pointer: target.pointer,
        snapshotId: pending.snapshotId,
      }
    } catch (error) {
      // Cancellation ends the requested switch, but it must not cancel the
      // safety rollback after the active pointer was already published. Use a
      // detached cleanup signal so the previous release is restored before the
      // aborted operation is reported to its caller.
      const recoverySignal = signal?.aborted ? undefined : signal
      if (activeWriteAttempted) {
        try {
          await this._recoverPublished({ pending, signal: recoverySignal })
        } catch (recoveryError) {
          error = this._annotateRecoveryFailure(error, recoveryError)
        }
      } else if (stopCompleted) {
        try {
          await this._cleanupBeforeActive({
            pending,
            operation: 'switch',
            signal: recoverySignal,
            restoreSnapshot: snapshotCreated || pending.snapshotId !== null,
          })
          // The active pointer was never changed and the previous release has
          // been proven healthy again. Retire this failed transaction so a
          // deleted or rejected candidate cannot be retried from a stale
          // prepared journal during the next desktop startup.
          this.stateStore.clearPending()
        } catch (errorDuringCleanup) {
          cleanupError = errorDuringCleanup
          error = this._annotateRecoveryFailure(error, cleanupError)
        }
      }
      throw failureFrom(error, 'Release switch failed')
    }
  }

  async _startAndObserveInPhases(release, pending, signal, operation) {
    throwIfAborted(signal)
    const started = await this.startRelease(release, { signal })
    if (adapterFailure(started)) throw new ReleaseSwitcherError(`Release ${release.pointer.releaseId} did not become ready to start`)
    await this._fault(`${operation}:start-target`, { pending, release, signal })
  }

  async _observeOnly(release, signal) {
    throwIfAborted(signal)
    const durationMs = this._observeDuration(release)
    const observed = await this.observeRelease(release, { signal, durationMs })
    throwIfAborted(signal)
    if (adapterFailure(observed)) throw new ReleaseSwitcherError(`Release ${release.pointer.releaseId} failed observation`)
    return observed
  }

  async _forwardRollback({ pending, target, signal, stopped, restoreCompleted, startedAt }) {
    let stopCompleted = stopped
    let targetRestoreAttempted = restoreCompleted
    let activeWriteAttempted = false
    let rescueCreated = false

    try {
      if (pending.phase === 'prepared') {
        await this._stop(signal)
        stopCompleted = true
        await this._fault('rollback:stop-owned', { pending, release: target, signal })
        const rescue = await this._createSnapshot('rescue', startedAt, signal)
        rescueCreated = true
        pending = this._updatePending(pending, {
          phase: 'snapshot-published',
          rescueSnapshotId: rescue.snapshotId,
        })
        await this._fault('rollback:rescue-published', { pending, release: target, signal })
      }

      if (pending.phase !== 'snapshot-published') throw new ReleaseSwitcherError(`Cannot continue rollback from phase ${pending.phase}`)
      if (!stopCompleted) {
        await this._stop(signal)
        stopCompleted = true
        await this._fault('rollback:stop-owned', { pending, release: target, signal })
      }

      targetRestoreAttempted = true
      await this._restoreSnapshot(pending.snapshotId, signal)
      await this._fault('rollback:target-restored', { pending, release: target, signal })

      activeWriteAttempted = true
      this.stateStore.writeActive(target.pointer)
      await this._fault('rollback:active-written', { pending, release: target, signal })
      pending = this._updatePending(pending, { phase: 'active-published' })
      await this._fault('rollback:active-published', { pending, release: target, signal })

      await this._startAndObserveInPhases(target, pending, signal, 'rollback')
      pending = this._updatePending(pending, { phase: 'observing' })
      await this._fault('rollback:observing', { pending, release: target, signal })
      await this._observeOnly(target, signal)
      await this._fault('rollback:observed', { pending, release: target, signal })

      this.stateStore.writeLastKnownGood(target.pointer)
      await this._fault('rollback:lkg-target', { pending, release: target, signal })
      this.stateStore.clearPending()
      return {
        status: 'rolled-back',
        operation: 'rollback',
        release: target,
        pointer: target.pointer,
        snapshotId: pending.snapshotId,
        rescueSnapshotId: pending.rescueSnapshotId,
      }
    } catch (error) {
      // An aborted request must not abort the safety recovery that restores
      // the previous active release. This mirrors the switch path above.
      const recoverySignal = signal?.aborted ? undefined : signal
      if (activeWriteAttempted) {
        try {
          await this._recoverPublished({ pending, signal: recoverySignal })
        } catch (recoveryError) {
          error = this._annotateRecoveryFailure(error, recoveryError)
        }
      } else if (stopCompleted) {
        try {
          await this._cleanupBeforeActive({
            pending,
            operation: 'rollback',
            signal: recoverySignal,
            restoreSnapshot: targetRestoreAttempted,
          })
          // No data restore was attempted, or the rescue restoration above
          // completed and the old release was proved ready. A partial restore
          // must never be retired on process readiness alone.
          this.stateStore.clearPending()
        } catch (cleanupError) {
          error = this._annotateRecoveryFailure(error, cleanupError)
        }
      } else if (rescueCreated) {
        // The rescue snapshot is already journaled. Do not remove it when a
        // later operation fails before ownership is stopped.
      }
      throw failureFrom(error, 'Manual rollback failed')
    }
  }

  async _cleanupBeforeActive({ pending, operation, signal, restoreSnapshot }) {
    const errors = []
    if (restoreSnapshot && pending.dataPolicy !== 'preserve') {
      this._progress('recover-snapshot-start', { operation, phase: pending.phase })
      const snapshotId = operation === 'rollback' ? pending.rescueSnapshotId : pending.snapshotId
      if (snapshotId !== null && snapshotId !== undefined) {
        try {
          await this._restoreSnapshot(snapshotId, signal)
          this._progress('recover-snapshot-complete', { operation, phase: pending.phase })
        } catch (error) {
          errors.push(error)
        }
      }
    }

    try {
      // The previous release is re-checked by its canonical manifest/profile
      // data and then proved by the start/observe phase below. Its full runtime
      // inventory was already required before the candidate could become an
      // active pointer, so do not make rollback wait on another large hash pass.
      const previous = await this._resolvePointerRelease(pending.previousActive, signal, { verifyRuntime: false })
      this._progress('recover-previous-resolved', { operation, phase: pending.phase })
      await this._startAndObserve(previous, signal, { durationMs: this.recoveryObserveDuration })
      this._progress('recover-previous-ready', { operation, phase: pending.phase })
    } catch (error) {
      errors.push(error)
    }
    if (errors.length > 0) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Unable to re-establish the previous release')
  }

  async _recoverRestoringWithoutSnapshot({ pending, signal, error }) {
    const active = pointerOrNull(this.stateStore.readActive())
    const previousIsStillActive = pending.previousActive !== null
      && pending.targetActive === null
      && samePointer(active, pending.previousActive)
    if (!errorChainHasCode(error, 'ENOENT')) throw error
    this._progress('recover-snapshot-missing', { operation: pending.operation, phase: pending.phase })

    if (!previousIsStillActive) {
      // The snapshot is the preferred data rollback, but a crash or a second
      // reconciler can remove it after the failed target was published. The
      // target has already been stopped by _recoverPublished in this path;
      // prove the recorded last-known-good release can start before falling
      // back to the immutable release pointer. This keeps a missing snapshot
      // from bricking the desktop while remaining fail-closed for any other
      // integrity error or an unstartable previous release.
      try {
        await this._stop(signal)
      } catch (stopError) {
        throw this._annotateRecoveryFailure(error, stopError)
      }
    }

    // A second desktop/reconciliation process can remove a completed snapshot
    // after the failed candidate has already been rolled back to the previous
    // pointer. In that narrow state, prove the previous release can still start
    // and pass observation before retiring the stale recovery journal. Never
    // use this path while the failed target remains active.
    // A missing snapshot is already a degraded recovery path. Re-check the
    // previous immutable manifest/profile/descriptor and prove that it boots,
    // but do not repeat the tens-of-thousands-file runtime hash pass before the
    // desktop can recover. Normal candidate activation still performs the full
    // inventory verification before it can publish a pointer.
    const previous = await this._resolvePointerRelease(pending.previousActive, signal, { verifyRuntime: false })
    this._progress('recover-previous-resolved', { operation: pending.operation, phase: pending.phase })
    await this._startAndObserve(previous, signal, { durationMs: this.recoveryObserveDuration })
    this._progress('recover-previous-ready', { operation: pending.operation, phase: pending.phase })
    this.stateStore.writeActive(pending.previousActive)
    this.stateStore.writeLastKnownGood(pending.previousActive)
    this.stateStore.clearPending()
    return {
      status: 'recovered',
      operation: pending.operation,
      phase: 'restoring',
      degraded: true,
      snapshotMissing: true,
    }
  }

  async _recoverPublished({ pending, signal }) {
    this._progress('recover-stop-start', { operation: pending.operation, phase: pending.phase })
    let stopError
    try {
      await this._stop(signal)
      this._progress('recover-stop-complete', { operation: pending.operation, phase: pending.phase })
      await this._fault('recovery:stop-target', { pending, signal })
    } catch (error) {
      stopError = error
    }

    let restoring
    try {
      restoring = this._updatePending(pending, { phase: 'restoring', targetActive: null })
      this._progress('recover-restoring-journaled', { operation: pending.operation, phase: restoring.phase })
      await this._fault('recovery:restoring', { pending: restoring, signal })
    } catch (error) {
      if (stopError !== undefined) throw new AggregateError([stopError, error], 'Unable to journal release restoration')
      throw error
    }
    if (stopError !== undefined) throw stopError

    const snapshotId = restoring.operation === 'rollback' ? restoring.rescueSnapshotId : restoring.snapshotId
    if (snapshotId === null || snapshotId === undefined) throw new ReleaseSwitcherError('Restoration has no durable snapshot')

    this._progress('recover-snapshot-start', { operation: restoring.operation, phase: restoring.phase })
    if (restoring.dataPolicy !== 'preserve') await this._restoreSnapshot(snapshotId, signal)
    this._progress('recover-snapshot-complete', { operation: restoring.operation, phase: restoring.phase })
    await this._fault('recovery:snapshot-restored', { pending: restoring, signal })

    if (restoring.previousActive === null) throw new ReleaseSwitcherError('Restoration has no previous active release')
    this.stateStore.writeActive(restoring.previousActive)
    this._progress('recover-active-restored', { operation: restoring.operation, phase: restoring.phase })
    await this._fault('recovery:active-old', { pending: restoring, signal })

    // Recovery runs before the normal workspace is shown. Revalidate the
    // immutable release metadata and prove the old pair by booting it, but do
    // not repeat the expensive runtime inventory hash pass here.
    this._progress('recover-previous-resolve-start', { operation: restoring.operation, phase: restoring.phase })
    const previous = await this._resolvePointerRelease(restoring.previousActive, signal, { verifyRuntime: false })
    this._progress('recover-previous-resolved', { operation: restoring.operation, phase: restoring.phase })
    await this._startAndObserve(previous, signal, { durationMs: this.recoveryObserveDuration })
    this._progress('recover-previous-ready', { operation: restoring.operation, phase: restoring.phase })
    await this._fault('recovery:old-observed', { pending: restoring, release: previous, signal })

    // Retire only the completed journal, never its audit/recovery snapshots.
    // Replaying this snapshot after the old release resumes would roll back
    // newly saved data. Any restore/start/observe or commit failure above/below
    // must leave the journal available for an explicit recovery retry.
    throwIfAborted(signal)
    this.stateStore.writeLastKnownGood(restoring.previousActive)
    this.stateStore.clearPending()
    return { pending: null }
  }

  _annotateRecoveryFailure(error, recoveryError) {
    const original = failureFrom(error, 'Release operation failed')
    if (original.recoveryError === undefined) original.recoveryError = recoveryError
    original.recoveryAttempted = true
    return original
  }
}

export function createReleaseSwitcher(options) {
  return new ReleaseSwitcher(options)
}

export default ReleaseSwitcher
