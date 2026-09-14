import assert from 'node:assert/strict'
import test from 'node:test'
import { OwnedProcessTree } from '../src/runtime/process-owner.js'
import { TASKKILL_PATH, fakeSpawner, nextTurn } from '../test-support/runtime-process-fakes.js'

test('OwnedProcessTree records immutable roots and ignores stale generation exits', async () => {
  const fake = fakeSpawner()
  let now = 100
  let nonce = 0
  const owner = new OwnedProcessTree({
    generation: 1,
    clock: () => now++,
    nonce: () => `nonce-${++nonce}`,
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const first = owner.spawn('host', '/node', ['/old.js'], { cwd: '/old' })
  owner.beginGeneration()
  const second = owner.spawn('host', '/node', ['/new.js'], { cwd: '/new' })
  assert.equal(Object.isFrozen(first.descriptor), true)
  assert.equal(Object.isFrozen(first.descriptor.args), true)
  assert.deepEqual(first.descriptor, {
    role: 'host', command: '/node', args: ['/old.js'], cwd: '/old', pid: 10_000,
    startTime: 100, ownerNonce: 'nonce-1', generation: 1,
  })
  fake.children[0].exit(1, null)
  assert.equal(owner.status('host').descriptor, second.descriptor)
  assert.equal(owner.status('host').state, 'running')
  await owner.stopAll()
  assert.deepEqual(fake.children.map(child => child.killSignals), [['SIGTERM', 'SIGKILL'], ['SIGTERM']])
  assert.equal(owner.descriptors.length, 2)
})

test('OwnedProcessTree rejects partial and forged descriptor identities consistently', async () => {
  const fake = fakeSpawner()
  const owner = new OwnedProcessTree({
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const handle = owner.spawn('host', '/node', ['/host.js'], { cwd: '/safe' })
  const descriptor = handle.descriptor

  assert.equal(owner.owns({ role: 'host', generation: descriptor.generation }), false)
  assert.equal(owner.status({ role: 'host', generation: descriptor.generation }), undefined)
  assert.equal(await owner.stop({ role: 'host', generation: descriptor.generation }), false)
  assert.equal(handle.state, 'running')
  assert.equal(owner.owns({ ...descriptor, pid: descriptor.pid + 1 }), false)
  assert.equal(await owner.stop({ ...descriptor, ownerNonce: 'forged' }), false)
  assert.equal(handle.state, 'running')

  assert.equal(owner.owns(descriptor), true)
  assert.equal(owner.status(descriptor).descriptor, descriptor)
  await owner.stop(handle)
})

test('OwnedProcessTree keeps authoritative spawn fields ahead of optional attacker options', async () => {
  const fake = fakeSpawner()
  const owner = new OwnedProcessTree({
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const handle = owner.spawn({
    role: 'host',
    command: '/safe/node',
    args: ['/safe/entry.js'],
    cwd: '/safe/checkout',
     stdio: ['ignore', 'pipe', 'pipe'],
     // These policy seams are intentionally ignored when supplied per root.
     spawnImpl: () => { throw new Error('per-root spawner must not run') },
     processKill: () => { throw new Error('per-root killer must not run') },
     signalImpl: () => { throw new Error('per-root signal adapter must not run') },
     platform: 'win32',
     terminationTimeoutMs: 99_999,
     windowsHide: true,

    stdio: ['ignore', 'pipe', 'pipe'],
    spawnOptions: {
      cwd: '/attacker',
      shell: true,
      detached: false,
      stdio: 'inherit',
      command: '/attacker/node',
      args: ['--evil'],
    },
  })
  const invocation = fake.calls[0]
  assert.equal(invocation.command, '/safe/node')
  assert.deepEqual(invocation.args, ['/safe/entry.js'])
  assert.equal(invocation.options.cwd, '/safe/checkout')
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.detached, true)
  assert.deepEqual(invocation.options.stdio, ['ignore', 'pipe', 'pipe'])
  await owner.stop(handle)
})

test('OwnedProcessTree ignores nested spawnOptions.env while preserving a caller AbortSignal', async () => {
  const fake = fakeSpawner()
  const controller = new AbortController()
  const owner = new OwnedProcessTree({
    env: { NODE_OPTIONS: '--require /owner/safe.js', DSH_OWNER: '1' },
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const handle = owner.spawn({
    role: 'env-regression',
    command: '/node',
    args: ['/safe/entry.js'],
    env: { NODE_OPTIONS: '--require /spec/safe.js', DSH_SPEC: '1' },
    signal: controller.signal,
    spawnOptions: {
      env: { NODE_OPTIONS: '--require /outside/evil.js', DSH_ATTACKER: '1' },
      signal: controller.signal,
    },
  })
  assert.equal(fake.calls[0].options.env.NODE_OPTIONS, '--require /spec/safe.js')
  assert.equal(fake.calls[0].options.env.DSH_ATTACKER, undefined)
  assert.equal(fake.calls[0].options.signal, controller.signal)
  await owner.stop(handle)
})

test('OwnedProcessTree rechecks an abort after listener attach when spawn aborts synchronously', async () => {
  const fake = fakeSpawner()
  const controller = new AbortController()
  let child
  const owner = new OwnedProcessTree({
    spawnImpl: (_command, _args, options) => {
      child = fake.spawnImpl(_command, _args, options)
      controller.abort(new Error('spawn-time abort'))
      return child
    },
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const handle = owner.spawn({ role: 'abort-race', command: '/node', args: ['/entry.js'], signal: controller.signal })
  await nextTurn()
  await nextTurn()
  assert.equal(child.killSignals.includes('SIGTERM'), true)
  assert.equal(handle.state, 'stopped')
  await owner.stopAll()
})

test('OwnedProcessTree detaches child listeners and bounds descriptor/status history', async () => {
  const fake = fakeSpawner()
  const owner = new OwnedProcessTree({
    historyLimit: 2,
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const handles = []
  for (let index = 0; index < 6; index += 1) {
    const handle = owner.spawn('watcher', '/node', [`/watcher-${String(index)}.js`], { cwd: '/safe' })
    handles.push(handle)
    await owner.stop(handle)
    const child = fake.children.at(-1)
    assert.equal(child.listenerCount('exit'), 0)
    assert.equal(child.listenerCount('close'), 0)
    assert.equal(child.listenerCount('error'), 0)
    assert.equal(child.stdout.listenerCount('data'), 0)
    assert.equal(child.stderr.listenerCount('data'), 0)
  }
  assert.equal(owner.descriptors.length <= 2, true)
  assert.equal(owner.statusSnapshot().roots.length <= 2, true)
  assert.equal(owner.statusHistory.length <= 2, true)
  assert.equal(owner.owns(handles[0]), false)
  assert.equal(owner.owns(handles.at(-1)), true)
})

test('OwnedProcessTree globally bounds cleaned current records across unique roles', async () => {
  const fake = fakeSpawner()
  const owner = new OwnedProcessTree({
    historyLimit: 2,
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const handles = []
  for (let index = 0; index < 100; index += 1) {
    const role = `unique-role-${String(index)}`
    const handle = owner.spawn(role, '/node', [`/${role}.js`], { cwd: '/safe' })
    handles.push(handle)
    await owner.stop(handle)
  }
  assert.equal(owner.descriptors.length, 2)
  assert.equal(owner.statusSnapshot().roots.length, 2)
  assert.equal(owner.status('unique-role-0'), undefined)
  assert.equal(owner.owns(handles[0]), false)
  assert.equal(owner.status('unique-role-99')?.state, 'stopped')
  assert.equal(owner.owns(handles.at(-1)), true)
})

test('OwnedProcessTree coalesces a double restart to one exact replacement root', async () => {
  const fake = fakeSpawner()
  const owner = new OwnedProcessTree({
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
    nonce: (() => { let index = 0; return () => `restart-${++index}` })(),
  })
  owner.spawn('watcher', '/node', ['/old.js'], { cwd: '/checkout' })
  const first = owner.restart('watcher', '/node', ['/new.js'], { cwd: '/checkout' })
  const second = owner.restart('watcher', '/node', ['/new.js'], { cwd: '/checkout' })
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.descriptor.ownerNonce, b.descriptor.ownerNonce)
  assert.equal(a.descriptor.generation, 2)
  assert.equal(fake.calls.length, 2)
  await owner.stopAll()
})

test('OwnedProcessTree coalesces overlapping Windows watcher restarts to one exact tree', async () => {
  const fake = fakeSpawner({ platform: 'win32' })
  const owner = new OwnedProcessTree({
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    terminationTimeoutMs: 1,
  })
  const original = owner.spawn('watcher', 'C:\\node.exe', ['watcher.js'])
  const first = owner.restart('watcher', 'C:\\node.exe', ['watcher.js'])
  const second = owner.restart('watcher', 'C:\\node.exe', ['watcher.js'])
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.descriptor.ownerNonce, b.descriptor.ownerNonce)
  assert.equal(a.descriptor.generation, original.descriptor.generation + 1)
  const taskkills = fake.calls.filter(call => call.command === TASKKILL_PATH)
  assert.equal(taskkills.length >= 2, true)
  assert.equal(taskkills.every(call => call.args[1] === String(original.pid)), true)
  await owner.stopAll()
})

test('OwnedProcessTree keeps an already-exited Windows root unverified without retargeting its PID', async () => {
  const fake = fakeSpawner({ platform: 'win32' })
  const owner = new OwnedProcessTree({
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    terminationTimeoutMs: 1,
  })
  const handle = owner.spawn('host', 'C:\\node.exe', ['host.js'])
  fake.children[0].exit(1, null)
  await nextTurn()
  assert.equal(handle.cleanupState, 'root-exited/descendants-unverified')
  assert.equal(handle.owner.descendantsVerified, false)
  await assert.rejects(owner.stopAll(), /identity lost/)
  assert.equal(fake.calls.some(call => call.command === TASKKILL_PATH), false)
  assert.equal(owner.descriptors.length, 1)
})

test('OwnedProcessTree keeps both zero and nonzero unexpected Windows exits unverified', async () => {
  for (const code of [0, 1]) {
    const fake = fakeSpawner({ platform: 'win32' })
    const owner = new OwnedProcessTree({
      spawnImpl: fake.spawnImpl,
      processKill: fake.processKill,
      platform: 'win32',
      taskkillPath: TASKKILL_PATH,
      terminationTimeoutMs: 1,
    })
    const handle = owner.spawn(`host-${String(code)}`, 'C:\\node.exe', ['host.js'])
    fake.children[0].exit(code, null)
    await nextTurn()

    assert.equal(handle.cleanupState, 'root-exited/descendants-unverified')
    assert.equal(handle.owner.descendantsVerified, false)
    assert.equal(owner.statusSnapshot().unsafe, true)
    assert.throws(() => owner.spawn(`host-${String(code)}`, 'C:\\node.exe', ['host.js']), /unsafe/)
    await assert.rejects(owner.stopAll(), /identity lost/)
    assert.equal(fake.calls.some(call => call.command === TASKKILL_PATH), false)
    assert.equal(owner.descriptors.length, 1)
  }
})

test('OwnedProcessTree increments role generations independently and ignores stale watcher exits', async () => {
  const fake = fakeSpawner()
  const owner = new OwnedProcessTree({
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const host = owner.spawn('host', '/node', ['/host.js'])
  const watcher = owner.spawn('watcher', '/node', ['/watcher.js'])
  const replacement = await owner.restart('watcher', '/node', ['/watcher.js'])
  assert.equal(host.descriptor.generation, 1)
  assert.equal(watcher.descriptor.generation, 1)
  assert.equal(replacement.descriptor.generation, 2)
  assert.equal(owner.status('host').descriptor, host.descriptor)
  assert.equal(owner.status('host').state, 'running')
  fake.children[1].exit(1, null)
  assert.equal(owner.status('watcher').descriptor, replacement.descriptor)
  assert.equal(owner.status('watcher').state, 'running')
  assert.equal(owner.owns(host.descriptor), true)
  assert.equal(owner.owns({ ...host.descriptor, generation: 2 }), false)
  await owner.stopAll()
})
