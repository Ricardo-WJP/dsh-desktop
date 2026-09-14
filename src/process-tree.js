import { spawn as nodeSpawn } from 'node:child_process'
import process from 'node:process'
import { win32 } from 'node:path'

function childHasExited(child) {
  return (child?.exitCode !== null && child?.exitCode !== undefined)
    || (child?.signalCode !== null && child?.signalCode !== undefined)
}

function childIdentityIsLive(child) {
  // Node's ChildProcess uses null for both fields until the root exits. Keep
  // this check deliberately strict: an undefined or already-populated field
  // is not a proof that the captured identity is still safe to target.
  return child?.exitCode === null && child?.signalCode === null
}

function absoluteWindowsPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\0')
    && win32.isAbsolute(value)
}

/**
 * Resolve taskkill from the constructor-time trusted SystemRoot snapshot.
 * `taskkillPath` is intentionally an explicit absolute-path seam for tests;
 * production callers should let the trusted process environment provide it.
 */
export function resolveTrustedTaskkillPath(taskkillPath) {
  if (taskkillPath !== undefined) return absoluteWindowsPath(taskkillPath) ? taskkillPath : undefined
  const systemRoot = process.env.SystemRoot
  if (!absoluteWindowsPath(systemRoot)) return undefined
  return win32.join(systemRoot, 'System32', 'taskkill.exe')
}

function cleanupError(message, code, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = code
  return error
}

function identityLostError(pid) {
  return cleanupError(
    `Owned Windows process cleanup identity lost; refusing taskkill PID ${String(pid ?? 'unknown')}`,
    'PROCESS_CLEANUP_IDENTITY_LOST',
  )
}

function cleanupIncompleteError(message, cause) {
  return cleanupError(message, 'PROCESS_TREE_CLEANUP_INCOMPLETE', cause)
}

export const ROOT_EXITED_DESCENDANTS_UNVERIFIED = 'root-exited/descendants-unverified'
const DESCENDANTS_UNVERIFIED_CODE = 'PROCESS_TREE_DESCENDANTS_UNVERIFIED'
const COMPLETION_CONTRACT_REQUIRED_CODE = 'PROCESS_TREE_COMPLETION_CONTRACT_REQUIRED'

export function descendantsUnverifiedError(pid, cause) {
  const error = cleanupError(
    `Owned process root exited, but descendants are unverified for PID ${String(pid ?? 'unknown')}`,
    DESCENDANTS_UNVERIFIED_CODE,
    cause,
  )
  error.cleanupState = ROOT_EXITED_DESCENDANTS_UNVERIFIED
  return error
}

function hasCompletionContract(value) {
  const contract = value?.completionContract ?? value
  if (contract === null || typeof contract !== 'object') return false
  const oneShot = contract.oneShot === true || contract.oneShotCommand === true
  const descendantsVerified = contract.descendants === 'none'
    || contract.descendants === 'verified'
    || contract.noDescendants === true
    || contract.descendantsVerified === true
  return oneShot && descendantsVerified
}

function completionContractError() {
  return cleanupError(
    'Owned process completion requires an explicit one-shot contract with no descendants',
    COMPLETION_CONTRACT_REQUIRED_CODE,
  )
}

function ownerIdentityIsLive(owner) {
  return owner.rootExited === false && childIdentityIsLive(owner.child)
}

function exactPid(child) {
  return Number.isSafeInteger(child?.pid) && child.pid > 0 ? child.pid : undefined
}

function abortError(signal, fallback = 'Owned process wait aborted') {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback)
}

function removeListener(child, event, listener) {
  child?.removeListener?.(event, listener)
}

/**
 * Await one owned root. The timeout is deliberately a bounded wait rather
 * than a polling loop: descendants are owned by the process group/tree, not by
 * a process enumeration performed by the desktop.
 */
