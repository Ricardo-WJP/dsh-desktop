import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { DevSupervisor, internals as devInternals } from '../src/runtime/dev-supervisor.js'
import { FakeChild, TASKKILL_PATH, deferred, fakeSpawner, nextTurn } from '../test-support/runtime-process-fakes.js'

test('Dev checkout containment resolves paths with platform-specific case rules', () => {
  assert.equal(devInternals.within('/checkout', '/checkout/src/app.js', 'linux'), true)
  assert.equal(devInternals.within('/checkout', '/Checkout/src/app.js', 'linux'), false)
  assert.equal(devInternals.within('/checkout', '/checkout/../sibling', 'linux'), false)
  assert.equal(devInternals.within('/checkout', '/checkout-next/app.js', 'linux'), false)
  assert.equal(devInternals.within('C:\\Checkout', 'c:\\checkout\\src\\app.js', 'win32'), true)
  assert.equal(devInternals.within('C:\\Checkout', 'C:\\checkout\\..\\sibling', 'win32'), false)
  assert.equal(devInternals.within('C:\\Checkout', 'C:\\Checkout-next\\app.js', 'win32'), false)
})

test('DevSupervisor never publishes Host readiness after an exit while readiness is pending', async () => {
  const fake = fakeSpawner()
  const ready = deferred()
  const supervisor = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => ({ path: '/dsh-source', pin: 'a'.repeat(40) }),
    host: {
      command: '/node',
      entry: '/dsh-source/apps/host.js',
      readyAdapter: () => ready.promise,
      expectedOrigin: 'http://127.0.0.1:45123',
    },
    watcher: {
      nodeExecutable: '/node',
      pnpmEntry: '/tools/pnpm.mjs',
      readyAdapter: () => 'http://127.0.0.1:5173/',
      expectedOrigin: 'http://127.0.0.1:5173',
    },
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const starting = supervisor.start()
  await nextTurn()
  fake.children[1].exit(1, null)
  await assert.rejects(starting, /Development Host exited before readiness/)
  assert.equal(supervisor.status().state, 'failed')
  assert.notEqual(supervisor.status().host.state, 'ready')
  ready.resolve('http://127.0.0.1:45123/')
  await nextTurn()
  assert.notEqual(supervisor.status().host.state, 'ready')
})

test('DevSupervisor degrades and cleans up a watcher that exits while readiness is pending', async () => {
  const fake = fakeSpawner()
  const ready = deferred()
  let watcherAborted = false
  const supervisor = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => ({ path: '/dsh-source', pin: 'a'.repeat(40) }),
    host: {
      command: '/node',
      entry: '/dsh-source/apps/host.js',
      readyAdapter: () => 'http://127.0.0.1:45123/',
      expectedOrigin: 'http://127.0.0.1:45123',
    },
    watcher: {
      nodeExecutable: '/node',
      pnpmEntry: '/tools/pnpm.mjs',
      readyAdapter: ({ signal }) => {
        signal.addEventListener('abort', () => {
          watcherAborted = true
          ready.reject(signal.reason)
        }, { once: true })
        return ready.promise
      },
      expectedOrigin: 'http://127.0.0.1:5173',
    },
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await supervisor.start()
  fake.children[0].exit(1, null)
  await nextTurn()
  assert.equal(supervisor.status().host.state, 'ready')
  assert.equal(supervisor.status().watcher.state, 'degraded')
  assert.equal(supervisor.status().state, 'degraded')
  assert.equal(watcherAborted, true)
  ready.resolve('http://127.0.0.1:5173/')
  await nextTurn()
  assert.equal(supervisor.status().watcher.state, 'degraded')
  assert.equal(supervisor.status().watcher.url, undefined)
  await supervisor.stop()
})

