import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { buildWindowsProcessTreeTermination, createChildSupervisor, createSpawnOptions, nodeCliInvocation, spawnDirect, waitForHttp } from '../src/desktop-launcher.js'

test('direct process seam preserves argv and blocks shell interpretation on Windows', () => {
  let invocation
  const fakeChild = { marker: true }
  const child = spawnDirect(
    'C:\\node.exe',
    ['C:\\tools\\vite\\bin\\vite.js', '--host', '127.0.0.1', '--port', '5173'],
    createSpawnOptions({ cwd: 'C:\\work', env: { TEST: '1' }, windowsHide: false }),
    (command, args, options) => {
      invocation = { command, args, options }
      return fakeChild
    },
  )
  assert.equal(child, fakeChild)
  assert.deepEqual(invocation, {
    command: 'C:\\node.exe',
    args: ['C:\\tools\\vite\\bin\\vite.js', '--host', '127.0.0.1', '--port', '5173'],
    options: { cwd: 'C:\\work', env: { TEST: '1' }, stdio: 'inherit', windowsHide: false, shell: false },
  })
})

test('node CLI invocation never creates a .cmd or npx command', () => {
  const invocation = nodeCliInvocation('C:\\work\\node_modules\\vite\\bin\\vite.js', ['build'], 'C:\\node.exe')
  assert.equal(invocation.command, 'C:\\node.exe')
  assert.deepEqual(invocation.args, ['C:\\work\\node_modules\\vite\\bin\\vite.js', 'build'])
  assert.doesNotMatch(invocation.command, /(?:\.cmd|npx)/i)
  assert.doesNotMatch(invocation.args[0], /(?:\.cmd|npx)/i)
})

const TASKKILL_PATH = 'C:\\Windows\\System32\\taskkill.exe'

class FakeChild extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
    this.exitCode = null
    this.signalCode = null
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
    this.signalCode = signal
    queueMicrotask(() => this.exit(null, signal))
    return true
  }
}

test('Windows owned-child cleanup requests a graceful tree stop before force for only the spawned PID', async () => {
  const invocation = buildWindowsProcessTreeTermination(4321, true, TASKKILL_PATH)
  assert.deepEqual(invocation, { command: TASKKILL_PATH, args: ['/pid', '4321', '/t', '/f'] })
  assert.throws(() => buildWindowsProcessTreeTermination(0, true, TASKKILL_PATH), /owned process id/)

  const calls = []
  const children = []
  let owned
  const supervisor = createChildSupervisor({
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    terminationTimeoutMs: 5,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      const child = new FakeChild(command === TASKKILL_PATH ? 9876 : 4321)
      children.push(child)
      if (command === TASKKILL_PATH) {
        queueMicrotask(() => {
          child.exit(0, null)
          if (args.includes('/f')) owned?.exit(0, null)
        })
      } else {
        owned = child
      }
      return child
    },
  })
  owned = supervisor.spawn('C:\\node.exe', ['vite.js'], createSpawnOptions({ cwd: 'C:\\work' }))
  await supervisor.stopAll()

  const taskkills = calls.filter(call => call.command === TASKKILL_PATH)
  assert.deepEqual(taskkills.map(call => call.args), [
    ['/pid', '4321', '/t'],
    ['/pid', '4321', '/t', '/f'],
  ])
  assert.equal(taskkills.every(call => call.options.shell === false), true)
  assert.deepEqual(owned.killSignals, [])
  assert.equal(supervisor.children.length, 0)
  assert.equal(children.length, 3)
})

test('Windows nonzero taskkill is cleanup failure even when root-only fallback stops the exact root', async () => {
  const calls = []
  let owned
  const supervisor = createChildSupervisor({
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    terminationTimeoutMs: 1,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      if (command === TASKKILL_PATH) {
        const killer = new FakeChild(98_766)
        queueMicrotask(() => killer.exit(1, null))
        return killer
      }
      owned = new FakeChild(98_764)
      return owned
    },
  })
  supervisor.spawn('C:\\node.exe', ['vite.js'])
  await assert.rejects(supervisor.stopAll(), /taskkill failed|cleanup incomplete/)
  assert.equal(calls.filter(call => call.command === TASKKILL_PATH).length >= 1, true)
  assert.deepEqual(owned.killSignals, ['SIGKILL'])
})

