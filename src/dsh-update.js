import {
  activateManagedDsh,
  checkForDshUpdate,
  deactivateManagedDsh,
  installDshVersion,
} from './dsh-runtime.js'
import {
  diagnosticDialogDetail,
  diagnosticErrorDetail,
  diagnosticLogText,
  diagnosticStatusText,
  DIAGNOSTIC_NATIVE_DIALOG_DETAIL_MAX_CHARS,
  sanitizeDiagnosticValue,
} from './diagnostics.js'
import {
  createCandidateBuilder,
  prepareReleaseCandidate,
  verifyReadyCandidate,
} from './release/candidate-builder.js'

// Candidate preparation is deliberately a separate, non-activating boundary.
// The ordinary online updater below still owns the interactive restart flow;
// these exports are for callers that need a verified release artifact only.
export const prepareDshCandidate = prepareReleaseCandidate
export const prepareCandidate = prepareReleaseCandidate
export { createCandidateBuilder, prepareReleaseCandidate, verifyReadyCandidate }

function dshUpdateCopy(isChinese) {
  return isChinese ? {
      check: '检查 DSH 更新…',
      checking: '正在检查 DSH 更新…',
      installing: version => `正在更新 DSH 至 ${version}…`,
      restarting: '正在使用新版 DSH 重启…',
      restore: version => `恢复内置 DSH ${version}…`,
      availableTitle: '发现 DSH 更新',
      availableMessage: version => `@deepseek-ai/dsh ${version} 已发布`,
      availableDetail: current => `当前运行版本为 ${current}。更新将安装到用户数据目录，并重启本地 Harness。`,
      update: '更新并重启',
      later: '稍后',
      currentTitle: 'DSH 已是最新版本',
      currentMessage: version => `@deepseek-ai/dsh ${version} 已是 npm latest 版本。`,
      failedTitle: 'DSH 更新失败',
      failedMessage: '无法完成 @deepseek-ai/dsh 在线更新。',
      restoreTitle: '恢复内置 DSH',
      restoreMessage: version => `是否恢复使用 DeepSeek Harness Desktop 内置的 ${version} 版本？`,
      restoreDetail: '当前会话会重新加载，已下载的 DSH 版本会保留在用户数据目录。',
      restoreNow: '恢复并重启',
      cancel: '取消',
      operationBusy: '另一个插件或 DSH 操作正在进行。',
    } : {
      check: 'Check for DSH Updates…',
      checking: 'Checking for DSH Updates…',
      installing: version => `Updating DSH to ${version}…`,
      restarting: 'Restarting with the New DSH Version…',
      restore: version => `Restore Bundled DSH ${version}…`,
      availableTitle: 'DSH Update Available',
      availableMessage: version => `@deepseek-ai/dsh ${version} is available`,
      availableDetail: current => `The running version is ${current}. The update will be installed in your user data directory, then the local Harness will restart.`,
      update: 'Update and Restart',
      later: 'Later',
      currentTitle: 'DSH Is Up to Date',
      currentMessage: version => `@deepseek-ai/dsh ${version} is the latest npm version.`,
      failedTitle: 'DSH Update Failed',
      failedMessage: 'The @deepseek-ai/dsh online update could not be completed.',
      restoreTitle: 'Restore Bundled DSH',
      restoreMessage: version => `Restore the DSH ${version} version bundled with DeepSeek Harness Desktop?`,
      restoreDetail: 'The current session will reload. Downloaded DSH versions remain in the user data directory.',
      restoreNow: 'Restore and Restart',
      cancel: 'Cancel',
      operationBusy: 'Another plugin or DSH operation is already running.',
    }
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('DSH restore aborted')
}

function linkAbortSignal(signal) {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(signal.reason)
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener?.('abort', forwardAbort, { once: true })
  return Object.freeze({
    controller,
    displaySignal: signal ?? controller.signal,
    signal: controller.signal,
    dispose: () => signal?.removeEventListener?.('abort', forwardAbort),
  })
}

const DEFAULT_CHILD_CANCELLATION_TIMEOUT_MS = 5_000
const ABORTED_CHILD = Symbol('aborted-child')