test('DevSupervisor degrades an early-exit watcher without publishing it ready', async () => {
  const fake = fakeSpawner()
  let spawnCount = 0
  const spawnImpl = (...args) => {
    const child = fake.spawnImpl(...args)
    if (spawnCount++ === 0) child.exit(1, null)
    return child
  }
  const supervisor = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => ({ path: '/dsh-source', pin: 'a'.repeat(40) }),
    host: {
      command: '/node',
      entry: '/dsh-source/apps/host.js',
      readyAdapter: () => 'http://127.0.0.1:45123/',
      expectedOrigin: 'http://127.0.0.1:45123',
    },
    watcher: {
      nodeExecutable: '/node',
      pnpmEntry: '/tools/pnpm.mjs',
      readyAdapter: () => 'http://127.0.0.1:5173/',
      expectedOrigin: 'http://127.0.0.1:5173',
    },
    spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await supervisor.start()
  assert.equal(supervisor.status().host.state, 'ready')
  assert.equal(supervisor.status().watcher.state, 'degraded')
  assert.equal(supervisor.status().state, 'degraded')
  assert.equal(supervisor.status().watcher.url, undefined)
  await supervisor.stop()
})

test('DevSupervisor preserves a published Host through repeated start and watcher restarts', async () => {
  const fake = fakeSpawner()
  let hostSignal
  const supervisor = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => ({ path: '/dsh-source', pin: 'a'.repeat(40) }),
    host: {
      command: '/node',
      entry: '/dsh-source/apps/host.js',
      readyAdapter: ({ signal }) => {
        hostSignal = signal
        return 'http://127.0.0.1:45123/'
      },
      expectedOrigin: 'http://127.0.0.1:45123',
    },
    watcher: {
      nodeExecutable: '/node',
      pnpmEntry: '/tools/pnpm.mjs',
      readyAdapter: () => 'http://127.0.0.1:5173/',
      expectedOrigin: 'http://127.0.0.1:5173',
    },
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })

  const url = await supervisor.start()
  const host = fake.children[1]
  const publishedDescriptor = supervisor.status().host.descriptor
  fake.children[0].exit(1, null)
  await nextTurn()
  assert.equal(supervisor.status().state, 'degraded')
  assert.equal(supervisor.status().host.state, 'ready')

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(await supervisor.start(), url)
    assert.equal(supervisor.status().host.descriptor, publishedDescriptor)
    assert.equal(host.exitCode, null)
    assert.equal(host.signalCode, null)
    assert.equal(hostSignal?.aborted, false)
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await supervisor.restartWatcher()
    await nextTurn()
    assert.equal(supervisor.status().host.state, 'ready')
    assert.equal(supervisor.status().host.descriptor, publishedDescriptor)
    assert.equal(host.exitCode, null)
    assert.equal(host.signalCode, null)
    if (attempt === 0) {
      const replacement = fake.children.at(-1)
      replacement.exit(1, null)
      await nextTurn()
      assert.equal(supervisor.status().state, 'degraded')
    }
  }
  await supervisor.stop()
})

test('DevSupervisor rejects an early-exit Host before publishing readiness', async () => {
  const fake = fakeSpawner()
  const spawnImpl = (...args) => {
    const child = fake.spawnImpl(...args)
    if (args[1]?.includes('/dsh-source/apps/host.js')) child.exit(1, null)
    return child
  }
  const supervisor = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => ({ path: '/dsh-source', pin: 'a'.repeat(40) }),
    host: {
      command: '/node',
      entry: '/dsh-source/apps/host.js',
      readyAdapter: () => 'http://127.0.0.1:45123/',
      expectedOrigin: 'http://127.0.0.1:45123',
    },
    watcher: {
      nodeExecutable: '/node',
      pnpmEntry: '/tools/pnpm.mjs',
      readyAdapter: () => 'http://127.0.0.1:5173/',
      expectedOrigin: 'http://127.0.0.1:5173',
    },
    spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await assert.rejects(supervisor.start(), /Development Host exited before readiness/)
  assert.equal(supervisor.status().state, 'failed')
  assert.notEqual(supervisor.status().host.state, 'ready')
})