export function waitForChild(child, { timeoutMs = 0, signal, waitForClose = false } = {}) {
  if (child === undefined || child === null || typeof child.once !== 'function') {
    return Promise.reject(new TypeError('Invalid child process'))
  }
  if (signal?.aborted) return Promise.reject(abortError(signal))
  // The default remains exit semantics for bounded cleanup and legacy callers.
  // A close wait must attach before observing an already-populated exit code so
  // callers can still receive the final stdio drain event.
  if (!waitForClose && childHasExited(child)) {
    return Promise.resolve({ code: child.exitCode ?? null, signal: child.signalCode ?? null })
  }

  return new Promise((resolve, reject) => {
    let timer
    let settled = false
    const cleanup = () => {
      removeListener(child, 'error', onError)
      removeListener(child, 'exit', onExit)
      removeListener(child, 'close', onClose)
      signal?.removeEventListener?.('abort', onAbort)
      if (timer !== undefined) clearTimeout(timer)
    }
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      callback(value)
    }
    const onError = error => finish(reject, error)
    const onExit = (code, signalValue) => {
      if (!waitForClose) finish(resolve, { code: code ?? null, signal: signalValue ?? null })
    }
    const onClose = (code, signalValue) => finish(resolve, { code: code ?? null, signal: signalValue ?? null })
    const onAbort = () => finish(reject, abortError(signal))

    child.once('error', onError)
    child.once('exit', onExit)
    child.once('close', onClose)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => finish(resolve, undefined), timeoutMs)
    }
    if (!waitForClose && childHasExited(child)) onExit(child.exitCode, child.signalCode)
  })
}

/** Await ChildProcess.close while preserving the same result shape. */
export function waitForChildClose(child, options = {}) {
  return waitForChild(child, { ...options, waitForClose: true })
}

function waitForDelay(delayMs, signal) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(abortError(signal, 'Owned process delay aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      reject(abortError(signal, 'Owned process delay aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

export function createSpawnOptions({ cwd, env = process.env, stdio = 'inherit', windowsHide = true } = {}) {
  return Object.freeze({ cwd, env, stdio, windowsHide, shell: false })
}

/** Spawn a direct executable with shell execution explicitly disabled. */
export function spawnDirect(command, args, options = {}, spawnImpl = nodeSpawn) {
  if (typeof command !== 'string' || command.length === 0) throw new TypeError('Invalid process command')
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) throw new TypeError('Invalid process arguments')
  if (typeof spawnImpl !== 'function') throw new TypeError('Invalid process spawner')
  return spawnImpl(command, args, { ...options, shell: false })
}

export function buildWindowsProcessTreeTermination(pid, force = true, taskkillPath = resolveTrustedTaskkillPath()) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError('Invalid owned process id')
  if (!absoluteWindowsPath(taskkillPath)) throw new TypeError('Trusted absolute taskkill.exe path is unavailable')
  return Object.freeze({
    command: taskkillPath,
    args: Object.freeze(['/pid', String(pid), '/t', ...(force ? ['/f'] : [])]),
  })
}

// Name kept explicit for callers that describe the operation as a tree kill.
export const buildWindowsTreeTermination = buildWindowsProcessTreeTermination

function requestChildStop(child, signal) {
  if (childHasExited(child)) return false
  if (typeof child.kill !== 'function') return false
  try {
    return child.kill(signal)
  } catch {
    return false
  }
}

function requestPosixTreeStop(owner, signal) {
  const { child, pid, signalImpl, processKill } = owner
  if (typeof signalImpl === 'function') {
    try {
      signalImpl(child, signal)
      return true
    } catch {
      // Keep the exact group fallback available to test adapters and hosts
      // that cannot service a custom signal hook.
    }
  }
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      processKill(-pid, signal)
      return true
    } catch {
      // The root can exit between the state check and group signal.
    }
  }
  return requestChildStop(child, signal)
}

async function waitForTermination(child, timeoutMs) {
  try {
    return await waitForChild(child, { timeoutMs })
  } catch {
    return undefined
  }
}

