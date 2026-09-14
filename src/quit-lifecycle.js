/**
 * Own the Electron before-quit re-entry fence. The main process must cancel
 * every quit event while runtime/coordinator/Harness/log cleanup is pending;
 * only the one app.quit issued after both drains settle may pass through.
 */
export function createQuitLifecycle({
  app,
  getRuntime,
  getLog,
  onError = () => {},
  reason = new Error('Desktop shutdown'),
} = {}) {
  if (app === undefined || typeof app.quit !== 'function') throw new TypeError('Invalid Electron app')
  if (typeof getRuntime !== 'function') throw new TypeError('Invalid runtime resolver')
  if (typeof getLog !== 'function') throw new TypeError('Invalid log resolver')
  if (typeof onError !== 'function') throw new TypeError('Invalid quit error handler')

  let pending
  let finalQuitAllowed = false

  function closeLog(log) {
    if (log === undefined || log === null) return undefined
    if (typeof log.close === 'function') return log.close()
    if (typeof log.end === 'function') {
      return new Promise(resolve => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve()
        }
        try {
          const result = log.end(finish)
          if (result?.once) result.once('close', finish)
        } catch {
          finish()
        }
      })
    }
    return undefined
  }

  function report(error) {
    try { onError(error) } catch { /* shutdown reporting must not re-enter quit */ }
  }

  function handleBeforeQuit(event) {
    // This is the single recursive event produced by our final app.quit().
    if (finalQuitAllowed) {
      finalQuitAllowed = false
      pending = undefined
      return false
    }
    if (pending !== undefined) {
      event?.preventDefault?.()
      return true
    }

    const runtime = getRuntime()
    if (runtime === undefined || runtime === null || typeof runtime.shutdown !== 'function') return false
    event?.preventDefault?.()

    let shutdown
    try {
      shutdown = runtime.shutdown(reason)
    } catch (error) {
      shutdown = Promise.reject(error)
    }
    const logDrain = Promise.resolve().then(() => closeLog(getLog()))
    pending = Promise.allSettled([shutdown, logDrain]).then(results => {
      for (const result of results) {
        if (result.status === 'rejected') report(result.reason)
      }
      finalQuitAllowed = true
      app.quit()
    }).catch(report)
    return true
  }

  return Object.freeze({
    handleBeforeQuit,
    get pending() { return pending },
    get finalQuitAllowed() { return finalQuitAllowed },
  })
}