test('DevSupervisor requires checkout identity and rejects a mismatched HEAD before spawn', async () => {
  const missing = fakeSpawner()
  const missingAdapter = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    host: { command: '/node', entry: '/dsh-source/apps/host.js', readyAdapter: () => 'http://127.0.0.1:45123/' },
    watcher: { nodeExecutable: '/node', pnpmEntry: '/tools/pnpm.mjs', readyAdapter: () => 'http://127.0.0.1:5173/' },
    spawnImpl: missing.spawnImpl,
    processKill: missing.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await assert.rejects(missingAdapter.start(), /checkout identity adapter is required/)
  assert.equal(missing.calls.length, 0)

  const mismatch = fakeSpawner()
  const wrongHead = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => 'b'.repeat(40),
    host: { command: '/node', entry: '/dsh-source/apps/host.js', readyAdapter: () => 'http://127.0.0.1:45123/' },
    watcher: { nodeExecutable: '/node', pnpmEntry: '/tools/pnpm.mjs', readyAdapter: () => 'http://127.0.0.1:5173/' },
    spawnImpl: mismatch.spawnImpl,
    processKill: mismatch.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await assert.rejects(wrongHead.start(), /HEAD .*does not match pinned checkout/)
  assert.equal(mismatch.calls.length, 0)
})

test('DevSupervisor requires a Host readiness adapter but permits a live watcher without one', async () => {
  assert.throws(() => new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => 'a'.repeat(40),
    host: { command: '/node', entry: '/dsh-source/apps/host.js' },
    watcher: { command: '/pnpm', args: ['run', 'dev:web'] },
  }), /Host readiness adapter is required/)

  const fake = fakeSpawner()
  const supervisor = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => 'a'.repeat(40),
    host: {
      command: '/node',
      entry: '/dsh-source/apps/host.js',
      readyAdapter: () => 'http://127.0.0.1:45123/',
      expectedOrigin: 'http://127.0.0.1:45123',
    },
    watcher: { command: '/pnpm', args: ['run', 'dev:web'] },
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await supervisor.start()
  assert.equal(supervisor.status().state, 'ready')
  assert.equal(supervisor.status().watcher.state, 'running')
  assert.equal(supervisor.status().watcher.url, undefined)
  await supervisor.stop()
})

test('DevSupervisor owns Host and watcher independently and degrades only HMR', async () => {
  const fake = fakeSpawner()
  const supervisor = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => ({ path: '/dsh-source', pin: 'a'.repeat(40) }),
    host: {
      command: '/node',
      entry: '/dsh-source/apps/host.js',
      readyAdapter: ({ expectedOrigin }) => `${expectedOrigin ?? 'http://127.0.0.1:45123'}/`,
      expectedOrigin: 'http://127.0.0.1:45123',
    },
    watcher: {
      nodeExecutable: '/node',
      pnpmEntry: '/tools/pnpm.mjs',
      readyAdapter: () => 'http://127.0.0.1:5173/',
      expectedOrigin: 'http://127.0.0.1:5173',
    },
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await supervisor.start()
  assert.equal(fake.calls.length, 2)
  assert.equal(fake.calls[0].args.at(-2), 'run')
  assert.equal(fake.calls[0].args.at(-1), 'dev:web')
  assert.equal(supervisor.status().host.state, 'ready')
  assert.equal(supervisor.status().watcher.state, 'ready')
  fake.children[0].exit(1, null)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(supervisor.status().host.state, 'ready')
  assert.equal(supervisor.status().watcher.state, 'degraded')
  assert.equal(supervisor.status().state, 'degraded')
  fake.children[1].exit(1, null)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(supervisor.status().state, 'failed')
  assert.equal(supervisor.status().host.state, 'failed')
  await supervisor.stop()
})

test('DevSupervisor ignores late watcher readiness from a replaced owner record', async () => {
  const fake = fakeSpawner()
  const watcherAttempts = []
  const supervisor = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => 'a'.repeat(40),
    host: {
      command: '/node',
      entry: '/dsh-source/apps/host.js',
      readyAdapter: () => 'http://127.0.0.1:45123/',
      expectedOrigin: 'http://127.0.0.1:45123',
    },
    watcher: {
      nodeExecutable: '/node',
      pnpmEntry: '/tools/pnpm.mjs',
      readyAdapter: context => {
        const attempt = deferred()
        context.signal.addEventListener('abort', () => attempt.reject(context.signal.reason), { once: true })
        watcherAttempts.push({ ...attempt, descriptor: context.descriptor, signal: context.signal })
        return attempt.promise
      },
      expectedOrigin: 'http://127.0.0.1:5173',
    },
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await supervisor.start()
  const first = watcherAttempts[0]
  const oldDescriptor = supervisor.status().watcher.descriptor
  const replacement = await supervisor.restartWatcher({ descriptor: oldDescriptor })
  assert.equal(replacement.descriptor.generation, oldDescriptor.generation + 1)
  assert.equal(first.signal.aborted, true)
  first.reject(new Error('late old watcher readiness'))
  await nextTurn()
  assert.equal(supervisor.status().watcher.ownerNonce, replacement.descriptor.ownerNonce)
  assert.equal(supervisor.status().watcher.state, 'starting')
  watcherAttempts[1].resolve('http://127.0.0.1:5173/')
  await nextTurn()
  assert.equal(supervisor.status().watcher.state, 'ready')
  await supervisor.stop()
})