async function requestWindowsTreeTermination(owner, force) {
  const { child, pid, taskkillPath, spawnImpl, cwd, env, windowsHide, terminationTimeoutMs } = owner
  if (!ownerIdentityIsLive(owner)) throw identityLostError(pid)
  if (!Number.isSafeInteger(pid) || pid < 1) throw identityLostError(pid)
  if (!absoluteWindowsPath(taskkillPath)) {
    throw cleanupIncompleteError('Trusted absolute taskkill.exe path is unavailable; refusing cleanup')
  }
  const termination = buildWindowsProcessTreeTermination(pid, force, taskkillPath)
  // Recheck immediately before the side effect. A root exit between the first
  // check and this call makes numeric PID targeting unsafe.
  if (!ownerIdentityIsLive(owner)) throw identityLostError(pid)
  let killer
  try {
    killer = spawnDirect(
      termination.command,
      termination.args,
      createSpawnOptions({ cwd, env, stdio: 'ignore', windowsHide: windowsHide ?? true }),
      spawnImpl,
    )
  } catch (error) {
    throw cleanupIncompleteError(`Unable to invoke ${termination.command}`, error)
  }

  const result = await waitForTermination(killer, terminationTimeoutMs)
  if (result === undefined && !childHasExited(killer)) {
    requestChildStop(killer, 'SIGKILL')
    await waitForTermination(killer, terminationTimeoutMs)
    throw cleanupIncompleteError(`taskkill did not exit for owned PID ${String(pid)}`)
  }
  if (result === undefined) throw cleanupIncompleteError(`taskkill failed for owned PID ${String(pid)}`)
  if (result.code !== 0 || result.signal !== null) {
    // Windows taskkill can return 128 when the exact root exits after the
    // verified /t /f request was spawned but before taskkill finishes opening
    // that PID. Accept only that narrow forced-cleanup race, and only after the
    // captured ChildProcess itself has reported exit. Every other non-zero
    // result remains fail-closed, including 128 while the root is still live.
    if (force && result.code === 128 && result.signal === null) {
      const exited = await waitForTermination(child, terminationTimeoutMs)
      if (exited !== undefined || !ownerIdentityIsLive(owner)) {
        return { ...result, racedOwnedExit: true }
      }
    }
    throw cleanupIncompleteError(
      `taskkill failed for owned PID ${String(pid)} with code ${String(result.code)} and signal ${String(result.signal)}`,
    )
  }
  return result
}

/**
 * Create the sole exact-owned process-tree cleanup owner. The root PID is
 * captured once at spawn time and is never read again after exit/close. On
 * Windows cleanup targets that exact live ChildProcess identity with the
 * constructor-captured absolute SystemRoot\System32\taskkill.exe path; a root
 * exit makes cleanup identity-lost and fail-closed. `detached: false` is kept
 * as a spawn policy, but is not treated as evidence that descendants are
 * contained. On POSIX cleanup targets that exact detached process group with a
 * negative PID.
 */
