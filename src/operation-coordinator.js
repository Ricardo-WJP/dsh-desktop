/**
 * One serialized owner for desktop operations that can restart Harness or
 * mutate the profile. Queue nodes are release-safe: an aborted waiter cannot
 * release its gate until the active predecessor has finished.
 */
export function createOperationCoordinator({ onStateChange = () => {} } = {}) {
  if (typeof onStateChange !== 'function') throw new TypeError('Invalid operation state callback')

  let tail = Promise.resolve()
  let active
  let queued = 0
  let outstanding = 0
  let closed = false
  let closeDrain
  let sequence = 0
  const controllers = new Set()
  const drainWaiters = []

  function stateChanged() {
    try { onStateChange() } catch { /* status publication must not break the queue */ }
  }

  function settleDrainWaiters() {
    if (outstanding !== 0) return
    const waiters = drainWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  function drain() {
    if (outstanding === 0) return Promise.resolve()
    return new Promise(resolve => { drainWaiters.push(resolve) })
  }

  function abortReason(signal) {
    return signal?.reason instanceof Error ? signal.reason : new Error('Desktop operation aborted')
  }

  async function waitForTurn(previous, signal) {
    if (signal?.aborted) throw abortReason(signal)
    if (signal === undefined) return previous
    let onAbort
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(abortReason(signal))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([previous, aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  function enqueue(label, action, { signal } = {}) {
    if (closed) return Promise.reject(new Error('Desktop operation coordinator is closed'))
    if (typeof label !== 'string' || label.length === 0) throw new TypeError('Invalid operation label')
    if (typeof action !== 'function') throw new TypeError('Invalid operation action')
    const controller = new AbortController()
    controllers.add(controller)
    const forwardAbort = () => controller.abort(signal.reason)
    if (signal?.aborted) controller.abort(signal.reason)
    else signal?.addEventListener?.('abort', forwardAbort, { once: true })

    const previous = tail
    let release
    let released = false
    let entered = false
    const gate = new Promise(resolve => { release = resolve })
    const node = previous.catch(() => undefined).then(() => gate)
    tail = node
    queued += 1
    outstanding += 1
    stateChanged()

    const releaseOnce = () => {
      if (released) return
      released = true
      release()
      outstanding -= 1
      stateChanged()
      settleDrainWaiters()
    }
    const run = (async () => {
      try {
        await waitForTurn(previous, controller.signal)
        if (controller.signal.aborted) throw abortReason(controller.signal)
        entered = true
        queued -= 1
        active = Object.freeze({ id: ++sequence, label })
        stateChanged()
        return await action({ signal: controller.signal, id: active.id, label })
      } finally {
        if (entered) {
          active = undefined
          stateChanged()
          releaseOnce()
        } else {
          // Keep the canceled node in the chain until its predecessor settles;
          // this is the critical ownership invariant for later writers.
          void previous.catch(() => undefined).then(releaseOnce)
          queued -= 1
          stateChanged()
        }
        controllers.delete(controller)
        signal?.removeEventListener?.('abort', forwardAbort)
      }
    })()
    // The node can only settle after releaseOnce. Remove a terminal tail after
    // it settles without allowing a canceled waiter to bypass its predecessor.
    void node.then(() => {
      if (tail === node) tail = Promise.resolve()
    })
    return run
  }

  function abortAll(reason = new Error('Desktop shutdown')) {
    for (const controller of controllers) controller.abort(reason)
  }

  return Object.freeze({
    abortAll,
    close(reason = new Error('Desktop operation coordinator is closed')) {
      if (closeDrain !== undefined) return closeDrain
      closed = true
      // Capture the drain before aborting. Abort listeners can synchronously
      // release a completed operation, and close must still return the promise
      // that represents every operation owned at this boundary.
      closeDrain = drain()
      abortAll(reason)
      return closeDrain
    },
    drain,
    enqueue,
    get active() { return active },
    get busy() { return active !== undefined || queued > 0 },
    get closed() { return closed },
    get queued() { return queued },
  })
}