test('DevSupervisor Host failure drains only its exact watcher tree on Windows', async () => {
  const calls = []
  const children = []
  let nextPid = 20_000
  const spawnImpl = (command, args, options) => {
    const child = new FakeChild(nextPid++)
    children.push(child)
    calls.push({ command, args, options, child })
    if (command === TASKKILL_PATH) queueMicrotask(() => child.exit(0, null))
    return child
  }
  const supervisor = new DevSupervisor({
    checkoutPath: 'C:\\dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => ({ path: 'C:\\dsh-source', head: 'a'.repeat(40) }),
    host: { command: 'C:\\node.exe', entry: 'C:\\dsh-source\\apps\\host.js', readyAdapter: () => 'http://127.0.0.1:45123/', expectedOrigin: 'http://127.0.0.1:45123' },
    watcher: { nodeExecutable: 'C:\\node.exe', pnpmEntry: 'C:\\tools\\pnpm.mjs', readyAdapter: () => 'http://127.0.0.1:5173/', expectedOrigin: 'http://127.0.0.1:5173' },
    spawnImpl,
    platform: 'win32',
    taskkillPath: TASKKILL_PATH,
    terminationTimeoutMs: 1,
  })
  await supervisor.start()
  const host = children[1]
  const watcher = children[0]
  const unrelated = new FakeChild(29_999)
  host.exit(1, null)
  await new Promise(resolve => setTimeout(resolve, 25))
  const taskkills = calls.filter(call => call.command === TASKKILL_PATH)
  // The Host root has already exited and is released without retargeting its
  // numeric PID. The still-live watcher remains fail-closed when its fake
  // taskkill never proves descendant cleanup.
  assert.equal(taskkills.length >= 2, true)
  assert.equal(taskkills.some(call => call.args[1] === String(watcher.pid)), true)
  assert.equal(taskkills.some(call => call.args[1] === String(host.pid)), false)
  assert.equal(unrelated.killSignals.length, 0)
  assert.equal(supervisor.status().host.state, 'failed')
  assert.equal(supervisor.status().watcher.state, 'failed')
  assert.equal(supervisor.status().unsafe, true)
  const cleanupError = supervisor.status().cleanupError
  assert.equal(cleanupError?.code === 'PROCESS_TREE_CLEANUP_INCOMPLETE'
    || cleanupError?.errors?.some(error => error?.code === 'PROCESS_TREE_CLEANUP_INCOMPLETE'), true)
  for (const child of [host, watcher]) {
    assert.equal(child.listenerCount('exit'), 0)
    assert.equal(child.listenerCount('close'), 0)
    assert.equal(child.listenerCount('error'), 0)
    assert.equal(child.stdout.listenerCount('data'), 0)
    assert.equal(child.stderr.listenerCount('data'), 0)
  }
  await assert.rejects(supervisor.stop(), /cleanup incomplete|root-only/)
})

test('DevSupervisor requires a contiguous run dev:web watcher invocation', () => {
  const base = {
    checkoutPath: '/dsh',
    checkoutPin: 'a'.repeat(40),
    host: { readyAdapter: () => 'http://127.0.0.1:45123/' },
    watcher: { command: '/pnpm', args: ['run', 'dev:web'] },
  }
  for (const args of [['run', 'inserted-command', 'dev:web'], ['run', 'dev:web', 'inserted-command']]) {
    assert.throws(() => new DevSupervisor({ ...base, watcher: { ...base.watcher, args } }), /contiguous pnpm run dev:web/)
  }
  assert.doesNotThrow(() => new DevSupervisor({ ...base, watcher: { ...base.watcher, pnpmEntry: '/tools/pnpm.mjs', args: ['/tools/pnpm.mjs', 'run', 'dev:web'] } }))
})

