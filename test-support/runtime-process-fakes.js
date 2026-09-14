import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

export const TASKKILL_PATH = 'C:\\Windows\\System32\\taskkill.exe'

export class FakeChild extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
    this.exitCode = null
    this.signalCode = null
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.killSignals = []
  }

  exit(code = 0, signal = null) {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }

  kill(signal = 'SIGTERM') {
    this.killSignals.push(signal)
    if (signal === 'SIGTERM' || signal === 'SIGKILL') queueMicrotask(() => this.exit(null, signal))
    return true
  }
}

export function fakeSpawner({ platform = 'linux' } = {}) {
  const children = []
  const calls = []
  let nextPid = 10_000
  const spawnImpl = (command, args, options) => {
    const child = new FakeChild(nextPid++)
    children.push(child)
    calls.push({ child, command, args, options })
    if (platform === 'win32' && command === TASKKILL_PATH) {
      queueMicrotask(() => {
        child.exit(0, null)
        if (args.includes('/f')) {
          const target = children.find(candidate => String(candidate.pid) === String(args[1]))
          target?.exit(0, null)
        }
      })
    }
    return child
  }
  const processKill = (pid, signal) => {
    const child = children.find(candidate => -candidate.pid === pid)
    if (child !== undefined) {
      child.killSignals.push(signal)
      if (signal === 'SIGTERM' || signal === 'SIGKILL') queueMicrotask(() => child.exit(null, signal))
    }
  }
  return { children, calls, spawnImpl, processKill }
}

export function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
  return { promise, resolve, reject }
}

export function nextTurn() {
  return new Promise(resolve => setImmediate(resolve))
}

export function envValue(environment, name) {
  const entry = Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return entry?.[1]
}
