import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { buildHarnessArgs, HarnessServer } from '../src/harness-server.js'

const TASKKILL_PATH = 'C:\\Windows\\System32\\taskkill.exe'

test('embedded Web launch hides descendant consoles and disables the upstream default-browser handoff', () => {
  const args = buildHarnessArgs({
    entry: '/app/dsh/bin.js',
    parentWatch: '/app/parent-watch.cjs',
    patch: '/app/desktop.patch.yml',
  })
  assert.equal(args[0], '--expose-internals')
  assert.equal(args[1], '--require')
  assert.match(args[2], /windows-hidden-child-process\.cjs$/)
  assert.deepEqual(args.slice(3), [
    '--require',
    '/app/parent-watch.cjs',
    '/app/dsh/bin.js',
    'web',
    '--patch',
    '/app/desktop.patch.yml',
    '--port',
    '0',
    '--no-open',
  ])
})

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 1234
  child.exitCode = null
  child.signalCode = null
  child.exit = (code = 0, signal = null) => {
    child.exitCode = code
    child.signalCode = signal
    child.emit('exit', code, signal)
    child.emit('close', code, signal)
  }
  child.kill = signal => {
    child.signalCode = signal
    child.exit(null, signal)
    return true
  }
  return child
}

test('resolves after a split readiness line and captures output', async () => {
  const child = fakeChild()
  const output = []
  const server = new HarnessServer({
    command: 'electron',
    args: [],
    cwd: '/',
    env: {},
    spawnImpl: () => child,
    onOutput: (source, text) => output.push([source, text]),
  })
  const ready = server.start()
  child.stdout.write('booting\ndsh web: http://127.0.0.')
  child.stdout.write('1:45678\n')
  assert.equal(await ready, 'http://127.0.0.1:45678')
  assert.equal(output.length, 2)
})

test('resolves readiness URLs that include a session query', async () => {
  const child = fakeChild()
  const server = new HarnessServer({
    command: 'electron',
    args: [],
    cwd: '/',
    env: {},
    spawnImpl: () => child,
  })
  const ready = server.start()
  child.stdout.write('dsh web: http://127.0.0.1:45678/?token=preflight-token\n')
  assert.equal(await ready, 'http://127.0.0.1:45678/?token=preflight-token')
})

test('rejects when the child exits before readiness', async () => {
  const child = fakeChild()
  const server = new HarnessServer({
    command: 'electron',
    args: [],
    cwd: '/',
    env: {},
    spawnImpl: () => child,
  })
  const ready = server.start()
  child.exitCode = 1
  child.emit('exit', 1, null)
  await assert.rejects(ready, /exited before it was ready/)
})

test('pre-ready zero exit preserves the startup error and never taskkills the exited PID', async () => {
  const child = fakeChild()
  const taskkills = []
  const server = new HarnessServer({
    command: 'electron',
    args: [],
    cwd: '/',
    env: {},
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    spawnImpl: (command) => {
      if (command === TASKKILL_PATH) taskkills.push(command)
      return child
    },
  })
  const starting = server.start()
  child.exit(0, null)

  await assert.rejects(starting, error => error instanceof AggregateError
    && error.errors.some(item => /exited before it was ready/.test(item?.message ?? ''))
    && error.errors.some(item => item?.code === 'PROCESS_CLEANUP_IDENTITY_LOST'))
  assert.deepEqual(taskkills, [])
  assert.equal(server.status().state, 'failed')
  assert.equal(server.status().cleanupState, 'root-exited/descendants-unverified')
  assert.match(server.status().error?.message ?? '', /exited before it was ready/)
})

test('sends an absolute taskkill tree request during Windows stop', async () => {
  const child = fakeChild()
  const taskkills = []
  const server = new HarnessServer({
    command: 'electron',
    args: [],
    cwd: '/',
    env: {},
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    spawnImpl: (command, args, options) => {
      if (command !== TASKKILL_PATH) return child
      taskkills.push({ command, args, options })
      const killer = fakeChild()
      queueMicrotask(() => {
        killer.exit(0, null)
        if (!args.includes('/f')) child.exit(null, 'SIGTERM')
      })
      return killer
    },
  })
  const starting = server.start()
  await server.stop()
  await assert.rejects(starting, /exited before it was ready/)
  assert.deepEqual(taskkills.map(call => call.args), [['/pid', '1234', '/t']])
  assert.equal(taskkills.every(call => call.options.shell === false), true)
})

test('disposable Windows Host can request one exact forced tree termination', async () => {
  const child = fakeChild()
  const taskkills = []
  const server = new HarnessServer({
    command: 'electron',
    args: [],
    cwd: '/',
    env: {},
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    forceWindowsTreeTermination: true,
    spawnImpl: (command, args) => {
      if (command !== TASKKILL_PATH) return child
      taskkills.push(args)
      const killer = fakeChild()
      queueMicrotask(() => {
        child.exit(null, 'SIGKILL')
        killer.exit(0, null)
      })
      return killer
    },
  })
  const starting = server.start()
  await server.stop()
  await assert.rejects(starting, /exited before it was ready/)
  assert.deepEqual(taskkills, [['/pid', '1234', '/t', '/f']])
})