test('Windows root-only fallback remains incomplete after the exact root exits', async () => {
  const calls = []
  let owned
  const supervisor = createChildSupervisor({
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    terminationTimeoutMs: 1,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      if (command === TASKKILL_PATH) {
        const killer = new FakeChild(98_767)
        queueMicrotask(() => killer.exit(0, null))
        return killer
      }
      owned = new FakeChild(98_765)
      return owned
    },
  })
  supervisor.spawn('C:\\node.exe', ['vite.js'])
  await assert.rejects(supervisor.stopAll(), error => error instanceof AggregateError
    && error.errors.some(item => item?.code === 'PROCESS_TREE_CLEANUP_INCOMPLETE'))
  assert.equal(calls.filter(call => call.command === TASKKILL_PATH).length >= 2, true)
  assert.deepEqual(owned.killSignals, ['SIGKILL'])
})

test('Windows cleanup never targets an unrelated PID', async () => {
  const calls = []
  const unrelated = new FakeChild(98_765)
  let owned
  const supervisor = createChildSupervisor({
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    terminationTimeoutMs: 1,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      const child = new FakeChild(command === TASKKILL_PATH ? 98_766 : 98_764)
      if (command === TASKKILL_PATH) {
        queueMicrotask(() => {
          child.exit(0, null)
          if (args.includes('/f')) owned?.exit(0, null)
        })
      } else {
        owned = child
      }
      return child
    },
  })
  owned = supervisor.spawn('C:\\node.exe', ['vite.js'])
  await supervisor.stopAll()
  assert.equal(calls.filter(call => call.command === TASKKILL_PATH).every(call => call.args[1] !== String(unrelated.pid)), true)
  assert.deepEqual(unrelated.killSignals, [])
})

test('Windows cleanup does not force a child that exits during the graceful tree wait', async () => {
  const calls = []
  let owned
  const supervisor = createChildSupervisor({
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    terminationTimeoutMs: 50,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      const killer = new FakeChild(9000)
      if (command === TASKKILL_PATH) queueMicrotask(() => { owned.kill('graceful'); killer.exit(0, null) })
      return killer
    },
  })
  owned = supervisor.spawn('C:\\node.exe', ['vite.js'])
  await supervisor.stopAll()
  assert.deepEqual(calls.filter(call => call.command === TASKKILL_PATH).map(call => call.args), [['/pid', String(owned.pid), '/t']])
  assert.deepEqual(owned.killSignals, ['graceful'])
})

test('detached POSIX cleanup signals the owned process group gracefully and does not force an exiting child', async () => {
  const signals = []
  const owned = new FakeChild(5432)
  const supervisor = createChildSupervisor({
    platform: 'linux',
    terminationTimeoutMs: 20,
    processKill: (pid, signal) => {
      signals.push([pid, signal])
      owned.kill(signal)
    },
    spawnImpl: () => owned,
  })
  supervisor.spawn('/usr/bin/node', ['vite.js'])
  await supervisor.stopAll()
  assert.deepEqual(signals, [[-5432, 'SIGTERM']])
  assert.deepEqual(owned.killSignals, ['SIGTERM'])
})

test('detached POSIX cleanup forces the owned process group only after the graceful timeout', async () => {
  const signals = []
  const owned = new FakeChild(6543)
  const supervisor = createChildSupervisor({
    platform: 'linux',
    terminationTimeoutMs: 5,
    processKill: (pid, signal) => {
      signals.push([pid, signal])
      if (signal === 'SIGKILL') owned.kill(signal)
    },
    spawnImpl: () => owned,
  })
  supervisor.spawn('/usr/bin/node', ['vite.js'])
  await supervisor.stopAll()
  assert.deepEqual(signals, [[-6543, 'SIGTERM'], [-6543, 'SIGKILL']])
  assert.deepEqual(owned.killSignals, ['SIGKILL'])
})