export function createOwnedProcessTree({
  child,
  platform = process.platform,
  processKill = process.kill.bind(process),
  signalImpl,
  spawnImpl = nodeSpawn,
  cwd,
  env = process.env,
  windowsHide = true,
  forceWindowsTreeTermination = false,
  terminationTimeoutMs = 5_000,
  taskkillPath,
} = {}) {
  if (child === undefined || child === null || typeof child.once !== 'function') throw new TypeError('Invalid owned child')
  if (typeof platform !== 'string') throw new TypeError('Invalid process platform')
  if (typeof processKill !== 'function') throw new TypeError('Invalid process killer')
  if (typeof spawnImpl !== 'function') throw new TypeError('Invalid process spawner')
  if (typeof forceWindowsTreeTermination !== 'boolean') throw new TypeError('Invalid Windows process-tree termination policy')
  if (!Number.isFinite(terminationTimeoutMs) || terminationTimeoutMs < 0) throw new TypeError('Invalid process termination timeout')
  const resolvedTaskkillPath = platform === 'win32' ? resolveTrustedTaskkillPath(taskkillPath) : undefined
  if (platform === 'win32' && resolvedTaskkillPath === undefined) {
    throw new TypeError('Trusted absolute taskkill.exe path is unavailable')
  }

  // A cleanup owner must always have a finite wait. Treat an explicit zero as
  // the smallest deterministic grace window instead of inheriting waitForChild
  // public "no timeout" convention.
  const boundedTerminationTimeoutMs = Math.max(1, terminationTimeoutMs)
  const capturedEnv = env !== null && typeof env === 'object' ? Object.freeze({ ...env }) : env
  const owner = {
    child,
    pid: exactPid(child),
    platform,
    processKill,
    signalImpl,
    spawnImpl,
    cwd,
    env: capturedEnv,
    windowsHide,
    forceWindowsTreeTermination,
    taskkillPath: resolvedTaskkillPath,
    terminationTimeoutMs: boundedTerminationTimeoutMs,
    rootExited: childHasExited(child),
    cleanupState: childHasExited(child) ? ROOT_EXITED_DESCENDANTS_UNVERIFIED : 'pending',
    descendantsVerified: false,
    cleanupError: undefined,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    cleanupPromise: undefined,
    released: false,
    stopping: false,
    onExit: undefined,
    onClose: undefined,
    onError: undefined,
  }
  const syncRootExitFromChild = () => {
    if (!owner.rootExited && childHasExited(child)) {
      owner.rootExited = true
      owner.exitCode = child.exitCode ?? null
      owner.signalCode = child.signalCode ?? null
      if (owner.cleanupState !== 'complete') owner.cleanupState = ROOT_EXITED_DESCENDANTS_UNVERIFIED
    }
  }
  const abortController = new AbortController()
  owner.signal = abortController.signal

  owner.onExit = (code, signal) => {
    owner.rootExited = true
    owner.exitCode = code ?? null
    owner.signalCode = signal ?? null
    if (owner.cleanupState !== 'complete') owner.cleanupState = ROOT_EXITED_DESCENDANTS_UNVERIFIED
  }
  owner.onClose = (code, signal) => {
    owner.rootExited = true
    owner.exitCode ??= code ?? null
    owner.signalCode ??= signal ?? null
    if (owner.cleanupState !== 'complete') owner.cleanupState = ROOT_EXITED_DESCENDANTS_UNVERIFIED
  }
  owner.onError = () => {
    // Keep ownership through a spawn error. Some ChildProcess instances emit
    // error before close and can still leave descendants behind.
  }
  child.once('exit', owner.onExit)
  child.once('close', owner.onClose)
  child.once('error', owner.onError)

  const release = () => {
    owner.released = true
    removeListener(child, 'exit', owner.onExit)
    removeListener(child, 'close', owner.onClose)
    removeListener(child, 'error', owner.onError)
  }

  async function cleanupWindows() {
    // A root that exited before cleanup no longer proves ownership of its
    // numeric PID. Never issue taskkill against that PID; there is no process
    // enumeration fallback and the owner is deliberately fail-closed.
    syncRootExitFromChild()
    if (!ownerIdentityIsLive(owner)) throw identityLostError(owner.pid)

    let failure
    let forcedTreeTerminationSucceeded = false
    let rootOnlyFallbackRequested = false
    try {
      await requestWindowsTreeTermination(owner, owner.forceWindowsTreeTermination)
      forcedTreeTerminationSucceeded = owner.forceWindowsTreeTermination
    } catch (error) {
      failure = error
    }

    if (ownerIdentityIsLive(owner)) {
      const exited = await waitForTermination(child, owner.terminationTimeoutMs)
      if (exited === undefined && ownerIdentityIsLive(owner)) {
        try {
          await requestWindowsTreeTermination(owner, true)
          forcedTreeTerminationSucceeded = true
        } catch (error) {
          failure ??= error
        }
      }
    }

    if (ownerIdentityIsLive(owner)) {
      await waitForTermination(child, owner.terminationTimeoutMs)
      // Root-only termination is strictly best effort. It can stop this exact
      // ChildProcess, but it cannot prove descendant cleanup, so any such
      // fallback remains an incomplete cleanup and is reported as failure.
      if (ownerIdentityIsLive(owner)) {
        rootOnlyFallbackRequested = true
        // A root-only kill can prove only that this captured root exited; it
        // never proves descendant cleanup. Preserve an incomplete-tree failure
        // even when the fallback happens to make the root exit immediately.
        failure ??= cleanupIncompleteError(`Owned process tree cleanup fell back to root-only SIGKILL for PID ${String(owner.pid)}`)
        requestChildStop(child, 'SIGKILL')
        await waitForTermination(child, owner.terminationTimeoutMs)
        if (ownerIdentityIsLive(owner)) {
          failure ??= cleanupIncompleteError(`Owned process tree remains live after taskkill for PID ${String(owner.pid)}`)
        }
      }
    }

    // Some real Windows console trees report a nonzero result for the
    // graceful /t request because a descendant can only be terminated with
    // /f. A successful forced tree request followed by root exit is the
    // authoritative cleanup path; keep failures when force did not succeed or
    // when we had to fall back to root-only termination.
    if (failure !== undefined && forcedTreeTerminationSucceeded && !rootOnlyFallbackRequested && !ownerIdentityIsLive(owner)) {
      failure = undefined
    }
    if (failure !== undefined) throw failure
  }

  async function cleanup() {
    if (owner.platform === 'win32') {
      await cleanupWindows()
      owner.descendantsVerified = true
      owner.cleanupState = 'complete'
      return undefined
    }
    if (owner.pid === undefined) {
      // A deterministic fake may not provide a PID. Real spawned roots always
      // do; without an identity there is no safe descendant operation to send.
      owner.cleanupState = 'incomplete'
      release()
      throw cleanupIncompleteError('Owned process cleanup has no captured root identity')
    }

    const exitedBeforeCleanup = owner.rootExited || childHasExited(child)
    const gracefulRequested = requestPosixTreeStop(owner, 'SIGTERM')
    if (!exitedBeforeCleanup) {
      if (!gracefulRequested) requestChildStop(child, 'SIGTERM')
      const exited = await waitForTermination(child, owner.terminationTimeoutMs)
      // Preserve the existing graceful path when the live root exits in
      // response to the graceful group signal. A pre-existing root exit takes
      // the explicit tree grace path above instead.
      if (exited !== undefined || owner.rootExited || childHasExited(child)) {
        owner.descendantsVerified = true
        owner.cleanupState = 'complete'
        return undefined
      }
    } else {
      await waitForDelay(owner.terminationTimeoutMs)
    }

    const forcedRequested = requestPosixTreeStop(owner, 'SIGKILL')
    if (!forcedRequested) requestChildStop(child, 'SIGKILL')
    if (!exitedBeforeCleanup) await waitForTermination(child, owner.terminationTimeoutMs)
    owner.descendantsVerified = true
    owner.cleanupState = 'complete'
    return undefined
  }

  function releaseCompleted(completionContract) {
    syncRootExitFromChild()
    if (!hasCompletionContract(completionContract)) throw completionContractError()
    if (!owner.rootExited || owner.exitCode !== 0 || owner.signalCode !== null) {
      throw new Error('Cannot release an incomplete owned root')
    }
    owner.descendantsVerified = true
    owner.cleanupState = 'complete'
    owner.cleanupPromise = Promise.resolve()
    release()
  }

  function releaseExited(completionContract) {
    if (!hasCompletionContract(completionContract)) return false
    syncRootExitFromChild()
    if (!owner.rootExited && !childHasExited(child)) return false
    owner.descendantsVerified = true
    owner.cleanupState = 'complete'
    owner.cleanupPromise = Promise.resolve()
    release()
    return true
  }

  /**
   * Release a root that has already crashed after readiness. Its numeric PID
   * is no longer safe to pass to taskkill, so the desktop must not turn that
   * post-crash state into a PID cleanup attempt. The root was spawned
   * non-detached by policy, but that does not verify descendant containment;
   * descendants are not guessed or scanned here. Generic supervisors retain
   * their fail-closed stop behavior and can keep an owner when stronger
   * cleanup is required.
   */
  function releaseAfterUnexpectedExit(completionContract) {
    syncRootExitFromChild()
    if (!owner.rootExited && !childHasExited(child)) return false
    if (owner.cleanupState === 'complete') {
      release()
      return true
    }
    if (hasCompletionContract(completionContract)) return releaseExited(completionContract)
    owner.descendantsVerified = false
    owner.cleanupState = ROOT_EXITED_DESCENDANTS_UNVERIFIED
    release()
    return true
  }

  function unverifiedStop(reason) {
    const error = owner.cleanupError ?? descendantsUnverifiedError(owner.pid, reason)
    owner.cleanupError = error
    owner.cleanupState = ROOT_EXITED_DESCENDANTS_UNVERIFIED
    owner.stopping = true
    owner.cleanupPromise = Promise.reject(error)
    // The rejected promise is returned to the caller, but this branch can be
    // reached from a fire-and-forget auto-cleanup. Attach a handler so the
    // safety result itself does not become an unhandled rejection.
    owner.cleanupPromise.catch(() => {})
    return owner.cleanupPromise
  }

  function stop(reason = new Error('Owned process tree stopped')) {
    if (owner.cleanupPromise !== undefined) return owner.cleanupPromise
    if (owner.released && owner.cleanupState !== 'complete') return unverifiedStop(reason)
    owner.stopping = true
    if (!abortController.signal.aborted) abortController.abort(reason)
    owner.cleanupPromise = Promise.resolve().then(cleanup).catch(error => {
      owner.cleanupError = error
      owner.cleanupState = error?.code === 'PROCESS_CLEANUP_IDENTITY_LOST'
        ? ROOT_EXITED_DESCENDANTS_UNVERIFIED
        : 'incomplete'
      throw error
    }).finally(release)
    return owner.cleanupPromise
  }

  return Object.freeze({
    child,
    pid: owner.pid,
    get rootExited() { return owner.rootExited },
    get stopping() { return owner.stopping },
    get cleanupState() { return owner.cleanupState },
    get descendantsVerified() { return owner.descendantsVerified },
    get cleanupError() { return owner.cleanupError },
    taskkillPath: owner.taskkillPath,
    signal: owner.signal,
    releaseCompleted,
    releaseExited,
    releaseAfterUnexpectedExit,
    stop,
    cleanup: stop,
    wait: options => waitForChild(child, options),
    waitForClose: options => waitForChildClose(child, options),
  })
}