test('forced Windows cleanup accepts taskkill 128 only after the captured root exits', async () => {
  const child = fakeChild()
  const server = new HarnessServer({
    command: 'electron',
    args: [],
    cwd: '/',
    env: {},
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    forceWindowsTreeTermination: true,
    shutdownTimeoutMs: 5,
    spawnImpl: (command) => {
      if (command !== TASKKILL_PATH) return child
      const killer = fakeChild()
      queueMicrotask(() => {
        child.exit(null, 'SIGKILL')
        killer.exit(128, null)
      })
      return killer
    },
  })
  const ready = server.start()
  child.stdout.write('dsh web: http://127.0.0.1:45678\n')
  assert.equal(await ready, 'http://127.0.0.1:45678')
  await server.stop()
  assert.equal(server.unsafe, false)
})

test('forced Windows cleanup rejects taskkill 128 while the captured root remains live', async () => {
  const child = fakeChild()
  const server = new HarnessServer({
    command: 'electron',
    args: [],
    cwd: '/',
    env: {},
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    forceWindowsTreeTermination: true,
    shutdownTimeoutMs: 1,
    spawnImpl: (command) => {
      if (command !== TASKKILL_PATH) return child
      const killer = fakeChild()
      queueMicrotask(() => killer.exit(128, null))
      return killer
    },
  })
  const ready = server.start()
  child.stdout.write('dsh web: http://127.0.0.1:45678\n')
  assert.equal(await ready, 'http://127.0.0.1:45678')
  await assert.rejects(server.stop(), /taskkill failed.*code 128/i)
  assert.equal(server.unsafe, true)
})

test('auto startup cleanup records identity loss and keeps stop rejected', async () => {
  const child = fakeChild()
  const cleanupEvents = []
  const server = new HarnessServer({
    command: 'electron',
    args: [],
    cwd: '/',
    env: {},
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    spawnImpl: () => child,
  })
  server.on('cleanup-error', event => cleanupEvents.push(event))
  const starting = server.start()
  child.exitCode = 1
  child.emit('exit', 1, null)
  await assert.rejects(starting, /exited before it was ready/)
  assert.equal(server.unsafe, true)
  assert.equal(server.cleanupError?.code, 'PROCESS_CLEANUP_IDENTITY_LOST')
  assert.equal(cleanupEvents.length, 1)
  assert.equal(cleanupEvents[0].cleanupError, server.cleanupError)
  await assert.rejects(server.stop(), error => error === server.cleanupError)
  await assert.rejects(server.start(), error => error === server.cleanupError)
})

test('a ready Host crash releases local listeners without claiming tree cleanup', async () => {
  const child = fakeChild()
  let observedStatus
  const server = new HarnessServer({
    command: 'electron',
    args: [],
    cwd: '/',
    env: {},
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    spawnImpl: () => child,
  })
  server.on('exit', () => { observedStatus = server.status() })
  const ready = server.start()
  child.stdout.write('dsh web: http://127.0.0.1:45678\n')
  assert.equal(await ready, 'http://127.0.0.1:45678')

  child.exit(1, null)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(server.unsafe, true)
  assert.equal(server.status().state, 'failed')
  assert.equal(server.status().url, undefined)
  assert.equal(server.status().cleanupState, 'root-exited/descendants-unverified')
  assert.equal(server.status().descendantsVerified, false)
  assert.equal(server.status().error?.message, 'DeepSeek Harness exited after readiness (code: 1, signal: null).')
  assert.equal(observedStatus?.state, 'failed')
  assert.equal(observedStatus?.url, undefined)
  assert.equal(server.child, undefined)
  assert.equal(server.owner, undefined)
  assert.equal(child.listenerCount('exit'), 0)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.listenerCount('error'), 0)
  await assert.rejects(server.stop(), /cleanup incomplete|descendants are unverified/i)
})

test('a ready Host zero exit is failed and unverified without taskkilling its exited PID', async () => {
  const child = fakeChild()
  const taskkills = []
  const server = new HarnessServer({
    command: 'electron',
    args: [],
    cwd: '/',
    env: {},
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    spawnImpl: (command) => {
      if (command === TASKKILL_PATH) taskkills.push(command)
      return child
    },
  })
  const ready = server.start()
  child.stdout.write('dsh web: http://127.0.0.1:45678\n')
  assert.equal(await ready, 'http://127.0.0.1:45678')

  child.exit(0, null)
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(taskkills, [])
  assert.equal(server.status().state, 'failed')
  assert.equal(server.status().url, undefined)
  assert.equal(server.status().cleanupState, 'root-exited/descendants-unverified')
  assert.equal(server.status().descendantsVerified, false)
  assert.match(server.status().error?.message ?? '', /after readiness \(code: 0/)
  assert.equal(server.owner, undefined)
  assert.equal(server.child, undefined)
})
