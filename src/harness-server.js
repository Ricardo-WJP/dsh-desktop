import { EventEmitter } from 'node:events'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { descendantsUnverifiedError, ROOT_EXITED_DESCENDANTS_UNVERIFIED, spawnOwnedProcess, waitForChild } from './process-tree.js'

// DSH appends a session token to the readiness URL on newer runtimes. Keep
// the full loopback URL so isolated preflight probes can use the same
// readiness contract across runtime generations.
const READY_URL = /(?:^|\n)dsh web:\s+(http:\/\/127\.0\.0\.1:\d+(?:[/?][^\s]*)?)(?:\s|$)/
const DEFAULT_HIDDEN_CHILD_PROCESS = fileURLToPath(new URL('./runtime/windows-hidden-child-process.cjs', import.meta.url))

/** Build the DSH Web invocation used by the embedded desktop server. */
export function buildHarnessArgs({ entry, parentWatch, hiddenChildProcess = DEFAULT_HIDDEN_CHILD_PROCESS, patch, patches = [] }) {
  if (!Array.isArray(patches) || patches.some(value => typeof value !== 'string' || value.length === 0)) {
    throw new TypeError('Harness patch overlays must be non-empty paths')
  }
  if (typeof hiddenChildProcess !== 'string' || hiddenChildProcess.length === 0) {
    throw new TypeError('Hidden child-process preload must be a non-empty path')
  }
  return [
    '--expose-internals',
    '--require',
    hiddenChildProcess,
    '--require',
    parentWatch,
    entry,
    'web',
    '--patch',
    patch,
    ...patches.flatMap(value => ['--patch', value]),
    '--port',
    '0',
    '--no-open',
  ]
}

/** @param {import('node:child_process').ChildProcess} child @param {number} timeoutMs */
function waitForExit(child, timeoutMs) {
  return waitForChild(child, { timeoutMs }).then(() => true, () => false)
}

function rootExitCleanupFailure(reason, pid) {
  const cleanup = descendantsUnverifiedError(pid, reason)
  const aggregate = new AggregateError(
    [reason, cleanup],
    `${reason?.message ?? String(reason)}; cleanup incomplete: ${cleanup.message}`,
  )
  aggregate.code = 'PROCESS_TREE_CLEANUP_INCOMPLETE'
  return aggregate
}

/**
 * Owns one `dsh web` process and resolves only after its documented readiness
 * line is observed. The process-tree owner retains the exact root PID after
 * exit/close so a crashed root cannot orphan its descendants.
 */
export class HarnessServer extends EventEmitter {
  /**
   * @param {{
   *   command: string,
   *   args: string[],
   *   cwd: string,
   *   env: NodeJS.ProcessEnv,
   *   startupTimeoutMs?: number,
   *   shutdownTimeoutMs?: number,
   *   spawnImpl?: typeof import('node:child_process').spawn,
   *   processKill?: typeof process.kill,
   *   platform?: NodeJS.Platform | string,
   *   taskkillPath?: string,
   *   forceWindowsTreeTermination?: boolean,
   *   onOutput?: (source: 'stdout' | 'stderr', text: string) => void,
   *   signalImpl?: (child: object, signal: NodeJS.Signals) => void,
   * }} options
   */
  constructor(options) {
    super()
    this.options = options
    this.child = undefined
    this.owner = undefined
    this.startPromise = undefined
    this.stopPromise = undefined
    this.output = ''
    this.url = undefined
    this.error = undefined
    this.cleanupState = 'pending'
    this.stopped = false
    this.unsafe = false
    this.cleanupError = undefined
    this.#localListenerCleanup = undefined
  }

  #localListenerCleanup