test('child supervisor preserves per-child abort signals and drains the exact owned tree', async () => {
  const calls = []
  const listeners = new Set()
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, listener) { if (type === 'abort') listeners.add(listener) },
    removeEventListener(type, listener) { if (type === 'abort') listeners.delete(listener) },
    abort(reason) {
      this.aborted = true
      this.reason = reason
      for (const listener of [...listeners]) listener()
    },
  }
  let owned
  const supervisor = createChildSupervisor({
    platform: 'linux',
    terminationTimeoutMs: 5,
    processKill: (pid, signalValue) => {
      calls.push([pid, signalValue])
      if (signalValue === 'SIGKILL') owned.kill(signalValue)
    },
    spawnImpl: (_command, _args, options) => {
      calls.push({ options })
      owned = new FakeChild(7655)
      return owned
    },
  })
  supervisor.spawn('/usr/bin/node', ['vite.js'], { signal })
  assert.equal(calls[0].options.signal, signal)
  signal.abort(new Error('child canceled'))
  // Observe abort-driven cleanup without initiating it via stopAll(). Busy CI
  // runners may schedule the graceful timeout after a fixed 20ms assertion.
  const deadline = Date.now() + 2_000
  while (supervisor.children.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.deepEqual(calls.filter(call => Array.isArray(call)), [
    [-7655, 'SIGTERM'],
    [-7655, 'SIGKILL'],
  ])
  assert.equal(listeners.size, 0)
  assert.equal(supervisor.children.length, 0)
  await supervisor.stopAll()
})

test('cleanup continues to force an owned child after a child error', async () => {
  const child = new FakeChild(7654)
  const supervisor = createChildSupervisor({
    platform: 'linux',
    terminationTimeoutMs: 5,
    processKill: () => { throw new Error('detached group unavailable') },
    spawnImpl: () => child,
  })
  supervisor.spawn('/usr/bin/node', ['vite.js'])
  child.emit('error', new Error('spawn failed'))
  await supervisor.stopAll()
  assert.deepEqual(child.killSignals, ['SIGTERM'])
})

test('supervisor retains an errored child through close until cleanup drains the owner', async () => {
  const child = new EventEmitter()
  child.pid = 7653
  child.exitCode = null
  child.signalCode = null
  const supervisor = createChildSupervisor({ platform: 'linux', terminationTimeoutMs: 5, spawnImpl: () => child })
  const owned = supervisor.spawn('node', [])
  const waiting = supervisor.waitForChild(owned)
  child.emit('error', new Error('spawn failed'))
  await assert.rejects(waiting, /spawn failed/)
  child.emit('close', 1, null)
  assert.equal(supervisor.children.length, 1)
  await supervisor.stopAll()
  assert.equal(supervisor.children.length, 0)
})

test('POSIX cleanup retains the exact process group after root exit until graceful and force phases drain it', async () => {
  const signals = []
  const root = new FakeChild(8123)
  const supervisor = createChildSupervisor({
    platform: 'linux',
    terminationTimeoutMs: 5,
    processKill: (pid, signal) => { signals.push([pid, signal]) },
    spawnImpl: () => root,
  })
  supervisor.spawn('/usr/bin/node', ['vite.js'])
  root.exitCode = 0
  root.emit('exit', 0, null)
  root.emit('close', 0, null)
  root.pid = 9999

  assert.equal(supervisor.children.length, 1)
  await supervisor.stopAll()

  assert.deepEqual(signals, [[-8123, 'SIGTERM'], [-8123, 'SIGKILL']])
  assert.equal(supervisor.children.length, 0)
})

test('successful completed roots can be released without unsafe post-exit taskkill', async () => {
  const calls = []
  const root = new FakeChild(9_234)
  const supervisor = createChildSupervisor({
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      return root
    },
  })
  const child = supervisor.spawn('C:\\node.exe', ['build'])
  root.exit(0, null)
  assert.equal(supervisor.releaseCompletedRoot(child, { oneShot: true, descendants: 'none' }), true)
  await supervisor.stopAll()
  assert.equal(calls.some(call => call.command === TASKKILL_PATH), false)
})

