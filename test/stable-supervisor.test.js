import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DevSupervisor } from '../src/runtime/dev-supervisor.js'
import { repairStaleTaskBoardLock, StableSupervisor } from '../src/runtime/stable-supervisor.js'
import { deferred, envValue, fakeSpawner, nextTurn, TASKKILL_PATH } from '../test-support/runtime-process-fakes.js'

test('Stable and Dev runtime envs merge partial DSH_HOME without routing injection', async () => {
  const basePath = envValue(process.env, 'PATH')
  const baseSystemRoot = envValue(process.env, 'SystemRoot')
  const stableFake = fakeSpawner()
  const stable = new StableSupervisor({
    entry: '/release/dsh.js',
    profilePath: '/release/profiles/stable',
    physicalProfileName: 'stable',
    releaseId: 'release-1',
    command: '/node',
    env: {
      DSH_HOME: '/attacker/home',
      PATH: '/attacker/path',
      SystemRoot: 'C:\\attacker',
      NODE_OPTIONS: '--require attacker.js',
      NODE_PATH: '/attacker/node-path',
    },
    portAllocator: () => 43_226,
    readyAdapter: ({ expectedOrigin }) => `${expectedOrigin}/`,
    spawnImpl: stableFake.spawnImpl,
    processKill: stableFake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await stable.start()
  const stableEnv = stableFake.calls[0].options.env
  assert.equal(envValue(stableEnv, 'PATH'), basePath)
  assert.equal(envValue(stableEnv, 'SystemRoot'), baseSystemRoot)
  assert.notEqual(envValue(stableEnv, 'NODE_OPTIONS'), '--require attacker.js')
  assert.notEqual(envValue(stableEnv, 'NODE_PATH'), '/attacker/node-path')
  assert.equal(stableEnv.DSH_HOME, '/release')
  await stable.stop()

  const devFake = fakeSpawner()
  const dev = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => ({ path: '/dsh-source', pin: 'a'.repeat(40) }),
    host: {
      command: '/node',
      entry: '/dsh-source/apps/host.js',
      env: { DSH_HOME: '/attacker/host', PATH: '/attacker/host-path', NODE_OPTIONS: '--require host.js' },
      readyAdapter: () => 'http://127.0.0.1:45123/',
      expectedOrigin: 'http://127.0.0.1:45123',
    },
    watcher: {
      command: '/pnpm',
      args: ['run', 'dev:web'],
      env: { DSH_HOME: '/attacker/watcher', SystemRoot: 'C:\\attacker', NODE_PATH: '/attacker/watcher-node-path' },
      readyAdapter: () => 'http://127.0.0.1:5173/',
      expectedOrigin: 'http://127.0.0.1:5173',
    },
    spawnImpl: devFake.spawnImpl,
    processKill: devFake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await dev.start()
  const watcherEnv = devFake.calls[0].options.env
  const hostEnv = devFake.calls[1].options.env
  for (const environment of [hostEnv, watcherEnv]) {
    assert.equal(envValue(environment, 'PATH'), basePath)
    assert.equal(envValue(environment, 'SystemRoot'), baseSystemRoot)
  }
  assert.notEqual(envValue(hostEnv, 'NODE_OPTIONS'), '--require host.js')
  assert.notEqual(envValue(watcherEnv, 'NODE_PATH'), '/attacker/watcher-node-path')
  await dev.stop()
})

test('Stable and Dev supervisors preserve the desktop-owned toolchain from their trusted base', async () => {
  const trustedBaseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
  )
  trustedBaseEnv.PATH = '/desktop/toolchain:/system/bin'
  const stable = new StableSupervisor({
    entry: '/release/dsh.js',
    profilePath: '/release/profiles/stable',
    physicalProfileName: 'stable',
    releaseId: 'release-toolchain',
    command: '/node',
    trustedBaseEnv,
    env: { PATH: '/untrusted/path' },
  })
  assert.equal(envValue(stable.buildInvocation(43_226).env, 'PATH'), '/desktop/toolchain:/system/bin')

  const dev = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'b'.repeat(40),
    checkoutIdentity: () => ({ path: '/dsh-source', pin: 'b'.repeat(40) }),
    trustedBaseEnv,
    host: {
      command: '/node',
      entry: '/dsh-source/apps/host.js',
      env: { PATH: '/untrusted/host' },
      readyAdapter: () => 'http://127.0.0.1:45123/',
    },
    watcher: {
      command: '/pnpm',
      args: ['run', 'dev:web'],
      env: { PATH: '/untrusted/watcher' },
    },
    platform: 'linux',
  })
  assert.equal(envValue(dev.hostEnv, 'PATH'), '/desktop/toolchain:/system/bin')
  assert.equal(envValue(dev.watcherEnv, 'PATH'), '/desktop/toolchain:/system/bin')
})