  #detachLocalListeners() {
    const cleanup = this.#localListenerCleanup
    this.#localListenerCleanup = undefined
    cleanup?.()
  }

  #releaseLocalRoot(owner) {
    this.#detachLocalListeners()
    if (this.owner === owner) {
      this.owner = undefined
      this.child = undefined
    }
  }

  #markUnsafe(error, extra = {}) {
    const normalized = error instanceof Error ? error : new Error(String(error ?? 'Harness cleanup failed'))
    const previous = this.cleanupError
    this.unsafe = true
    if (this.cleanupError === undefined || this.cleanupError === normalized) {
      this.cleanupError = normalized
    } else if (!(this.cleanupError instanceof AggregateError) || !this.cleanupError.errors.includes(normalized)) {
      this.cleanupError = new AggregateError(
        [this.cleanupError, normalized],
        `Harness cleanup incomplete: ${this.cleanupError?.message ?? String(this.cleanupError)}; ${normalized.message}`,
      )
    }
    if (previous !== this.cleanupError) {
      this.emit('cleanup-error', Object.freeze({
        type: 'cleanup-error',
        error: normalized,
        cleanupError: this.cleanupError,
        unsafe: true,
        ...extra,
      }))
    }
    return this.cleanupError
  }

  #autoCleanup(reason, source) {
    if (source === 'ready-exit') {
      const owner = this.owner
      if (owner?.stopping !== true
        && owner?.cleanupState !== 'complete'
        && owner?.releaseAfterUnexpectedExit?.() === true) {
        this.error = reason
        this.url = undefined
        this.stopped = false
        this.cleanupState = owner.cleanupState
        this.#releaseLocalRoot(owner)
        this.#markUnsafe(rootExitCleanupFailure(reason, owner.pid), {
          source,
          cleanupState: this.cleanupState,
          rootError: reason,
        })
        return
      }
    }
    void this.stop(reason).catch(error => {
      // The stop promise already latched and emitted the exact cleanup error;
      // this catch only prevents an auto-cleanup rejection from becoming an
      // unhandled rejection while keeping the failure observable in status.
      this.#markUnsafe(error, { source })
    })
  }

  start() {
    if (this.unsafe) return Promise.reject(this.cleanupError ?? new Error('HarnessServer is unsafe after incomplete cleanup'))
    if (this.startPromise !== undefined) return this.startPromise
    this.startPromise = this.#start()
    return this.startPromise
  }

  async #start() {
    const {
      command,
      args,
      cwd,
      env,
      spawnImpl,
      processKill,
      platform = process.platform,
      signalImpl,
      taskkillPath,
      forceWindowsTreeTermination = false,
      startupTimeoutMs = 120_000,
      shutdownTimeoutMs = 7_000,
      onOutput = () => {},
    } = this.options

    let spawned
    try {
      spawned = spawnOwnedProcess(command, args, {
        cwd,
        env,
        spawnImpl,
        processKill,
        signalImpl,
        taskkillPath,
        platform,
        forceWindowsTreeTermination,
        terminationTimeoutMs: shutdownTimeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      throw new Error(`Unable to start DeepSeek Harness: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    const { child, owner } = spawned
    this.child = child
    this.owner = owner

    return new Promise((resolve, reject) => {
      let settled = false
      let timeout
      const finish = (error, url) => {
        if (settled) return
        settled = true
        if (timeout !== undefined) clearTimeout(timeout)
        if (error !== undefined) {
          this.error = error
          this.stopped = false
          // A root that errors/exits/times out before readiness may still have
          // live descendants. Await the idempotent owner cleanup before
          // releasing startup failure so identity-loss/incomplete cleanup is
          // never hidden behind the original startup error.
          let cleanup
          try { cleanup = this.stop(error) } catch (cleanupError) { cleanup = Promise.reject(cleanupError) }
          Promise.resolve(cleanup).then(
            () => reject(error),
            cleanupError => reject(new AggregateError(
              [error, cleanupError],
              `${error?.message ?? String(error)}; cleanup incomplete: ${cleanupError?.message ?? String(cleanupError)}`,
            )),
          )
        } else resolve(url)
      }
      const receive = (source, chunk) => {
        const text = String(chunk)
        onOutput(source, text)
        this.output = `${this.output}${text}`.slice(-16_384)
        const match = this.output.match(READY_URL)
        if (match?.[1] !== undefined) {
          this.url = match[1]
          this.error = undefined
          this.stopped = false
          this.cleanupState = this.owner?.cleanupState ?? this.cleanupState
          finish(undefined, match[1])
        }
      }

      child.stdout?.setEncoding?.('utf8')
      child.stderr?.setEncoding?.('utf8')
      const onStdout = chunk => receive('stdout', chunk)
      const onStderr = chunk => receive('stderr', chunk)
      const onError = error => finish(new Error(`Unable to start DeepSeek Harness: ${error.message}`, { cause: error }))
      const onExit = (code, signal) => {
        const ready = this.url !== undefined
        const exitError = new Error(`${ready ? 'DeepSeek Harness exited after readiness' : 'DeepSeek Harness exited before it was ready'} (code: ${String(code)}, signal: ${String(signal)}).`)
        if (ready) this.#autoCleanup(exitError, 'ready-exit')
        else finish(exitError)
        this.emit('exit', {
          code,
          signal,
          ready,
          output: this.output,
        })
      }
      child.stdout?.on?.('data', onStdout)
      child.stderr?.on?.('data', onStderr)
      child.once('error', onError)
      child.once('exit', onExit)
      this.#localListenerCleanup = () => {
        child.stdout?.removeListener?.('data', onStdout)
        child.stderr?.removeListener?.('data', onStderr)
        child.removeListener?.('error', onError)
        child.removeListener?.('exit', onExit)
      }

      timeout = setTimeout(() => {
        finish(new Error(`DeepSeek Harness did not become ready within ${Math.round(startupTimeoutMs / 1000)} seconds.`))
      }, startupTimeoutMs)
    })
  }

  stop(reason = new Error('DeepSeek Harness stopped')) {
    if (this.stopPromise !== undefined) return this.stopPromise
    const owner = this.owner
    if (owner === undefined) {
      this.stopPromise = this.unsafe
        ? Promise.reject(this.cleanupError ?? new Error('HarnessServer is unsafe after incomplete cleanup'))
        : this.cleanupState === ROOT_EXITED_DESCENDANTS_UNVERIFIED
          ? Promise.reject(rootExitCleanupFailure(this.error ?? new Error('DeepSeek Harness root exited'), this.child?.pid))
          : Promise.resolve()
      return this.stopPromise
    }
    this.stopPromise = Promise.resolve().then(() => owner.stop(reason)).then(result => {
      if (owner.cleanupError !== undefined) throw owner.cleanupError
      this.cleanupState = owner.cleanupState
      this.stopped = true
      this.url = undefined
      this.#releaseLocalRoot(owner)
      return result
    }).catch(error => {
      this.#markUnsafe(error, { source: 'stop' })
      throw error
    })
    return this.stopPromise
  }

  status() {
    return Object.freeze({
      state: this.unsafe || this.error !== undefined ? 'failed' : this.stopped ? 'stopped' : this.url === undefined ? 'starting' : 'ready',
      url: this.url,
      error: this.error,
      cleanupState: this.owner?.cleanupState ?? this.cleanupState,
      descendantsVerified: this.owner?.descendantsVerified ?? this.cleanupState === 'complete',
      unsafe: this.unsafe,
      cleanupError: this.cleanupError,
    })
  }

  statusSnapshot() {
    return this.status()
  }
}

export const internals = Object.freeze({ READY_URL, waitForExit })