test('DevSupervisor rejects host execution injection and checkout-escaping paths but keeps DSH scalar args', () => {
  const base = {
    checkoutPath: '/dsh',
    checkoutPin: 'a'.repeat(40),
    host: { command: '/node', entry: '/dsh/apps/host.js', readyAdapter: () => 'http://127.0.0.1:45123/' },
    watcher: { command: '/pnpm', args: ['run', 'dev:web'] },
  }
  assert.doesNotThrow(() => new DevSupervisor({
    ...base,
    host: { ...base.host, args: ['web', '--profile', 'dev', '--port', '5173'] },
  }))
  assert.doesNotThrow(() => new DevSupervisor({
    ...base,
    host: { ...base.host, args: ['apps/inside.js'] },
  }))
  for (const args of [
    ['--require', '/outside/evil.js'],
    ['--eval', 'process.exit(1)'],
    ['--loader=/outside/loader.mjs'],
    ['--env-file', '/outside/.env'],
    ['/outside/evil.js'],
    ['../outside/evil.js'],
  ]) {
    assert.throws(
      () => new DevSupervisor({ ...base, host: { ...base.host, args } }),
      /(?:execution|checkout)/i,
      args.join(' '),
    )
  }
})

test('Development readiness accepts only HTTP(S) loopback URLs', () => {
  assert.deepEqual(devInternals.normalizeReady('https://127.0.0.1:5173/'), {
    url: 'https://127.0.0.1:5173/',
    origin: 'https://127.0.0.1:5173',
  })
  for (const url of ['ftp://127.0.0.1:5173/', 'file:///dsh/index.html', 'http://localhost:5173/']) {
    assert.throws(() => devInternals.normalizeReady(url), /HTTP\(S\) loopback/)
  }
})

test('DevSupervisor aborts checkout identity and Host readiness awaits', async () => {
  const identity = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => new Promise(() => {}),
    host: { command: '/node', entry: '/dsh-source/apps/host.js', readyAdapter: () => 'http://127.0.0.1:45123/' },
    watcher: { nodeExecutable: '/node', pnpmEntry: '/tools/pnpm.mjs', readyAdapter: () => 'http://127.0.0.1:5173/' },
    spawnImpl: fakeSpawner().spawnImpl,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const identityStart = identity.start()
  await nextTurn()
  await identity.stop()
  await assert.rejects(identityStart)
  assert.equal(identity.status().state, 'stopped')

  const fake = fakeSpawner()
  const readiness = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => ({ path: '/dsh-source', pin: 'a'.repeat(40) }),
    host: { command: '/node', entry: '/dsh-source/apps/host.js', readyAdapter: () => new Promise(() => {}), expectedOrigin: 'http://127.0.0.1:45123' },
    watcher: { nodeExecutable: '/node', pnpmEntry: '/tools/pnpm.mjs', readyAdapter: () => 'http://127.0.0.1:5173/' },
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  const readinessStart = readiness.start()
  await nextTurn()
  await readiness.stop()
  await assert.rejects(readinessStart)
  assert.equal(readiness.status().state, 'stopped')
  assert.equal(fake.children[0].killSignals.includes('SIGTERM'), true)
  assert.equal(fake.children[1].killSignals.includes('SIGTERM'), true)
})

test('DevSupervisor aborts a pending watcher readiness after Host publication during stop', async () => {
  const fake = fakeSpawner()
  let watcherAborted = false
  const supervisor = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => ({ path: '/dsh-source', pin: 'a'.repeat(40) }),
    host: { command: '/node', entry: '/dsh-source/apps/host.js', readyAdapter: () => 'http://127.0.0.1:45123/', expectedOrigin: 'http://127.0.0.1:45123' },
    watcher: {
      nodeExecutable: '/node',
      pnpmEntry: '/tools/pnpm.mjs',
      readyAdapter: ({ signal }) => {
        signal.addEventListener('abort', () => { watcherAborted = true }, { once: true })
        return new Promise(() => {})
      },
      expectedOrigin: 'http://127.0.0.1:5173',
    },
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await supervisor.start()
  await supervisor.stop()
  await nextTurn()
  assert.equal(watcherAborted, true)
  assert.equal(supervisor.status().state, 'stopped')
})