test('StableSupervisor requests the fixed desktop port and uses the exact physical profile', async () => {
  const fake = fakeSpawner()
  let allocationRequest
  const supervisor = new StableSupervisor({
    entry: '/release/dsh/lib/bin.js',
    profilePath: '/release/profiles/physical-stable',
    physicalProfileName: 'physical-stable',
    releaseId: 'release-2026.08',
    command: '/node',
    portAllocator: request => {
      allocationRequest = request
      return request.port
    },
    readyAdapter: ({ expectedOrigin }) => `${expectedOrigin}/`,
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const url = await supervisor.start()
  assert.equal(url, 'http://127.0.0.1:3080/')
  assert.equal(allocationRequest.host, '127.0.0.1')
  assert.equal(allocationRequest.port, 3080)
  assert.equal(allocationRequest.random, false)
  assert.equal(fake.calls.length, 1)
  assert.deepEqual(fake.calls[0].args.slice(0, 4), ['/release/dsh/lib/bin.js', '--profile', 'physical-stable', '--port'])
  assert.equal(fake.calls[0].args.includes('3080'), true)
  assert.equal(fake.calls[0].options.shell, false)
  assert.equal(supervisor.status().state, 'ready')
  await supervisor.stop()
  assert.equal(supervisor.status().state, 'stopped')
})

test('StableSupervisor preserves a tokenized DSH readiness URL for BrowserAuth', async () => {
  const fake = fakeSpawner()
  const supervisor = new StableSupervisor({
    entry: '/release/dsh/lib/bin.js',
    profilePath: '/release/profiles/physical-stable',
    physicalProfileName: 'physical-stable',
    releaseId: 'release-tokenized-readiness',
    command: '/node',
    portAllocator: () => 43_228,
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })

  const starting = supervisor.start()
  await nextTurn()
  fake.children[0].stdout.write('dsh web: http://127.0.0.1:43228/?token=browser-session-token\n')
  assert.equal(await starting, 'http://127.0.0.1:43228/?token=browser-session-token')
  assert.equal(supervisor.status().url, 'http://127.0.0.1:43228/?token=browser-session-token')
  await supervisor.stop()
})

test('StableSupervisor terminates the verified Windows Host tree in one forced request', async () => {
  const fake = fakeSpawner({ platform: 'win32' })
  const supervisor = new StableSupervisor({
    entry: 'C:\\release\\dsh\\lib\\bin.js',
    profilePath: 'C:\\release\\profiles\\physical-stable',
    physicalProfileName: 'physical-stable',
    releaseId: 'release-windows-restart',
    command: 'C:\\electron.exe',
    portAllocator: () => 43_227,
    readyAdapter: ({ expectedOrigin }) => `${expectedOrigin}/`,
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    terminationTimeoutMs: 5,
  })

  await supervisor.start()
  await supervisor.stop()
  const taskkills = fake.calls.filter(call => call.command === TASKKILL_PATH)
  assert.equal(taskkills.length, 1)
  assert.deepEqual(taskkills[0].args.slice(-2), ['/t', '/f'])
})

test('stable startup retires only a task-board lock whose recorded PID is absent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-board-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'task-board')
  const lockPath = join(directory, 'ledger-v2.lock')
  const payload = JSON.stringify({ pid: 48284, token: 'verified-lock-token', startedAt: 123, probe: 'exact' })
  await mkdir(directory)
  await writeFile(lockPath, payload)

  const repaired = await repairStaleTaskBoardLock({
    profileHome: root,
    platform: 'win32',
    pidProbe: () => false,
    nonce: () => 'test-nonce',
  })
  assert.equal(repaired.status, 'repaired')
  assert.equal(await readFile(repaired.retiredPath, 'utf8'), payload)
  await assert.rejects(readFile(lockPath, 'utf8'), error => error?.code === 'ENOENT')

  await writeFile(lockPath, payload)
  const live = await repairStaleTaskBoardLock({
    profileHome: root,
    platform: 'win32',
    pidProbe: () => true,
    nonce: () => 'unused',
  })
  assert.deepEqual(live, { status: 'live', pid: 48284 })
  assert.equal(await readFile(lockPath, 'utf8'), payload)
})

test('StableSupervisor places runtime flags before the DSH entry', async () => {
  const fake = fakeSpawner()
  const supervisor = new StableSupervisor({
    entry: '/release/dsh/lib/bin.js',
    runtimeArgs: ['--expose-internals'],
    profilePath: '/release/profiles/physical-stable',
    physicalProfileName: 'physical-stable',
    releaseId: 'release-2026.08',
    command: '/node',
    portAllocator: () => 43_220,
    readyAdapter: ({ expectedOrigin }) => `${expectedOrigin}/`,
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await supervisor.start()
  assert.deepEqual(fake.calls[0].args.slice(0, 5), ['--expose-internals', '/release/dsh/lib/bin.js', '--profile', 'physical-stable', '--port'])
  assert.equal(fake.calls[0].args.includes('--no-open'), true)
  await supervisor.stop()
})

test('StableSupervisor places desktop patch overlays before web application arguments', () => {
  const supervisor = new StableSupervisor({
    entry: '/release/dsh/lib/bin.js',
    profilePath: '/release/profiles/physical-stable',
    physicalProfileName: 'physical-stable',
    releaseId: 'release-2026.08',
    command: '/node',
    patches: ['/desktop/dsh-desktop.patch.yml'],
  })
  const invocation = supervisor.buildInvocation(43_221)
  assert.deepEqual(invocation.args.slice(0, 9), [
    '/release/dsh/lib/bin.js',
    '--profile',
    'physical-stable',
    '--patch',
    '/desktop/dsh-desktop.patch.yml',
    '--port',
    '43221',
    '--no-open',
  ])
})

test('StableSupervisor runs the packaged Electron command in Node mode', () => {
  const supervisor = new StableSupervisor({
    command: '/electron',
    entry: '/release/dsh/lib/bin.js',
    profilePath: '/release/profiles/physical-stable',
    physicalProfileName: 'physical-profile',
    releaseId: 'release-1',
    profileHome: '/release/home',
  })
  const invocation = supervisor.buildInvocation(43211)
  assert.equal(invocation.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(invocation.env.DSH_DESKTOP, '1')
  assert.equal(invocation.env.DSH_HOME, '/release/home')
  assert.equal(invocation.env.DSH_PROFILE_DIR, '/release/profiles/physical-stable')
})

test('StableSupervisor rejects every DSH profile/port override spelling and selector', () => {
  const base = {
    entry: '/release/dsh.js',
    profilePath: '/release/profiles/stable',
    physicalProfileName: 'stable',
    releaseId: 'release-1',
    command: '/node',
  }
  for (const argument of ['--profile', '--profile=other', '--port', '--port=3080', 'web', 'plugin']) {
    assert.throws(
      () => new StableSupervisor({ ...base, extraArgs: [argument] }),
      /profile\/port overrides/,
      argument,
    )
  }
})

test('StableSupervisor never publishes readiness after a Host exits while readiness is pending', async () => {
  const fake = fakeSpawner()
  const ready = deferred()
  const supervisor = new StableSupervisor({
    entry: '/release/dsh.js',
    profilePath: '/release/profiles/stable',
    physicalProfileName: 'stable',
    releaseId: 'release-1',
    command: '/node',
    portAllocator: () => 43_221,
    readyAdapter: () => ready.promise,
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const starting = supervisor.start()
  await nextTurn()
  fake.children[0].exit(1, null)
  await assert.rejects(starting, /Stable Host exited before readiness/)
  assert.equal(supervisor.status().state, 'failed')
  assert.equal(supervisor.status().url, undefined)
  ready.resolve('http://127.0.0.1:43221/')
  await nextTurn()
  assert.notEqual(supervisor.status().state, 'ready')
})

test('StableSupervisor rejects an early-exit root before storing its handle', async () => {
  const fake = fakeSpawner()
  const spawnImpl = (...args) => {
    const child = fake.spawnImpl(...args)
    child.exit(1, null)
    return child
  }
  const supervisor = new StableSupervisor({
    entry: '/release/dsh.js',
    profilePath: '/release/profiles/stable',
    physicalProfileName: 'stable',
    releaseId: 'release-1',
    command: '/node',
    portAllocator: () => 43_222,
    readyAdapter: () => 'http://127.0.0.1:43222/',
    spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await assert.rejects(supervisor.start(), /Stable Host exited before readiness/)
  assert.equal(supervisor.status().state, 'failed')
  assert.equal(supervisor.status().url, undefined)
})

test('StableSupervisor abort drains its exact Host without requiring adapter cooperation', async () => {
  const fake = fakeSpawner()
  const controller = new AbortController()
  const supervisor = new StableSupervisor({
    entry: '/release/dsh.js',
    profilePath: '/release/profiles/stable',
    physicalProfileName: 'stable',
    releaseId: 'release-1',
    command: '/node',
    portAllocator: () => 43_220,
    readyAdapter: () => new Promise(() => {}),
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const starting = supervisor.start({ signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('cancelled'))
  await assert.rejects(starting, /cancelled/)
  assert.equal(fake.children[0].killSignals.includes('SIGTERM'), true)
})

test('StableSupervisor and DevSupervisor reject cmd, bat, and ps1 shell shims', () => {
  const stable = {
    entry: '/release/dsh.js',
    profilePath: '/release/profiles/stable',
    physicalProfileName: 'stable',
    releaseId: 'release-1',
  }
  for (const command of ['C:\\node.cmd', 'C:\\node.bat', 'C:\\node.ps1']) {
    assert.throws(() => new StableSupervisor({ ...stable, command }), /shell shim/)
  }
  for (const argument of ['tool.cmd', 'tool.bat', 'tool.ps1']) {
    assert.throws(() => new StableSupervisor({ ...stable, extraArgs: [argument] }), /shell shim/)
    assert.throws(() => new DevSupervisor({ checkoutPath: '/dsh', checkoutPin: 'a'.repeat(40), watcher: { command: '/pnpm', args: ['run', 'dev:web', argument] } }), /shell shim/)
  }
})

test('StableSupervisor aborts a never-settling port allocator and terminal stop rejects restart', async () => {
  const fake = fakeSpawner()
  const supervisor = new StableSupervisor({
    entry: '/release/dsh.js',
    profilePath: '/release/profiles/stable',
    physicalProfileName: 'stable',
    releaseId: 'release-1',
    command: '/node',
    portAllocator: () => new Promise(() => {}),
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const starting = supervisor.start()
  await nextTurn()
  await supervisor.stop(new Error('cancel port allocation'))
  await assert.rejects(starting, /cancel port allocation/)
  assert.equal(supervisor.status().state, 'stopped')
  const stopped = supervisor.status()
  await assert.rejects(supervisor.start(), /cannot restart after terminal stop/)
  assert.deepEqual(supervisor.status(), stopped)
  assert.equal(fake.children.length, 0)
})

test('StableSupervisor aborts a never-settling Harness factory and closes a ready adapter exactly once', async () => {
  const fake = fakeSpawner()
  const factoryStarting = new StableSupervisor({
    entry: '/release/dsh.js',
    profilePath: '/release/profiles/stable',
    physicalProfileName: 'stable',
    releaseId: 'release-1',
    command: '/node',
    portAllocator: () => 43_223,
    createHarnessServer: () => new Promise(() => {}),
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const pendingFactory = factoryStarting.start()
  await nextTurn()
  await factoryStarting.stop()
  await assert.rejects(pendingFactory)
  assert.equal(factoryStarting.status().state, 'stopped')

  let closeCalls = 0
  const adapter = {
    start: () => 'http://127.0.0.1:43224/',
    close: () => { closeCalls += 1 },
  }
  const ready = new StableSupervisor({
    entry: '/release/dsh.js',
    profilePath: '/release/profiles/stable',
    physicalProfileName: 'stable',
    releaseId: 'release-1',
    command: '/node',
    portAllocator: () => 43_224,
    readyAdapter: adapter,
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await ready.start()
  await ready.stop()
  await ready.stop()
  assert.equal(closeCalls, 1)
})

test('StableSupervisor closes a ready adapter and exact Host tree after post-ready Host exit', async () => {
  const fake = fakeSpawner()
  let stopCalls = 0
  const adapter = {
    start: () => 'http://127.0.0.1:43225/',
    stop: () => { stopCalls += 1 },
  }
  const supervisor = new StableSupervisor({
    entry: '/release/dsh.js',
    profilePath: '/release/profiles/stable',
    physicalProfileName: 'stable',
    releaseId: 'release-1',
    command: '/node',
    portAllocator: () => 43_225,
    readyAdapter: adapter,
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await supervisor.start()
  const host = fake.children[0]
  host.exit(1, null)
  await nextTurn()
  await nextTurn()
  assert.equal(supervisor.status().state, 'failed')
  assert.equal(stopCalls, 1)
  assert.equal(supervisor.status().host, undefined)
  assert.equal(host.listenerCount('exit'), 0)
  assert.equal(host.listenerCount('close'), 0)
  await supervisor.stop()
  assert.equal(stopCalls, 1)
})

test('StableSupervisor publishes failed cleanup status and closes readiness after owner rejection', async () => {
  const failure = new Error('stable owner cleanup failed')
  const child = { exitCode: null, signalCode: null }
  const handle = {
    child,
    state: 'running',
    descriptor: { role: 'host', generation: 1, ownerNonce: 'stable-owner' },
  }
  const owner = {
    generation: 1,
    spawn: () => handle,
    stopAll: async () => { throw failure },
  }
  let closeCalls = 0
  const statuses = []
  const supervisor = new StableSupervisor({
    entry: '/release/dsh.js',
    profilePath: '/release/profiles/stable',
    physicalProfileName: 'stable',
    releaseId: 'release-1',
    command: '/node',
    portAllocator: () => 43_226,
    readyAdapter: {
      start: () => 'http://127.0.0.1:43226/',
      close: () => { closeCalls += 1 },
    },
    owner,
    onStatus: event => statuses.push(event),
  })
  await supervisor.start()
  await assert.rejects(supervisor.stop(), error => error === failure)
  const status = supervisor.status()
  assert.equal(status.state, 'failed')
  assert.equal(status.unsafe, true)
  assert.equal(status.cleanupError, failure)
  assert.equal(status.host, undefined)
  assert.equal(status.url, undefined)
  assert.equal(status.origin, undefined)
  assert.equal(status.port, undefined)
  assert.equal(closeCalls, 1)
  assert.equal(statuses.at(-1).state, 'failed')
})

test('StableSupervisor surfaces asynchronous tree and adapter cleanup failures after Host exit', async () => {
  const ownerFailure = new Error('stable tree cleanup failed')
  const adapterFailure = new Error('stable adapter close failed')
  const child = { exitCode: null, signalCode: null }
  const handle = {
    child,
    state: 'running',
    descriptor: { role: 'host', generation: 1, ownerNonce: 'stable-owner-async' },
  }
  const owner = new EventEmitter()
  owner.generation = 1
  owner.spawn = () => handle
  owner.stop = async () => { throw ownerFailure }
  owner.stopAll = async () => {}
  const cleanupEvents = []
  const supervisor = new StableSupervisor({
    entry: '/release/dsh.js',
    profilePath: '/release/profiles/stable',
    physicalProfileName: 'stable',
    releaseId: 'release-1',
    command: '/node',
    portAllocator: () => 43_227,
    readyAdapter: {
      start: () => 'http://127.0.0.1:43227/',
      close: async () => { throw adapterFailure },
    },
    owner,
  })
  supervisor.on('cleanup-error', event => cleanupEvents.push(event))
  await supervisor.start()
  owner.emit('status', {
    role: 'host',
    state: 'failed',
    descriptor: handle.descriptor,
    current: true,
    stale: false,
    error: new Error('stable Host exited'),
  })
  await nextTurn()
  await nextTurn()
  const status = supervisor.status()
  assert.equal(status.state, 'failed')
  assert.equal(status.unsafe, true)
  assert.equal(status.cleanupError instanceof AggregateError, true)
  assert.equal(status.cleanupError.errors.includes(ownerFailure), true)
  assert.equal(status.cleanupError.errors.includes(adapterFailure), true)
  assert.equal(cleanupEvents.some(event => event.error === ownerFailure), true)
  assert.equal(cleanupEvents.some(event => event.error === adapterFailure), true)
  await assert.rejects(supervisor.stop())
})