export const createProcessTreeOwner = createOwnedProcessTree

/** Spawn one root and immediately capture its exact process identity. */
export function spawnOwnedProcess(command, args, {
  spawnImpl = nodeSpawn,
  processKill = process.kill.bind(process),
  signalImpl,
  platform = process.platform,
  terminationTimeoutMs = 5_000,
  cwd,
  env = process.env,
  windowsHide = true,
  forceWindowsTreeTermination = false,
  stdio,
  signal,
  taskkillPath,
} = {}) {
  const resolvedTaskkillPath = platform === 'win32' ? resolveTrustedTaskkillPath(taskkillPath) : undefined
  if (platform === 'win32' && resolvedTaskkillPath === undefined) {
    throw new TypeError('Trusted absolute taskkill.exe path is unavailable')
  }
  const capturedEnv = env !== null && typeof env === 'object' ? Object.freeze({ ...env }) : env
  // Keep the spawn surface explicit. Unknown options, including shell and
  // detached overrides, are intentionally ignored; ownership policy wins.
  const ownedOptions = {
    cwd,
    env: capturedEnv,
    windowsHide,
    ...(stdio === undefined ? {} : { stdio }),
    ...(signal === undefined ? {} : { signal }),
    // Win32 roots stay non-detached by policy. That setting is not containment
    // evidence; if a root identity is lost, descendants are intentionally not
    // guessed or scanned.
    detached: platform !== 'win32',
    shell: false,
  }
  const child = spawnDirect(command, args, ownedOptions, spawnImpl)
  const owner = createOwnedProcessTree({
    child,
    platform,
    processKill,
    signalImpl,
    spawnImpl,
    cwd,
    env: capturedEnv,
    windowsHide,
    forceWindowsTreeTermination,
    terminationTimeoutMs,
    taskkillPath: resolvedTaskkillPath,
  })
  return Object.freeze({ child, owner })
}

