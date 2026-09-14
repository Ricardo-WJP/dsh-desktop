import { randomBytes, randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import process from 'node:process'
import { mkdir, mkdtemp, rename, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { HarnessServer } from '../harness-server.js'
import { createPreflightEnvironment } from './preflight-environment.js'

// Candidate profiles can perform first-load module compilation and plugin
// discovery before the Web Host prints its readiness URL. Keep this aligned
// with the desktop's normal Harness startup budget so a valid cold candidate
// is not rejected merely because the compatibility gate used a shorter clock.
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000
const DEFAULT_HTTP_TIMEOUT_MS = 10_000
const DEFAULT_TERMINAL_TIMEOUT_MS = 4_000
const DEFAULT_STABILITY_WINDOW_MS = 750
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Candidate runtime gate aborted')
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal)
}

function wait(ms, signal) {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    let timer
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      reject(abortReason(signal))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function unrefDelay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

const asarGuards = new WeakMap()
function disableElectronAsarFilesystem(runtime = process) {
  if (runtime?.versions?.electron === undefined) return () => {}
  let guard = asarGuards.get(runtime)
  if (!guard) {
    guard = { count: 0, hadOwnValue: Object.hasOwn(runtime, 'noAsar'), previousValue: runtime.noAsar }
    asarGuards.set(runtime, guard)
  }
  guard.count += 1
  runtime.noAsar = true
  let released = false
  return () => {
    if (released) return
    released = true
    guard.count -= 1
    if (guard.count !== 0) return
    asarGuards.delete(runtime)
    if (guard.hadOwnValue) runtime.noAsar = guard.previousValue
    else delete runtime.noAsar
  }
}

async function withElectronAsarFilesystemDisabled(operation, runtime = process) {
  const restore = disableElectronAsarFilesystem(runtime)
  try {
    return await operation()
  } finally {
    restore()
  }
}

export async function removeTemporaryHome(home, {
  onError = () => {},
  renameImpl = rename,
  removeImpl = rm,
  randomUUIDImpl = randomUUID,
  electronRuntime = process,
} = {}) {
  if (typeof home !== 'string' || home.length === 0 || home.includes('\0') || !isAbsolute(home)) {
    throw new TypeError('Candidate temporary home must be an absolute path')
  }
  const deferredHome = `${home}.pending-delete-${randomUUIDImpl()}`
  let cleanupHome = home
  try {
    // Renaming the exact temporary root is O(1) and lets the gate finish even
    // when a just-terminated helper still holds one file open. The deferred
    // tree remains outside the live mount path and is removed in the
    // background once Windows releases the handle.
    await withElectronAsarFilesystemDisabled(() => renameImpl(home, deferredHome), electronRuntime)
    cleanupHome = deferredHome
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'complete', deferred: false, path: home }
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error
  }

  const cleanupStatus = { status: 'pending', deferred: true, path: cleanupHome }
  const completion = (async () => {
    try {
      await withElectronAsarFilesystemDisabled(async () => {
        let lastError
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            await removeImpl(cleanupHome, { recursive: true, force: true, maxRetries: 1, retryDelay: 250 })
            cleanupStatus.status = 'complete'
            cleanupStatus.deferred = false
            return
          } catch (error) {
            lastError = error
            if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || attempt === 7) throw error
            await unrefDelay(750)
          }
        }
        throw lastError
      }, electronRuntime)
    } catch (error) {
      cleanupStatus.status = 'failed'
      cleanupStatus.error = error
      try { onError(error) } catch { /* cleanup diagnostics cannot affect the gate */ }
    }
  })()
  // The cleanup is intentionally allowed to finish after the gate returns, but
  // expose a non-serialized completion hook so callers/tests can distinguish a
  // real completion from the explicit pending state.
  Object.defineProperty(cleanupStatus, 'completion', { value: completion })
  void completion
  return cleanupStatus
}

function attachCleanupStatus(error, cleanupStatus) {
  try { error.cleanupStatus = cleanupStatus } catch { /* preserve the primary failure */ }
  return error
}

/*
 * Keep this helper's cleanup ownership local to the exact mount returned by
 * mountCandidateProfile. In particular, never broaden it to tmpdir() or a
 * historical pending-delete tree.
 */
