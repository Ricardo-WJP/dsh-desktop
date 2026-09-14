import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DIAGNOSTIC_LOG_ENTRY_MAX_CHARS, DIAGNOSTIC_NATIVE_DIALOG_DETAIL_MAX_CHARS } from '../src/diagnostics.js'
import { createDshUpdateController, prepareDshCandidate } from '../src/dsh-update.js'

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve))
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('candidate prepare export is isolated from restart and activation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-update-candidate-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let restarted = 0
  let activated = 0
  const result = await prepareDshCandidate({
    candidateRoot: root,
    channel: 'next',
    releaseId: 'candidate-update',
    desktopVersion: '0.1.34',
    runtimeRelease: { version: '1.2.3', integrity: 'sha512-Y2xp' },
    installRuntimeImpl: async ({ version, integrity }) => ({ version, integrity }),
    profilePlan: {
      mode: 'stable',
      logicalName: 'ricardo-stable',
      physicalName: 'ricardo-stable-candidate-update',
      packageJson: { name: 'ricardo-stable-candidate-update', private: true },
      bundles: [],
    },
    materializeProfileImpl: async ({ outputDir }) => {
      mkdirSync(outputDir, { recursive: true })
      writeFileSync(join(outputDir, 'package.json'), '{"name":"ricardo-stable-candidate-update"}\n')
      writeFileSync(join(outputDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
      writeFileSync(join(outputDir, 'cordis.patch.yml'), 'patch: candidate\n')
    },
    buildArtifactsImpl: async () => [],
    compatibilityReceipt: { suiteVersion: 'compat-1', reportSha256: 'a'.repeat(64), passed: true },
    onRuntimeChanged: () => { restarted += 1 },
    activateImpl: () => { activated += 1 },
  })

  assert.equal(result.status, 'ready')
  assert.equal(restarted, 0)
  assert.equal(activated, 0)
})

function fixture({
  responses = [],
  checkImpl,
  installImpl,
  dialog,
  onRuntimeChanged,
  activateImpl,
  deactivateImpl,
  onRuntimeCommitted,
  onRuntimeRollback,
  initialRuntime,
  childCancellationTimeoutMs,
  setTimeoutImpl,
  clearTimeoutImpl,
} = {}) {
  const bundled = { source: 'bundled', version: '1.0.0', entry: '/bundled/bin.js' }
  const messages = []
  const logs = []
  const changed = []
  let deactivated = 0
  const queue = [...responses]
  const controller = createDshUpdateController({
    initialRuntime: initialRuntime ?? { ...bundled, bundled },
    runtimeRoot: '/runtime',
    pnpmEntry: '/pnpm.mjs',
    isChinese: false,
    dialog: dialog ?? {
      async showMessageBox(options) {
        messages.push(options)
        return { response: queue.shift() ?? 1 }
      },
    },
    getWindow: () => undefined,
    onRuntimeChanged: onRuntimeChanged ?? (async runtime => { changed.push(runtime); return true }),
    checkImpl: checkImpl ?? (async () => ({ currentVersion: '1.0.0', latestVersion: '1.0.0', available: false })),
    installImpl: installImpl ?? (async ({ version }) => ({
      source: 'managed',
      version,
      entry: `/runtime/${version}/bin.js`,
    })),
    activateImpl: activateImpl ?? (() => {}),
    deactivateImpl: deactivateImpl ?? (() => { deactivated += 1 }),
    onRuntimeCommitted,
    onRuntimeRollback,
    ...(childCancellationTimeoutMs === undefined ? {} : { childCancellationTimeoutMs }),
    ...(setTimeoutImpl === undefined ? {} : { setTimeoutImpl }),
    ...(clearTimeoutImpl === undefined ? {} : { clearTimeoutImpl }),
    log: (level, message) => logs.push({ level, message }),
  })
  return { bundled, changed, controller, deactivated: () => deactivated, logs, messages }
}

test('manual DSH check reports the running npm version is current', async () => {
  const { controller, messages } = fixture()

  await controller.check(true)

  assert.equal(controller.state, 'idle')
  assert.equal(messages.at(-1).title, 'DSH Is Up to Date')
})

test('quiet DSH probe reports availability without opening a dialog', async () => {
  const setup = fixture({
    checkImpl: async () => ({ currentVersion: '1.0.0', latestVersion: '1.1.0', available: true }),
  })

  const result = await setup.controller.probe()

  assert.deepEqual(result, {
    currentVersion: '1.0.0',
    latestVersion: '1.1.0',
    available: true,
    channel: 'stable',
  })
  assert.equal(setup.messages.length, 0)
  assert.equal(setup.controller.state, 'idle')
})

test('DSH diagnostics redact credentials and cap native detail/log output', async () => {
  const secret = 'dsh-update-bearer-secret-987654321'
  const failure = new Error(`Authorization: Bearer ${secret}\n${'x'.repeat(100_000)}`)
  failure.stack = `prefix: preserve DSH context\n${failure.message}\n${'y'.repeat(100_000)}`
  const setup = fixture({
    checkImpl: async () => { throw failure },
  })

  await setup.controller.check(true)
  const detail = setup.messages.at(-1).detail
  assert.ok(detail.length <= DIAGNOSTIC_NATIVE_DIALOG_DETAIL_MAX_CHARS)
  assert.ok(setup.logs.at(-1).message.length <= DIAGNOSTIC_LOG_ENTRY_MAX_CHARS)
  assert.doesNotMatch(detail, new RegExp(secret))
  assert.doesNotMatch(setup.logs.at(-1).message, new RegExp(secret))
  assert.match(detail, /^prefix: preserve DSH context/)
})

test('available DSH version installs in user data and restarts Harness after confirmation', async () => {
  const { changed, controller, messages } = fixture({
    responses: [0],
    checkImpl: async () => ({ currentVersion: '1.0.0', latestVersion: '1.1.0', available: true }),
  })

  await controller.check(false)

  assert.equal(messages[0].title, 'DSH Update Available')
  assert.equal(changed.length, 1)
  assert.equal(changed[0].source, 'managed')
  assert.equal(changed[0].version, '1.1.0')
  assert.equal(controller.runtime.version, '1.1.0')
  assert.equal(controller.state, 'idle')
  assert.match(controller.restoreItem().label, /Restore Bundled DSH 1\.0\.0/)
})

test('reused staged versions restart first and activate exactly once after readiness', async () => {
  const order = []
  const setup = fixture({
    responses: [0],
    checkImpl: async () => ({ currentVersion: '1.0.0', latestVersion: '1.1.0', available: true }),
    installImpl: async ({ version }) => {
      order.push('stage')
      return { source: 'managed', version, reused: true, entry: `/runtime/${version}/bin.js` }
    },
    onRuntimeChanged: async () => {
      order.push('ready')
      return true
    },
    activateImpl: (_root, version) => { order.push(`activate:${version}`) },
    onRuntimeCommitted: () => { order.push('commit') },
  })

  await setup.controller.check(false)

  assert.deepEqual(order, ['stage', 'ready', 'activate:1.1.0', 'commit'])
  assert.equal(setup.controller.runtime.version, '1.1.0')
})

test('a failed restart keeps the previous runtime and does not activate the candidate', async () => {
  const activations = []
  const setup = fixture({
    responses: [0],
    checkImpl: async () => ({ currentVersion: '1.0.0', latestVersion: '1.1.0', available: true }),
    onRuntimeChanged: async () => false,
    activateImpl: (_root, version) => { activations.push(version) },
  })

  await setup.controller.check(false)

  assert.equal(setup.controller.runtime.version, '1.0.0')
  assert.deepEqual(activations, [])
})

test('a late abort after restart readiness cannot activate or commit the candidate', async () => {
  const action = new AbortController()
  const activations = []
  let committed = 0
  const setup = fixture({
    responses: [0],
    checkImpl: async () => ({ currentVersion: '1.0.0', latestVersion: '1.1.0', available: true }),
    onRuntimeChanged: async () => {
      action.abort(new Error('late abort'))
      return true
    },
    activateImpl: (_root, version) => { activations.push(version) },
    onRuntimeCommitted: () => { committed += 1 },
  })

  await setup.controller.check(false, { signal: action.signal })

  assert.equal(setup.controller.runtime.version, '1.0.0')
  assert.deepEqual(activations, [])
  assert.equal(committed, 0)
})

test('aborting an install waits for the child to stop before settling the update', async () => {
  const action = new AbortController()
  const child = deferred()
  let installStarted
  const started = new Promise(resolve => { installStarted = resolve })
  const setup = fixture({
    responses: [0],
    checkImpl: async () => ({ currentVersion: '1.0.0', latestVersion: '1.1.0', available: true }),
    installImpl: async () => {
      installStarted()
      return child.promise
    },
    childCancellationTimeoutMs: 1_000,
  })

  const checking = setup.controller.check(false, { signal: action.signal })
  await started
  action.abort(new Error('stop install'))
  let settled = false
  void checking.then(() => { settled = true })
  await nextTurn()
  assert.equal(settled, false)

  child.resolve({ source: 'managed', version: '1.1.0', entry: '/runtime/1.1.0/bin.js' })
  await checking
  assert.equal(setup.controller.runtime.version, '1.0.0')
})

test('one linked DSH signal reaches check, install, and runtime change', async () => {
  const observed = []
  const setup = fixture({
    responses: [0],
    checkImpl: async ({ signal }) => {
      observed.push(signal)
      return { currentVersion: '1.0.0', latestVersion: '1.1.0', available: true }
    },
    installImpl: async ({ signal, version }) => {
      observed.push(signal)
      return { source: 'managed', version, entry: `/runtime/${version}/bin.js` }
    },
    onRuntimeChanged: async (_runtime, { signal }) => { observed.push(signal); return true },
  })
  await setup.controller.check(false)
  assert.equal(observed.length, 3)
  assert.equal(observed[0], observed[1])
  assert.equal(observed[1], observed[2])
})

test('activation failure restores the previous managed pointer and runtime', async () => {
  const previous = { source: 'managed', version: '1.0.0', entry: '/runtime/1.0.0/bin.js' }
  const bundled = { source: 'bundled', version: '1.0.0', entry: '/bundled/bin.js' }
  const activations = []
  const setup = fixture({
    initialRuntime: { ...previous, bundled },
    responses: [0],
    checkImpl: async () => ({ currentVersion: '1.0.0', latestVersion: '1.1.0', available: true }),
    onRuntimeChanged: async () => true,
    activateImpl: (_root, version) => {
      activations.push(version)
      if (version === '1.1.0') throw new Error('activation failed')
    },
  })

  await setup.controller.check(false)

  assert.equal(setup.controller.runtime.version, '1.0.0')
  assert.deepEqual(activations, ['1.1.0', '1.0.0'])
})

test('a late DSH update confirmation after abort performs no install or runtime change', async () => {
  const messages = []
  let resolveDialog
  let installs = 0
  const setup = fixture({
    checkImpl: async () => ({ currentVersion: '1.0.0', latestVersion: '1.1.0', available: true }),
    dialog: {
      showMessageBox: options => {
        messages.push(options)
        return new Promise(resolve => { resolveDialog = resolve })
      },
    },
    installImpl: async ({ version }) => {
      installs += 1
      return { source: 'managed', version, entry: `/runtime/${version}/bin.js` }
    },
  })
  const action = new AbortController()
  const checking = setup.controller.check(false, { signal: action.signal })
  await nextTurn()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].signal, action.signal)
  action.abort(new Error('Desktop shutdown'))
  await checking

  assert.equal(setup.controller.state, 'idle')
  assert.equal(setup.controller.runtime.source, 'bundled')
  assert.equal(installs, 0)
  assert.equal(setup.deactivated(), 0)
  assert.equal(setup.changed.length, 0)
  resolveDialog({ response: 0 })
  await nextTurn()
  assert.equal(installs, 0)
  assert.equal(setup.deactivated(), 0)
  assert.equal(setup.changed.length, 0)
})