test('DevSupervisor stops a live watcher before reporting readiness degradation', async () => {
  const fake = fakeSpawner()
  const watcherReady = deferred()
  let watcherAborted = false
  const supervisor = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => ({ path: '/dsh-source', pin: 'a'.repeat(40) }),
    host: { command: '/node', entry: '/dsh-source/apps/host.js', readyAdapter: () => 'http://127.0.0.1:45123/', expectedOrigin: 'http://127.0.0.1:45123' },
    watcher: {
      nodeExecutable: '/node',
      pnpmEntry: '/tools/pnpm.mjs',
      readyAdapter: ({ signal }) => {
        signal.addEventListener('abort', () => { watcherAborted = true }, { once: true })
        return watcherReady.promise
      },
      expectedOrigin: 'http://127.0.0.1:5173',
    },
    spawnImpl: fake.spawnImpl,
    processKill: fake.processKill,
    platform: 'linux',
    terminationTimeoutMs: 1,
  })
  await supervisor.start()
  assert.equal(supervisor.status().watcher.state, 'starting')
  watcherReady.reject(new Error('watcher readiness rejected'))
  await nextTurn()
  await nextTurn()
  assert.equal(supervisor.status().watcher.state, 'degraded')
  assert.equal(watcherAborted, true)
  assert.equal(fake.children[0].killSignals.includes('SIGTERM'), true)
  const watcher = fake.children[0]
  assert.equal(watcher.listenerCount('exit'), 0)
  assert.equal(watcher.listenerCount('close'), 0)
  await supervisor.stop()
})

test('DevSupervisor publishes failed cleanup status and invalidates roots after owner rejection', async () => {
  const failure = new Error('dev owner cleanup failed')
  let nextNonce = 0
  const owner = {
    generation: 1,
    spawn: spec => ({
      child: { exitCode: null, signalCode: null },
      state: 'running',
      descriptor: { role: spec.role, generation: 1, ownerNonce: `dev-owner-${++nextNonce}` },
    }),
    stopAll: async () => { throw failure },
  }
  const supervisor = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => ({ path: '/dsh-source', pin: 'a'.repeat(40) }),
    host: {
      command: '/node',
      entry: '/dsh-source/apps/host.js',
      readyAdapter: () => 'http://127.0.0.1:45123/',
      expectedOrigin: 'http://127.0.0.1:45123',
    },
    watcher: { command: '/pnpm', args: ['run', 'dev:web'] },
    owner,
  })
  await supervisor.start()
  await assert.rejects(supervisor.stop(), error => error === failure)
  const status = supervisor.status()
  assert.equal(status.state, 'failed')
  assert.equal(status.unsafe, true)
  assert.equal(status.cleanupError, failure)
  assert.equal(status.host.state, 'failed')
  assert.equal(status.watcher.state, 'failed')
  assert.equal(status.host.descriptor, undefined)
  assert.equal(status.watcher.descriptor, undefined)
  assert.equal(status.host.url, undefined)
  assert.equal(status.watcher.url, undefined)
})