function cleanupState(mount, server) {
  return {
    server: server === undefined
      ? { status: 'skipped', reason: 'not-started' }
      : { status: 'pending' },
    home: mount?.home === undefined
      ? { status: 'skipped', reason: 'not-mounted' }
      : { status: 'pending', path: mount.home },
  }
}

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  let timer
  const onAbort = () => controller.abort(abortReason(signal))
  if (signal?.aborted) onAbort()
  else signal?.addEventListener?.('abort', onAbort, { once: true })
  timer = setTimeout(() => controller.abort(new Error(`Candidate runtime probe timed out after ${timeoutMs} ms`)), timeoutMs)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    },
  }
}

async function probeHttp(origin, { fetchImpl = globalThis.fetch, signal, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Candidate runtime gate has no HTTP fetch implementation')
  const timeout = withTimeout(signal, timeoutMs)
  try {
    // The readiness line may include DSH's query token. Probe that exact URL;
    // never append a slash after the query string. Newer DSH releases use a
    // 3xx response to establish the browser session, which is a healthy Host
    // response only when the advertised URL carries its token.
    const advertisedUrl = new URL(origin)
    const response = await fetchImpl(advertisedUrl.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: timeout.signal,
    })
    const status = Number(response?.status)
    const tokenRedirect = advertisedUrl.searchParams.has('token') && status >= 300 && status < 400
    if (!response || (status !== 200 && !tokenRedirect)) {
      throw new Error(`Candidate Harness HTTP probe returned status ${String(response?.status ?? 'unknown')}`)
    }
    return { status, redirected: tokenRedirect }
  } finally {
    timeout.dispose()
  }
}

function terminalPath(origin) {
  const url = new URL(origin)
  const sessionId = `dsh-preflight-${randomUUID()}`
  const tab = 'compatibility'
  return {
    host: url.hostname,
    port: Number(url.port),
    path: `/sidebar/ws/terminal?sessionId=${encodeURIComponent(sessionId)}&tab=${encodeURIComponent(tab)}`,
  }
}

/**
 * Perform a harmless WebSocket upgrade against the terminal route. A missing
 * route is not itself a failure: older/newer plugins may not expose it. The
 * caller treats an unexpected Host exit during this probe as the failure.
 */