function awaitChildCancellation(promise, signal, {
  timeoutMs = DEFAULT_CHILD_CANCELLATION_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  const child = Promise.resolve(promise)
  if (signal === undefined) return child

  const waitForChild = () => new Promise((resolve, reject) => {
    let settled = false
    let timer
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeoutImpl(timer)
      callback(value)
    }
    child.then(
      value => finish(resolve, value),
      error => finish(reject, error),
    )
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeoutImpl(() => finish(reject, abortReason(signal)), timeoutMs)
      timer?.unref?.()
    } else {
      finish(reject, abortReason(signal))
    }
  })

  if (signal.aborted) return waitForChild()
  let onAbort
  const aborted = new Promise(resolve => {
    onAbort = () => resolve(ABORTED_CHILD)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([child, aborted]).then(value => {
    if (value === ABORTED_CHILD) return waitForChild()
    return value
  }).finally(() => {
    signal.removeEventListener('abort', onAbort)
  })
}

function runtimeChangeSucceeded(value) {
  return value === true || value?.success === true
}

function dialogOptions(options) {
  const projected = sanitizeDiagnosticValue(options, { maxStringLength: DIAGNOSTIC_NATIVE_DIALOG_DETAIL_MAX_CHARS })
  if (projected !== null && typeof projected === 'object' && projected.detail !== undefined) {
    projected.detail = diagnosticDialogDetail(projected.detail)
  }
  return projected
}

export function createDshUpdateController({
  initialRuntime,
  runtimeRoot,
  pnpmEntry,
  execPath,
  env,
  hiddenChildProcess,
  isChinese,
  dialog,
  getWindow,
  onRuntimeChanged,
  onStateChange = () => {},
  onOutput = () => {},
  log = () => {},
  checkImpl = checkForDshUpdate,
  installImpl = installDshVersion,
  activateImpl = activateManagedDsh,
  deactivateImpl = deactivateManagedDsh,
  onRuntimeCommitted = () => {},
  onRuntimeRollback = () => true,
  isOperationBlocked = () => false,
  childCancellationTimeoutMs = DEFAULT_CHILD_CANCELLATION_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
}) {
  const copy = dshUpdateCopy(isChinese)
  const safeOutput = (source, text) => onOutput(diagnosticStatusText(source), diagnosticLogText(text))
  const bundledRuntime = initialRuntime.bundled ?? initialRuntime
  let runtime = initialRuntime
  let state = 'idle'
  let targetVersion
  let operation
  let restoreOperationController
  let restorePromise

  function setState(next, version) {
    state = next
    if (version !== undefined) targetVersion = version
    onStateChange()
  }

  function showMessage(options, signal, cancellationSignal = signal) {
    if (signal?.aborted || cancellationSignal?.aborted) return Promise.reject(abortReason(signal ?? cancellationSignal))
    const safeOptions = dialogOptions(options)
    const messageOptions = signal === undefined ? safeOptions : { ...safeOptions, signal }
    const window = getWindow()
    if (signal?.aborted || cancellationSignal?.aborted) return Promise.reject(abortReason(signal ?? cancellationSignal))
    let pending
    try {
      pending = window?.isDestroyed?.() === false
        ? dialog.showMessageBox(window, messageOptions)
        : dialog.showMessageBox(messageOptions)
    } catch (error) {
      pending = Promise.reject(error)
    }
    if (cancellationSignal === undefined) return Promise.resolve(pending)

    let onAbort
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(abortReason(cancellationSignal))
      cancellationSignal.addEventListener('abort', onAbort, { once: true })
    })
    return Promise.race([Promise.resolve(pending), aborted]).finally(() => {
      cancellationSignal.removeEventListener('abort', onAbort)
    })
  }

  function operationBusy() {
    return state !== 'idle' || isOperationBlocked()
  }

  function menuItem() {
    if (state === 'checking') return { label: copy.checking, enabled: false }
    if (state === 'available') return { label: copy.availableMessage(diagnosticStatusText(targetVersion)), enabled: false }
    if (state === 'installing') return { label: copy.installing(diagnosticStatusText(targetVersion)), enabled: false }
    if (state === 'restarting') return { label: copy.restarting, enabled: false }
    return { label: copy.check, enabled: !operationBusy() }
  }

  function restoreItem() {
    if (runtime.source !== 'managed') return undefined
    return {
      label: copy.restore(diagnosticStatusText(runtime.bundled.version)),
      enabled: !operationBusy(),
    }
  }

  // Candidate activation is owned by the desktop release controller. Keep
  // this small setter separate from install/activate so a restart can hydrate
  // the updater with the verified managed runtime without pretending that a
  // second online install happened. This also makes the Update route report
  // the runtime that the active release pointer actually owns.
  function setRuntime(nextRuntime) {
    if (nextRuntime === null || typeof nextRuntime !== 'object'
      || typeof nextRuntime.version !== 'string' || nextRuntime.version.trim() === '') {
      throw new TypeError('Invalid DSH runtime')
    }
    runtime = nextRuntime.bundled === undefined
      ? { ...nextRuntime, bundled: bundledRuntime }
      : nextRuntime
    onStateChange()
    return runtime
  }

  async function fail(error, notify, cancellationSignal, displaySignal = cancellationSignal) {
    if (cancellationSignal?.aborted) {
      setState('idle')
      return
    }
    const detail = diagnosticErrorDetail(error)
    log('error', diagnosticLogText(`DSH update failed: ${detail}`))
    setState('idle')
    if (notify && !cancellationSignal?.aborted) {
      await showMessage({
        type: 'error',
        title: copy.failedTitle,
        message: copy.failedMessage,
        detail,
      }, displaySignal, cancellationSignal)
    }
  }

  async function restoreTransaction(previousRuntime, { runtimeChanged = false, activationAttempted = false } = {}) {
    if (runtimeChanged) {
      try {
        const restored = await Promise.resolve(onRuntimeRollback(previousRuntime, { signal: undefined }))
        if (restored === false) log('error', 'DSH runtime rollback did not report success')
      } catch (error) {
        log('error', diagnosticLogText(`DSH runtime rollback failed: ${diagnosticErrorDetail(error)}`))
      }
    }
    if (activationAttempted) {
      try {
        const restored = previousRuntime.source === 'managed'
          ? await Promise.resolve(activateImpl(runtimeRoot, previousRuntime.version))
          : await Promise.resolve(deactivateImpl(runtimeRoot))
        if (restored === false) log('error', 'DSH active runtime pointer rollback did not report success')
      } catch (error) {
        log('error', diagnosticLogText(`DSH active runtime pointer rollback failed: ${diagnosticErrorDetail(error)}`))
      }
    }
  }

  async function install(version, linked) {
    const signal = linked.signal
    const previousRuntime = runtime
    let runtimeChanged = false
    let activationAttempted = false
    if (signal.aborted) return
    setState('installing', version)
    try {
      if (signal.aborted) return
      let pending
      try {
        pending = installImpl({
          version,
          runtimeRoot,
          pnpmEntry,
          execPath,
          env,
          ...(hiddenChildProcess === undefined ? {} : { hiddenChildProcess }),
          signal,
          onOutput: safeOutput,
        })
      } catch (error) {
        pending = Promise.reject(error)
      }
      // The install owner receives the linked signal and performs its own child
      // cleanup. Do not let this transaction settle until that child has either
      // stopped or exceeded the bounded cancellation grace period.
      const installation = await awaitChildCancellation(pending, signal, {
        timeoutMs: childCancellationTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      })
      if (signal.aborted) return
      const nextRuntime = { ...installation, source: 'managed', bundled: bundledRuntime }
      setState('restarting')
      if (signal.aborted) return
      let changed
      try {
        changed = await awaitChildCancellation(onRuntimeChanged(nextRuntime, { signal }), signal, {
          timeoutMs: childCancellationTimeoutMs,
          setTimeoutImpl,
          clearTimeoutImpl,
        })
      } catch (error) {
        throw error
      }
      const restartSucceeded = runtimeChangeSucceeded(changed)
      // Once the child reports success it may own a live candidate server even
      // if the action aborts in the next turn. Mark it before the abort check so
      // rollback also covers that late boundary.
      runtimeChanged = restartSucceeded
      if (signal.aborted) throw abortReason(signal)
      if (!restartSucceeded) throw new Error('DSH runtime restart did not report success')
      if (signal.aborted) throw abortReason(signal)

      // Activation is the sole active.json publication boundary. It occurs only
      // after the candidate Harness has passed its current-generation readiness
      // gate and the linked action is still live.
      activationAttempted = true
      let activation
      try {
        activation = await awaitChildCancellation(activateImpl(runtimeRoot, nextRuntime.version, { signal }), signal, {
          timeoutMs: childCancellationTimeoutMs,
          setTimeoutImpl,
          clearTimeoutImpl,
        })
      } catch (error) {
        throw error
      }
      if (activation === false) throw new Error('DSH runtime activation did not report success')
      if (signal.aborted) throw abortReason(signal)

      runtime = nextRuntime
      await awaitChildCancellation(onRuntimeCommitted(nextRuntime, { signal }), signal, {
        timeoutMs: childCancellationTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      })
      if (signal.aborted) throw abortReason(signal)
      setState('idle')
    } catch (error) {
      runtime = previousRuntime
      await restoreTransaction(previousRuntime, { runtimeChanged, activationAttempted })
      if (!signal.aborted) await fail(error, true, signal, linked.displaySignal)
      else setState('idle')
    }
  }

  async function check(manual = false, { signal } = {}) {
    if (state !== 'idle' || operation !== undefined) return
    if (isOperationBlocked()) {
      if (manual) await fail(new Error(copy.operationBusy), true)
      return
    }
    const linked = linkAbortSignal(signal)
    operation = linked
    setState('checking')
    try {
      if (linked.signal.aborted) return
      let pending
      try {
        pending = checkImpl({
          currentVersion: runtime.version,
          runtimeRoot,
          pnpmEntry,
          execPath,
          env,
          ...(hiddenChildProcess === undefined ? {} : { hiddenChildProcess }),
          signal: linked.signal,
          onOutput: safeOutput,
        })
      } catch (error) {
        pending = Promise.reject(error)
      }
      const result = await awaitChildCancellation(pending, linked.signal, {
        timeoutMs: childCancellationTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      })
      if (linked.signal.aborted) return
      if (!result.available) {
        setState('idle')
        if (manual) {
          await showMessage({
            type: 'info',
            title: copy.currentTitle,
            message: copy.currentMessage(runtime.version),
          }, linked.displaySignal, linked.signal)
        }
        return
      }
      setState('available', result.latestVersion)
      const response = await showMessage({
        type: 'info',
        title: copy.availableTitle,
        message: copy.availableMessage(result.latestVersion),
        detail: copy.availableDetail(runtime.version),
        buttons: [copy.update, copy.later],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }, linked.displaySignal, linked.signal)
      if (linked.signal.aborted || response?.response !== 0) {
        setState('idle')
        return
      }
      if (linked.signal.aborted) return
      await install(result.latestVersion, linked)
    } catch (error) {
      if (!linked.signal.aborted) await fail(error, manual, linked.signal, linked.displaySignal)
    } finally {
      if (linked.signal.aborted) setState('idle')
      linked.dispose()
      if (operation === linked) operation = undefined
    }
  }

  // Quiet availability probe for the desktop sidebar. It uses the same
  // registry check as the interactive updater, but never opens a dialog or
  // installs anything; the caller decides how to present the result.
  async function probe({ signal, channel } = {}) {
    const probeCheck = options => checkImpl({ ...options, ...(channel === undefined ? {} : { channel }) })
    if (state !== 'idle' || operation !== undefined || isOperationBlocked()) {
      return {
        currentVersion: runtime.version,
        latestVersion: targetVersion ?? null,
        available: false,
        busy: true,
      }
    }

    const linked = linkAbortSignal(signal)
    operation = linked
    setState('checking')
    try {
      if (linked.signal.aborted) return { currentVersion: runtime.version, latestVersion: null, available: false, aborted: true }
      let pending
      try {
        pending = probeCheck({
          currentVersion: runtime.version,
          runtimeRoot,
          pnpmEntry,
          execPath,
          env,
          ...(hiddenChildProcess === undefined ? {} : { hiddenChildProcess }),
          signal: linked.signal,
          onOutput: safeOutput,
        })
      } catch (error) {
        pending = Promise.reject(error)
      }
      const result = await awaitChildCancellation(pending, linked.signal, {
        timeoutMs: childCancellationTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      })
      if (linked.signal.aborted) return { currentVersion: runtime.version, latestVersion: null, available: false, aborted: true }
      return {
        currentVersion: runtime.version,
        latestVersion: result.latestVersion ?? null,
        available: result.available === true,
        channel: result.channel ?? 'stable',
      }
    } catch (error) {
      if (!linked.signal.aborted) log('warn', diagnosticLogText(`DSH update probe failed: ${diagnosticErrorDetail(error)}`))
      return {
        currentVersion: runtime.version,
        latestVersion: null,
        available: false,
        error: linked.signal.aborted ? undefined : diagnosticErrorDetail(error),
      }
    } finally {
      linked.dispose()
      if (operation === linked) operation = undefined
      setState('idle')
    }
  }

  async function performRestore(signal, displaySignal) {
    // Mark the confirmation as busy before awaiting the dialog. Repeated menu
    // or route requests now observe `confirming` and cannot open a second box.
    if (signal.aborted) {
      setState('idle')
      return
    }
    setState('confirming')
    let response
    try {
      response = await showMessage({
        type: 'warning',
        title: copy.restoreTitle,
        message: copy.restoreMessage(runtime.bundled.version),
        detail: copy.restoreDetail,
        buttons: [copy.restoreNow, copy.cancel],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }, displaySignal, signal)
    } catch (error) {
      await fail(error, true, signal)
      return
    }
    // Electron resolves an AbortSignal-cancelled message box as if the user
    // chose its cancel button. Check the action signal separately so a late
    // response can never activate the bundled runtime after shutdown.
    if (signal.aborted || response?.response !== 0) {
      setState('idle')
      return
    }
    const previousRuntime = runtime
    let runtimeChanged = false
    let pointerAttempted = false
    try {
      if (signal.aborted) {
        setState('idle')
        return
      }
      const nextRuntime = bundledRuntime
      setState('restarting')
      if (signal.aborted) {
        setState('idle')
        return
      }
      const changed = await awaitChildCancellation(onRuntimeChanged(nextRuntime, { signal }), signal, {
        timeoutMs: childCancellationTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      })
      const restartSucceeded = runtimeChangeSucceeded(changed)
      runtimeChanged = restartSucceeded
      if (signal.aborted) throw abortReason(signal)
      if (!restartSucceeded) throw new Error('DSH bundled runtime restart did not report success')
      if (signal.aborted) throw abortReason(signal)

      // Bundled restore uses the same readiness-first transaction as managed
      // updates. Removing active.json is the pointer boundary, not the stage.
      pointerAttempted = true
      let pending
      try {
        pending = deactivateImpl(runtimeRoot, { signal })
      } catch (error) {
        pending = Promise.reject(error)
      }
      const deactivated = await awaitChildCancellation(pending, signal, {
        timeoutMs: childCancellationTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      })
      if (deactivated === false) throw new Error('Bundled DSH deactivation did not report success')
      if (signal.aborted) throw abortReason(signal)
      runtime = nextRuntime
      await awaitChildCancellation(onRuntimeCommitted(nextRuntime, { signal }), signal, {
        timeoutMs: childCancellationTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      })
      if (signal.aborted) throw abortReason(signal)
      setState('idle')
    } catch (error) {
      runtime = previousRuntime
      await restoreTransaction(previousRuntime, { runtimeChanged, activationAttempted: pointerAttempted })
      if (!signal.aborted) await fail(error, true, signal)
      else setState('idle')
    }
  }

  function restoreBundled({ signal } = {}) {
    if (restorePromise !== undefined) return restorePromise
    if (state !== 'idle' || runtime.source !== 'managed') return Promise.resolve()
    if (isOperationBlocked()) return fail(new Error(copy.operationBusy), true)

    const linked = linkAbortSignal(signal)
    restoreOperationController = linked.controller
    const task = performRestore(linked.signal, linked.displaySignal)
    let settled
    settled = task.finally(() => {
      linked.dispose()
      if (restoreOperationController === linked.controller) restoreOperationController = undefined
      if (restorePromise === settled) restorePromise = undefined
    })
    restorePromise = settled
    return settled
  }

  async function useBundledFallback() {
    if (runtime.source !== 'managed') return false
    const deactivated = await Promise.resolve(deactivateImpl(runtimeRoot))
    if (deactivated === false) throw new Error('DSH managed runtime deactivation did not report success')
    runtime = bundledRuntime
    setState('idle')
    return true
  }

  function abort() {
    operation?.controller.abort()
    restoreOperationController?.abort()
  }

  return {
    abort,
    check,
    probe,
    setRuntime,
    menuItem,
    restoreBundled,
    restoreItem,
    useBundledFallback,
    get runtime() { return runtime },
    get state() { return state },
    get busy() { return operationBusy() },
    get checkAvailable() { return !operationBusy() },
    get managedRestoreAvailable() { return runtime.source === 'managed' },
    get restoreAvailable() { return runtime.source === 'managed' && !operationBusy() },
  }
}