test('managed DSH can be restored to the bundled version', async () => {
  const setup = fixture({
    responses: [0, 0],
    checkImpl: async () => ({ currentVersion: '1.0.0', latestVersion: '1.1.0', available: true }),
  })
  await setup.controller.check(true)
  await nextTurn()

  await setup.controller.restoreBundled()

  assert.equal(setup.deactivated(), 1)
  assert.equal(setup.controller.runtime.source, 'bundled')
  assert.equal(setup.changed.at(-1).version, '1.0.0')
  assert.equal(setup.controller.restoreItem(), undefined)
})

test('repeated restore requests share one confirming dialog and expose busy state', async () => {
  const bundled = { source: 'bundled', version: '1.0.0', entry: '/bundled/bin.js' }
  const messages = []
  let resolveDialog
  const controller = createDshUpdateController({
    initialRuntime: { source: 'managed', version: '1.1.0', entry: '/runtime/bin.js', bundled },
    runtimeRoot: '/runtime',
    pnpmEntry: '/pnpm.mjs',
    isChinese: false,
    dialog: { showMessageBox: async options => { messages.push(options); return new Promise(resolve => { resolveDialog = resolve }) } },
    getWindow: () => undefined,
    onRuntimeChanged: async () => {},
    deactivateImpl: () => {},
  })
  const first = controller.restoreBundled()
  await nextTurn()
  assert.equal(controller.state, 'confirming')
  assert.equal(controller.busy, true)
  const second = controller.restoreBundled()
  await nextTurn()
  assert.equal(messages.length, 1)
  resolveDialog({ response: 1 })
  await Promise.all([first, second])
  assert.equal(controller.state, 'idle')
})