/**
 * Own and clean a set of roots. Each root has an independent captured PID,
 * while stopAll provides one idempotent bounded drain for callers.
 */
export function createProcessTreeSupervisor({
  spawnImpl = nodeSpawn,
  processKill = process.kill.bind(process),
  platform = process.platform,
  cwd,
  env = process.env,
  windowsHide = true,
  terminationTimeoutMs = 5_000,
  taskkillPath,
} = {}) {
  if (typeof spawnImpl !== 'function') throw new TypeError('Invalid process spawner')
  if (typeof processKill !== 'function') throw new TypeError('Invalid process killer')
  if (typeof platform !== 'string') throw new TypeError('Invalid process platform')
  const resolvedTaskkillPath = platform === 'win32' ? resolveTrustedTaskkillPath(taskkillPath) : undefined
  if (platform === 'win32' && resolvedTaskkillPath === undefined) {
    throw new TypeError('Trusted absolute taskkill.exe path is unavailable')
  }
  const owners = new Set()
  const abortController = new AbortController()
  const abortListeners = new Map()
  let stopping = false
  let cleanupPromise
  const abortFailures = []

  function detachAbortListener(owner) {
    const entry = abortListeners.get(owner)
    if (entry === undefined) return
    abortListeners.delete(owner)
    entry.signal?.removeEventListener?.('abort', entry.listener)
  }

  function releaseOwner(owner) {
    detachAbortListener(owner)
    owners.delete(owner)
  }

  function track(child, signal) {
    const owner = createOwnedProcessTree({
      child,
      platform,
      processKill,
      spawnImpl,
      cwd,
      env,
      windowsHide,
      terminationTimeoutMs,
      taskkillPath: resolvedTaskkillPath,
    })
    owners.add(owner)
    if (signal?.addEventListener) {
      const listener = () => {
        // The ChildProcess signal option may terminate only the root. The
        // captured owner must still drain its exact process tree/group.
        void Promise.resolve(owner.stop(abortError(signal, 'Owned child process aborted')))
          .catch(error => { abortFailures.push(error) })
          .finally(() => releaseOwner(owner))
      }
      abortListeners.set(owner, { signal, listener })
      signal.addEventListener('abort', listener, { once: true })
      // An injected spawner or signal adapter may abort during registration;
      // the post-attach check closes that race and always drains this exact
      // captured owner rather than leaving a just-spawned root live.
      if (signal.aborted) queueMicrotask(listener)
    }
    return child
  }

  function spawn(command, args, options = {}) {
    if (stopping) throw new Error('Child supervisor is stopping')
    const safeOptions = options !== null && typeof options === 'object' ? options : {}
    const child = spawnDirect(command, args, {
      cwd: safeOptions.cwd ?? cwd,
      env: safeOptions.env ?? env,
      windowsHide,
      ...(safeOptions.stdio === undefined ? {} : { stdio: safeOptions.stdio }),
      ...(safeOptions.signal === undefined ? {} : { signal: safeOptions.signal }),
      detached: platform !== 'win32',
      shell: false,
    }, spawnImpl)
    return track(child, safeOptions.signal)
  }

  /**
   * Release one exact root whose command completed successfully. This is not
   * cleanup: callers must only use it for a command whose own contract proves
   * descendants are complete (for example a finished build step). A live or
   * non-success root is never released, and normal stopAll remains fail-closed
   * when a root exits before its cleanup identity can be checked.
   */
  function releaseCompletedRoot(child, completionContract) {
    const owner = [...owners].find(candidate => candidate.child === child)
    if (owner === undefined) return false
    if (!hasCompletionContract(completionContract)) return false
    owner.releaseCompleted(completionContract)
    releaseOwner(owner)
    return true
  }

  /**
   * Release one exact root after ChildProcess.close proved that it has already
   * exited. This is used by one-shot commands that return a nonzero status.
   * At that point Windows cannot safely address the captured numeric PID (it
   * may already have been reused), so retaining the owner only turns the real
   * command error into a misleading identity-lost cleanup failure.
   */
  function releaseExitedRoot(child, completionContract) {
    const owner = [...owners].find(candidate => candidate.child === child)
    if (owner === undefined || !owner.releaseExited(completionContract)) return false
    releaseOwner(owner)
    return true
  }

  /**
   * Release only the local owner after close/exit when no descendant contract
   * exists. This deliberately returns a structured non-complete result so a
   * command can report its own root outcome without turning unknown descendants
   * into a cleanup failure or claiming that the tree was drained.
   */
  function releaseExitedRootUnverified(child) {
    const owner = [...owners].find(candidate => candidate.child === child)
    if (owner === undefined || !owner.releaseAfterUnexpectedExit()) return false
    const result = Object.freeze({
      released: true,
      complete: owner.cleanupState === 'complete' && owner.descendantsVerified === true,
      cleanupState: owner.cleanupState,
      descendantsVerified: owner.descendantsVerified,
    })
    releaseOwner(owner)
    return result
  }

  async function stopAll(reason = new Error('Child supervisor stopped')) {
    if (cleanupPromise !== undefined) return cleanupPromise
    stopping = true
    if (!abortController.signal.aborted) abortController.abort(reason)
    const owned = [...owners]
    cleanupPromise = Promise.allSettled(owned.map(owner => Promise.resolve(owner.stop(reason)).finally(() => releaseOwner(owner)))).then(results => {
      for (const owner of [...owners]) releaseOwner(owner)
      owners.clear()
      const failures = [
        ...results.filter(result => result.status === 'rejected').map(result => result.reason),
        ...abortFailures.splice(0),
      ]
      if (failures.length > 0) throw new AggregateError(failures, `Owned process cleanup incomplete: ${failures.map(error => error?.message ?? String(error)).join('; ')}`)
      return undefined
    })
    return cleanupPromise
  }

  return Object.freeze({
    spawn,
    releaseCompletedRoot,
    releaseExitedRoot,
    releaseExitedRootUnverified,
    stopAll,
    cleanup: stopAll,
    waitForChild,
    waitForChildClose,
    signal: abortController.signal,
    get children() { return Object.freeze([...owners].map(owner => owner.child)) },
    get stopping() { return stopping },
  })
}

export const createChildSupervisor = createProcessTreeSupervisor

export const internals = Object.freeze({
  childHasExited,
  childIdentityIsLive,
  hasCompletionContract,
  descendantsUnverifiedError,
  ROOT_EXITED_DESCENDANTS_UNVERIFIED,
  exactPid,
  waitForDelay,
  waitForTermination,
  waitForChildClose,
  resolveTrustedTaskkillPath,
})