export function probeTerminalWebSocket(origin, { signal, timeoutMs = DEFAULT_TERMINAL_TIMEOUT_MS, connectImpl = createConnection } = {}) {
  const target = terminalPath(origin)
  const key = randomBytes(16).toString('base64')
  return new Promise((resolve, reject) => {
    let socket
    let settled = false
    let timer
    let buffer = ''
    const finish = (error, result) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      socket?.removeAllListeners?.()
      socket?.destroy?.()
      if (error !== undefined) reject(error)
      else resolve(result)
    }
    const onAbort = () => finish(abortReason(signal))
    const onData = chunk => {
      buffer = `${buffer}${String(chunk)}`.slice(-8_192)
      const boundary = buffer.indexOf('\r\n\r\n')
      if (boundary === -1) return
      const firstLine = buffer.slice(0, boundary).split(/\r?\n/u)[0] ?? ''
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/u.exec(firstLine)
      finish(undefined, { status: match === null ? undefined : Number(match[1]) })
    }
    const onClose = () => finish(undefined, { status: undefined })
    const onError = error => finish(undefined, { status: undefined, error: error?.message })
    timer = setTimeout(() => finish(undefined, { status: undefined, timedOut: true }), timeoutMs)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    try {
      socket = connectImpl({ host: target.host, port: target.port })
      socket.setEncoding?.('utf8')
      socket.once?.('connect', () => {
        socket.write?.([
          `GET ${target.path} HTTP/1.1`,
          `Host: ${target.host}:${String(target.port)}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'))
      })
      socket.on?.('data', onData)
      socket.once?.('close', onClose)
      socket.once?.('error', onError)
    } catch (error) {
      finish(undefined, { status: undefined, error: error?.message })
    }
  })
}

function validateRecipe(recipe) {
  if (recipe === null || typeof recipe !== 'object') throw new TypeError('Candidate runtime recipe is required')
  for (const key of ['entry', 'profilePath', 'profileHome', 'cwd']) {
    if (typeof recipe[key] !== 'string' || recipe[key].length === 0 || recipe[key].includes('\0') || !isAbsolute(recipe[key])) {
      throw new TypeError(`Candidate runtime recipe has an invalid ${key}`)
    }
  }
  if (typeof recipe.physicalProfileName !== 'string' || !PROFILE_NAME.test(recipe.physicalProfileName)) {
    throw new TypeError('Candidate runtime recipe has an invalid physical profile name')
  }
  if (recipe.patches !== undefined && (!Array.isArray(recipe.patches) || recipe.patches.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')))) {
    throw new TypeError('Candidate runtime recipe has invalid patch paths')
  }
  return recipe
}

function runtimeArgs(recipe) {
  if (recipe.runtimeArgs === undefined) return ['--expose-internals']
  if (!Array.isArray(recipe.runtimeArgs) || recipe.runtimeArgs.some(value => typeof value !== 'string' || value.includes('\0'))) {
    throw new TypeError('Candidate runtime recipe has invalid runtime arguments')
  }
  return [...recipe.runtimeArgs]
}

async function mountCandidateProfile(recipe, { root } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-candidate-gate-'))
  const profiles = join(home, 'profiles')
  const target = join(profiles, recipe.physicalProfileName)
  const materialized = join(recipe.profileHome, 'profiles', recipe.physicalProfileName)
  const candidateModules = join(recipe.profileHome, 'profiles', 'node_modules')
  const mountedModules = join(profiles, 'node_modules')
  let profileSource = recipe.profilePath
  try {
    try {
      if ((await stat(materialized)).isDirectory()) profileSource = materialized
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    // Keep setup sequential so cleanup cannot race another still-pending mkdir
    // or symlink after the first operation has failed.
    await mkdir(profiles, { recursive: true })
    await mkdir(candidateModules, { recursive: true })
    // The DSH launcher resolves $DSH_HOME/profiles/<physicalName>. Prefer the
    // candidate's materialized profile so its sibling profiles/node_modules
    // remains available to Node resolution; fall back to candidate/profile for
    // lightweight fixtures and older candidates. DSH regenerates its installation
    // dependency fallback under $DSH_HOME/profiles/node_modules. Mount that derived
    // directory back into the candidate as well: plugins are imported from their
    // real candidate path, so Node's parent walk must reach the candidate-owned
    // fallback rather than a throwaway sibling in the temporary gate home.
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(profileSource, target, linkType)
    await symlink(candidateModules, mountedModules, linkType)
    return { home, profiles, target, mountedModules, candidateModules, root, profileSource }
  } catch (error) {
    try {
      await rm(home, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Candidate runtime mount failed and its temporary home could not be removed', { cause: error })
    }
    throw error
  }
}

function runtimeFailure(message, details, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = 'CANDIDATE_RUNTIME_GATE_FAILED'
  error.details = details
  return error
}

/**
 * Boot and smoke-test one immutable candidate without changing the active
 * release pointer. This is deliberately desktop-owned: plugin packages are
 * never patched or rewritten to make the check pass.
 */
export async function runCandidateRuntimeGate({
  recipe,
  candidateId,
  signal,
  env = process.env,
  execPath = process.execPath,
  onOutput = () => {},
  fetchImpl = globalThis.fetch,
  probeTerminalImpl = probeTerminalWebSocket,
  serverFactory = options => new HarnessServer(options),
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  terminalTimeoutMs = DEFAULT_TERMINAL_TIMEOUT_MS,
  stabilityWindowMs = DEFAULT_STABILITY_WINDOW_MS,
} = {}) {
  validateRecipe(recipe)
  if (typeof candidateId !== 'string' || candidateId.length === 0) throw new TypeError('Candidate runtime gate requires candidateId')
  if (typeof serverFactory !== 'function') throw new TypeError('Invalid candidate runtime server factory')
  if (typeof probeTerminalImpl !== 'function') throw new TypeError('Invalid candidate terminal probe')

  let mount
  let server
  let exitEvent
  let exited
  let result
  let failure
  const exitPromise = new Promise(resolve => { exited = resolve })
  const startedAt = Date.now()
  try {
    mount = await mountCandidateProfile(recipe)
    throwIfAborted(signal)
    const isolated = createPreflightEnvironment({ env, home: mount.home })
    for (const directory of isolated.directories) await mkdir(directory, { recursive: true })
    server = serverFactory({
      command: execPath,
      args: [...runtimeArgs(recipe), recipe.entry, '--profile', recipe.physicalProfileName, ...(recipe.patches ?? []).flatMap(path => ['--patch', path]), '--port', '0', '--no-open'],
      cwd: isolated.env.HOME,
      env: {
        ...isolated.env,
        // Profile mounts remain at this disposable root; all other user,
        // Doctor, memory, config and cache homes stay inside its envelope.
        DSH_HOME: mount.home,
      },
      startupTimeoutMs,
      // A disposable preflight Host has no state to flush. Terminating its
      // exact Windows tree in one forced request avoids the graceful-taskkill
      // race where the root exits between /t and the required /t /f cleanup,
      // while retaining the existing PID-identity and fail-closed guarantees.
      forceWindowsTreeTermination: true,
      onOutput,
    })
    if (typeof server?.on !== 'function' || typeof server?.start !== 'function' || typeof server?.stop !== 'function') {
      throw new TypeError('Candidate runtime server is not controllable')
    }
    server.once('exit', event => {
      exitEvent = event
      exited(exitEvent)
    })
    const origin = await server.start()
    throwIfAborted(signal)
    const http = await probeHttp(origin, { fetchImpl, signal })
    throwIfAborted(signal)
    const terminal = await probeTerminalImpl(origin, { signal, timeoutMs: terminalTimeoutMs })
    await Promise.race([exitPromise, wait(stabilityWindowMs, signal)])
    if (exitEvent !== undefined) {
      throw runtimeFailure(
        `Candidate ${candidateId} exited during runtime preflight (code: ${String(exitEvent.code)}, signal: ${String(exitEvent.signal)}).`,
        { candidateId, origin, httpStatus: http.status, terminal, exit: exitEvent },
      )
    }
    result = {
      ok: true,
      gate: 'candidate-runtime-smoke-v1',
      candidateId,
      origin,
      httpStatus: http.status,
      terminalProbe: terminal?.status === 101 ? 'upgraded' : 'host-stable',
      isolation: 'environment-and-working-directory',
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    failure = error?.code === 'CANDIDATE_RUNTIME_GATE_FAILED'
      ? error
      : runtimeFailure(`Candidate ${candidateId} failed runtime preflight: ${error?.message ?? String(error)}`, { candidateId, exit: exitEvent }, error)
  }

  const cleanupErrors = []
  const cleanupStatus = cleanupState(mount, server)
  let serverStopFailed = false
  if (server !== undefined) {
    if (typeof server.stop !== 'function') {
      serverStopFailed = true
      cleanupErrors.push(runtimeFailure(`Candidate ${candidateId} has no preflight stop method`, { candidateId }))
      cleanupStatus.server = { status: 'failed', reason: 'stop-unavailable' }
      if (mount?.home !== undefined) {
        cleanupStatus.home = { status: 'pending', path: mount.home, reason: 'server-stop-unavailable' }
      }
    } else {
      try {
        await server.stop(new Error('Candidate runtime preflight complete'))
        cleanupStatus.server = { status: 'complete' }
      } catch (error) {
        serverStopFailed = true
        cleanupStatus.server = { status: 'failed', error }
        if (mount?.home !== undefined) {
          cleanupStatus.home = { status: 'pending', path: mount.home, reason: 'server-stop-failed' }
        }
        cleanupErrors.push(runtimeFailure(
          `Candidate ${candidateId} could not stop its preflight server: ${error?.message ?? String(error)}`,
          { candidateId, home: mount?.home, cleanupStatus },
          error,
        ))
      }
    }
  }
  if (mount?.home !== undefined && !serverStopFailed) {
    try {
      cleanupStatus.home = await removeTemporaryHome(mount.home, {
        onError: error => onOutput('stderr', `[candidate-runtime] deferred preflight cleanup failed: ${error?.message ?? String(error)}\n`),
      })
    } catch (error) {
      cleanupStatus.home = { status: 'failed', path: mount.home, error }
      cleanupErrors.push(runtimeFailure(
        `Candidate ${candidateId} could not remove its preflight home: ${error?.message ?? String(error)}`,
        { candidateId, home: mount.home, cleanupStatus },
        error,
      ))
    }
  }

  if (failure !== undefined) {
    attachCleanupStatus(failure, cleanupStatus)
    if (cleanupErrors.length > 0) {
      failure.cleanupError = cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, `Candidate ${candidateId} preflight cleanup failed`)
    }
    throw failure
  }
  if (cleanupErrors.length === 1) throw attachCleanupStatus(cleanupErrors[0], cleanupStatus)
  if (cleanupErrors.length > 1) {
    throw attachCleanupStatus(runtimeFailure(
      `Candidate ${candidateId} could not be cleaned up after preflight.`,
      { candidateId, cleanupStatus },
      new AggregateError(cleanupErrors, `Candidate ${candidateId} preflight cleanup failed`),
    ), cleanupStatus)
  }
  result.cleanupStatus = cleanupStatus
  return result
}
