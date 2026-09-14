import { createProcessTreeSupervisor } from './process-tree.js'

export const MAX_COMMAND_OUTPUT_LENGTH = 64 * 1024

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Profile operation aborted')
}

export function appendOutput(current, chunk, maxLength = MAX_COMMAND_OUTPUT_LENGTH) {
  if (current.length >= maxLength) return current
  return `${current}${String(chunk)}`.slice(0, maxLength)
}

/**
 * Run one owned command and keep its stdio listeners until ChildProcess.close.
 * `exit` proves the root status; `close` proves the stdio drain needed by
 * command results. The process-tree supervisor remains the sole cleanup owner.
 */
export function runOwnedCommand({
  command,
  args,
  cwd,
  env,
  signal,
  spawnImpl,
  processKill,
  signalImpl,
  platform,
  taskkillPath,
  terminationTimeoutMs,
  timeoutMs,
  windowsHide = true,
  outputLabel,
  onOutput = () => {},
  errorForSpawn,
  errorForExit,
  maxOutputLength = MAX_COMMAND_OUTPUT_LENGTH,
  completionContract,
}) {
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    let child
    let supervisor
    let output = ''
    let stdoutOutput = ''
    let stderrOutput = ''
    let finishRequested = false
    let pendingOutcome
    let abortListener
    const outputListeners = []

    const cleanupListeners = () => {
      signal?.removeEventListener?.('abort', abortListener)
      for (const { stream, listener } of outputListeners) stream?.removeListener?.('data', listener)
      outputListeners.length = 0
    }
    const settleAfterCleanup = () => {
      if (supervisor === undefined || child === undefined || pendingOutcome === undefined) return
      const { error, result, completion } = pendingOutcome
      pendingOutcome = undefined
      void (async () => {
        let cleanupError
        let cleanupOutcome
        try {
          if (completion !== undefined) {
            // Close proves the command root and stdio are done. Without an
            // explicit caller contract it says nothing about descendants, so
            // release only the local owner and carry the unverified state.
            const released = completionContract === undefined
              ? supervisor.releaseExitedRootUnverified(child)
              : completion.code === 0 && completion.signal === null
                ? supervisor.releaseCompletedRoot(child, completionContract)
                : supervisor.releaseExitedRoot(child, completionContract)
            if (!released) {
              throw new Error(`Exited ${outputLabel} root is no longer owned`)
            }
            if (released !== true) cleanupOutcome = released
            await supervisor.stopAll()
          } else {
            // Timeout, abort, and pre-close spawn failures retain exact
            // ownership and remain fail-closed while the root is still live.
            await supervisor.stopAll(error)
          }
        } catch (failure) {
          cleanupError = failure
          // A failed release/stop must still make one exact cleanup attempt.
          // Do not turn an identity-loss failure into a successful command.
          if (error === undefined) {
            try { await supervisor.stopAll(failure) } catch (retryError) {
              cleanupError = new AggregateError([failure, retryError], `${outputLabel} cleanup incomplete: ${retryError?.message ?? String(retryError)}`)
            }
          }
        }
        if (error !== undefined) {
          if (cleanupOutcome?.complete === false) {
            try {
              Object.defineProperty(error, 'cleanupState', {
                configurable: true,
                enumerable: false,
                value: cleanupOutcome.cleanupState,
                writable: false,
              })
              Object.defineProperty(error, 'descendantsVerified', {
                configurable: true,
                enumerable: false,
                value: false,
                writable: false,
              })
            } catch { /* preserve the command error when metadata cannot attach */ }
          }
          if (cleanupError !== undefined) {
            const aggregate = new AggregateError(
              [error, cleanupError],
              `${outputLabel} failed: ${error?.message ?? String(error)}; cleanup incomplete: ${cleanupError?.message ?? String(cleanupError)}`,
            )
            if (error?.code !== undefined) aggregate.code = error.code
            reject(aggregate)
          } else reject(error)
        } else if (cleanupError !== undefined) {
          reject(cleanupError)
        } else {
          resolve(cleanupOutcome?.complete === false
            ? { ...result, cleanupState: cleanupOutcome.cleanupState, descendantsVerified: false }
            : result)
        }
      })()
    }
    const finish = (error, result, completion) => {
      if (finishRequested) return
      finishRequested = true
      pendingOutcome = { error, result, completion }
      // The completion authority is close when command output matters, so this
      // removal runs only after all final stdout/stderr chunks have drained.
      cleanupListeners()
      // A signal can fire from inside an injected spawn implementation. Defer
      // settlement until the exact supervisor/root have been captured.
      settleAfterCleanup()
    }
    const abort = () => finish(abortError(signal))
    abortListener = abort
    signal?.addEventListener?.('abort', abortListener, { once: true })
    // Recheck after registration: an injected spawner/signal adapter can abort
    // during the attach race. The exact owner is settled only after it is
    // captured below, so its tree cannot leak.
    if (signal?.aborted) queueMicrotask(abortListener)

    try {
      supervisor = createProcessTreeSupervisor({
        cwd,
        env,
        windowsHide,
        spawnImpl,
        processKill,
        signalImpl,
        platform,
        taskkillPath,
        terminationTimeoutMs,
      })
      child = supervisor.spawn(command, args, {
        cwd,
        env,
        windowsHide,
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      })
      settleAfterCleanup()
    } catch (error) {
      cleanupListeners()
      reject(errorForSpawn?.(error) ?? error)
      return
    }

    const capture = (source, chunk) => {
      const text = String(chunk)
      output = appendOutput(output, text, maxOutputLength)
      if (source === 'stderr') stderrOutput = appendOutput(stderrOutput, text, maxOutputLength)
      else stdoutOutput = appendOutput(stdoutOutput, text, maxOutputLength)
      onOutput(source, text)
    }
    for (const [source, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      const listener = chunk => capture(source, chunk)
      stream?.on?.('data', listener)
      outputListeners.push({ stream, listener })
    }

    // Close, rather than exit, is the completion authority for commands. It
    // keeps output listeners alive through the final stdio drain while the
    // process-tree owner still uses exit semantics for ordinary cleanup waits.
    void supervisor.waitForChild(child, { timeoutMs, signal, waitForClose: true }).then(result => {
      if (result === undefined) {
        finish(new Error(`${outputLabel} timed out after ${String(timeoutMs)} ms`))
      } else if (result.code === 0 && result.signal === null) {
        finish(undefined, {
          output,
          stdout: stdoutOutput,
          stderr: stderrOutput,
        }, { code: result.code, signal: result.signal })
      } else {
        // pnpm writes its useful stack and lifecycle failure to stderr after
        // printing a long progress stream to stdout. Prefer the diagnostic
        // stream so callers do not surface only the last progress line.
        const detail = [stderrOutput.trim(), stdoutOutput.trim()]
          .filter((value, index, values) => value !== '' && values.indexOf(value) === index)
          .join('\n')
          || errorForExit?.(result.code, result.signal)
          || `${outputLabel} exited with code ${String(result.code)} and signal ${String(result.signal)}`
        finish(new Error(detail), undefined, { code: result.code, signal: result.signal })
      }
    }, error => finish(errorForSpawn?.(error) ?? error))
  })
}

export const internals = Object.freeze({ appendOutput, abortError })