test('Windows cleanup loses identity after root exit and never taskkills the reused PID', async () => {
  const calls = []
  const root = new FakeChild(9234)
  const unrelated = new FakeChild(10_234)
  const supervisor = createChildSupervisor({
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    terminationTimeoutMs: 5,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      const killer = new FakeChild(10_001)
      if (command === TASKKILL_PATH) queueMicrotask(() => killer.exit(0, null))
      return command === TASKKILL_PATH ? killer : root
    },
  })
  supervisor.spawn('C:\\node.exe', ['vite.js'])
  root.exitCode = 0
  root.emit('exit', 0, null)
  root.emit('close', 0, null)
  root.pid = unrelated.pid

  assert.equal(supervisor.children.length, 1)
  await assert.rejects(supervisor.stopAll(), /identity lost/)
  assert.equal(calls.filter(call => call.command === TASKKILL_PATH).length, 0)
  assert.deepEqual(unrelated.killSignals, [])
  assert.equal(supervisor.children.length, 0)
})

test('HTTP readiness rejects non-HTTP(S) and non-loopback planned URLs', async () => {
  await assert.rejects(
    waitForHttp('ftp://127.0.0.1:5173/', { fetchImpl: async () => ({ ok: true, status: 200, url: 'ftp://127.0.0.1:5173/' }) }),
    /http or https on loopback/,
  )
  await assert.rejects(
    waitForHttp('http://localhost:5173/', { fetchImpl: async () => ({ ok: true, status: 200, url: 'http://localhost:5173/' }) }),
    /http or https on loopback/,
  )
})

test('HTTP readiness rejects a redirect even when the final URL is otherwise healthy', async () => {
  await assert.rejects(
    waitForHttp('http://127.0.0.1:5173/', {
      timeoutMs: 8,
      intervalMs: 1,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        redirected: true,
        url: 'http://127.0.0.1:5173/',
        text: async () => '<div id="root"></div>',
      }),
    }),
    /followed a redirect/,
  )
})

test('HTTP readiness rejects a healthy response whose final URL mismatches the planned endpoint', async () => {
  await assert.rejects(
    waitForHttp('http://127.0.0.1:5173/', {
      timeoutMs: 8,
      intervalMs: 1,
      expectedContent: '<div id="root">',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        redirected: false,
        url: 'http://127.0.0.1:5174/',
        text: async () => '<div id="root"></div>',
      }),
    }),
    /URL does not match the planned endpoint/,
  )
})

test('HTTP readiness polling rejects Vite 404 instead of treating a fallback page as ready', async () => {
  let calls = 0
  await assert.rejects(
    waitForHttp('http://127.0.0.1:5173', {
      timeoutMs: 8,
      intervalMs: 1,
      fetchImpl: async () => {
        calls += 1
        return { ok: false, status: 404, url: 'http://127.0.0.1:5173/' }
      },
    }),
    /unhealthy HTTP 404/,
  )
  assert.equal(calls >= 1, true)
})

test('HTTP readiness can require renderer marker content in a healthy 200 response', async () => {
  const response = await waitForHttp('http://127.0.0.1:5173/', {
    expectedContent: ['<div id="root">', 'type="module"'],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'http://127.0.0.1:5173/',
      text: async () => '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    }),
  })
  assert.equal(response.status, 200)
})

test('HTTP readiness rejects a healthy response that is not the DSH renderer', async () => {
  await assert.rejects(
    waitForHttp('http://127.0.0.1:5173/', {
      timeoutMs: 8,
      intervalMs: 1,
      expectedContent: ['name="dsh-desktop-renderer"'],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'http://127.0.0.1:5173/',
        text: async () => '<html><body>another app</body></html>',
      }),
    }),
    /missing the renderer marker/,
  )
})