test('DevSupervisor surfaces asynchronous watcher cleanup rejection after readiness failure', async () => {
  const cleanupFailure = new Error('dev watcher cleanup failed')
  const owner = new EventEmitter()
  const handles = []
  let nextNonce = 0
  owner.generation = 1
  owner.spawn = spec => {
    const handle = {
      child: { exitCode: null, signalCode: null },
      state: 'running',
      descriptor: { role: spec.role, generation: 1, ownerNonce: `dev-async-${++nextNonce}` },
    }
    handles.push(handle)
    return handle
  }
  owner.stop = async handle => {
    if (handle.descriptor.role === 'watcher') throw cleanupFailure
    return true
  }
  owner.stopAll = async () => {}
  owner.owns = () => true
  const cleanupEvents = []
  const supervisor = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => ({ path: '/dsh-source', pin: 'a'.repeat(40) }),
    host: {
      command: '/node',
      entry: '/dsh-source/apps/host.js',
      readyAdapter: () => 'http://127.0.0.1:45123/',
      expectedOrigin: 'http://127.0.0.1:45123',
    },
    watcher: {
      command: '/pnpm',
      args: ['run', 'dev:web'],
      readyAdapter: () => 'http://127.0.0.1:5173/',
      expectedOrigin: 'http://127.0.0.1:5173',
    },
    owner,
  })
  supervisor.on('cleanup-error', event => cleanupEvents.push(event))
  await supervisor.start()
  const watcher = handles.find(handle => handle.descriptor.role === 'watcher')
  owner.emit('status', {
    role: 'watcher',
    state: 'failed',
    descriptor: watcher.descriptor,
    current: true,
    stale: false,
    error: new Error('dev watcher exited'),
  })
  await nextTurn()
  await nextTurn()
  const status = supervisor.status()
  assert.equal(status.state, 'failed')
  assert.equal(status.unsafe, true)
  assert.equal(status.watcher.state, 'failed')
  assert.equal(status.cleanupError, cleanupFailure)
  assert.equal(cleanupEvents.some(event => event.error === cleanupFailure), true)
  await assert.rejects(supervisor.stop(), error => error === cleanupFailure)
})

test('DevSupervisor startup waits for queued watcher cleanup after readiness failure clears its owner', async () => {
  const hostReady = deferred()
  const watcherReady = deferred()
  const watcherCleanup = deferred()
  const hostFailure = new Error('Host readiness failed')
  const cleanupFailure = new Error('queued watcher cleanup failed')
  const owner = new EventEmitter()
  const handles = []
  let nextNonce = 0
  let watcherStopCalls = 0
  owner.generation = 1
  owner.spawn = spec => {
    const handle = {
      child: { exitCode: null, signalCode: null },
      state: 'running',
      descriptor: { role: spec.role, generation: 1, ownerNonce: `dev-interleave-${++nextNonce}` },
    }
    handles.push(handle)
    return handle
  }
  owner.stop = async handle => {
    if (handle.descriptor.role === 'watcher') {
      watcherStopCalls += 1
      await watcherCleanup.promise
    }
    return true
  }
  owner.stopAll = async () => {}
  owner.owns = () => true
  const supervisor = new DevSupervisor({
    checkoutPath: '/dsh-source',
    checkoutPin: 'a'.repeat(40),
    checkoutIdentity: () => ({ path: '/dsh-source', pin: 'a'.repeat(40) }),
    host: {
      command: '/node',
      entry: '/dsh-source/apps/host.js',
      readyAdapter: () => hostReady.promise,
      expectedOrigin: 'http://127.0.0.1:45123',
    },
    watcher: {
      command: '/pnpm',
      args: ['run', 'dev:web'],
      readyAdapter: () => watcherReady.promise,
      expectedOrigin: 'http://127.0.0.1:5173',
    },
    owner,
  })

  const starting = supervisor.start()
  await nextTurn()
  watcherReady.reject(new Error('watcher readiness failed'))
  await nextTurn()
  await nextTurn()
  assert.equal(supervisor.status().watcher.descriptor, undefined)
  assert.equal(watcherStopCalls, 1)

  let settled = false
  starting.then(() => { settled = true }, () => { settled = true })
  hostReady.reject(hostFailure)
  await nextTurn()
  assert.equal(settled, false)

  watcherCleanup.reject(cleanupFailure)
  const startupError = await starting.catch(error => error)
  assert.equal(startupError instanceof AggregateError, true)
  assert.deepEqual(startupError.errors, [hostFailure, cleanupFailure])
  assert.equal(supervisor.status().unsafe, true)
  assert.equal(supervisor.status().cleanupError, cleanupFailure)
  await assert.rejects(supervisor.start(), /unsafe after incomplete cleanup/)
  await assert.rejects(supervisor.stop(), error => error === cleanupFailure)
})