test('aborting the restore action cancels its confirmation and prevents deactivation or restart', async () => {
  const bundled = { source: 'bundled', version: '1.0.0', entry: '/bundled/bin.js' }
  const messages = []
  const action = new AbortController()
  let deactivated = 0
  let restarted = 0
  const controller = createDshUpdateController({
    initialRuntime: { source: 'managed', version: '1.1.0', entry: '/runtime/bin.js', bundled },
    runtimeRoot: '/runtime',
    pnpmEntry: '/pnpm.mjs',
    isChinese: false,
    dialog: { showMessageBox: async options => {
      messages.push(options)
      return new Promise(() => {})
    } },
    getWindow: () => undefined,
    onRuntimeChanged: async () => { restarted += 1 },
    deactivateImpl: () => { deactivated += 1 },
  })

  const restore = controller.restoreBundled({ signal: action.signal })
  await nextTurn()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].signal, action.signal)
  assert.equal(messages[0].signal?.aborted, false)
  action.abort(new Error('Desktop shutdown'))
  await restore

  assert.equal(messages[0].signal.aborted, true)
  assert.equal(deactivated, 0)
  assert.equal(restarted, 0)
  assert.equal(controller.runtime.source, 'managed')
  assert.equal(controller.state, 'idle')
})

test('failed managed runtime can be deactivated without another prompt', async () => {
  const setup = fixture({
    responses: [0],
    checkImpl: async () => ({ currentVersion: '1.0.0', latestVersion: '1.1.0', available: true }),
  })
  await setup.controller.check(true)

  assert.equal(await setup.controller.useBundledFallback(), true)
  assert.equal(await setup.controller.useBundledFallback(), false)
  assert.equal(setup.deactivated(), 1)
  assert.equal(setup.controller.runtime.source, 'bundled')
})

test('failed managed-runtime deactivation keeps the managed runtime active', async () => {
  const bundled = { source: 'bundled', version: '1.0.0', entry: '/bundled/bin.js' }
  const controller = createDshUpdateController({
    initialRuntime: { source: 'managed', version: '1.1.0', entry: '/runtime/bin.js', bundled },
    runtimeRoot: '/runtime',
    pnpmEntry: '/pnpm.mjs',
    isChinese: false,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    getWindow: () => undefined,
    onRuntimeChanged: async () => true,
    deactivateImpl: async () => { throw new Error('injected pointer failure') },
  })

  await assert.rejects(controller.useBundledFallback(), /injected pointer failure/u)
  assert.equal(controller.runtime.source, 'managed')
  assert.equal(controller.runtime.version, '1.1.0')
})
