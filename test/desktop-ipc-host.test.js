import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { DIAGNOSTIC_RENDERER_STATUS_MAX_CHARS } from '../src/diagnostics.js'
import {
  IPC_CHANNELS,
  IPC_REGISTRATION_CHANNEL_VALUES,
} from '../src/ipc/contracts.js'
import { createDesktopIpcHost } from '../src/ipc/desktop-host.js'

function fakeWindow(url) {
  const sent = []
  const webContents = { sent, send: (channel, value) => sent.push({ channel, value }) }
  return {
    webContents,
    sent,
    isDestroyed: () => false,
    url,
    show() {},
    focus() {},
  }
}

function createFixture({ ready = true, logPath = undefined, updateAvailable = false, pluginAvailable = true, pluginTransactionAvailable = false, pendingPluginCandidateId, candidateAvailable = false, snapshotsAvailable = false, diagnostic = false, recoveryAvailable = false, recoveryMode = false, pluginBusy = false } = {}) {
  const rendererPath = fileURLToPath(new URL('../src/renderer/index.html', import.meta.url))
  const pluginPath = fileURLToPath(new URL('../src/pages/plugins.html', import.meta.url))
  const management = fakeWindow(pathToFileURL(rendererPath).href)
  const harness = fakeWindow('http://127.0.0.1:43123/')
  const pluginManager = fakeWindow(pathToFileURL(pluginPath).href)
  const handlers = new Map()
  const listeners = new Map()
  const calls = []
  const diagnosticSecret = 'ipc-status-secret-123456789'
  const diagnosticValue = diagnostic ? `Authorization: Basic ${diagnosticSecret} ${'x'.repeat(100_000)}` : 'Authorization: Bearer should-not-leak'
  const ipcMain = {
    handle(channel, listener) { handlers.set(channel, listener) },
    on(channel, listener) { listeners.set(channel, listener) },
  }
  const state = {
    app: () => ({ version: '0.1.test', ready: true }),
    mode: () => 'legacy',
    startup: () => ({ phase: 'ready', progress: 100, message: diagnosticValue, error: diagnostic ? diagnosticValue : undefined }),
    runtime: () => ({ version: diagnostic ? diagnosticValue : '0.1.1', source: diagnostic ? diagnosticValue : 'bundled' }),
    workspace: () => ({ ready, origin: 'http://127.0.0.1:43123' }),
    update: () => ({ state: 'unavailable', available: updateAvailable, checkAvailable: updateAvailable, restoreAvailable: updateAvailable }),
    desktopUpdate: () => ({ state: 'unavailable', available: updateAvailable, checkAvailable: updateAvailable }),
    candidate: () => candidateAvailable
      ? { state: 'ready', available: true, prepareAvailable: true, switchAvailable: true, busy: false, channel: 'stable', id: 'candidate-1', version: '1.2.3', physicalProfileName: 'ricardo-stable-candidate-1', reason: null }
      : { state: 'unavailable', available: false },
    snapshots: () => snapshotsAvailable
      ? { state: 'available', available: true, busy: false, count: 1, totalBytes: 42, reason: null }
      : { state: 'unavailable', available: false, busy: false },
    plugins: () => ({
      state: pluginAvailable ? 'available' : 'unavailable',
      available: pluginAvailable,
      busy: pluginBusy,
      installed: 2,
      transactionAvailable: pluginTransactionAvailable,
      pendingCandidateId: pendingPluginCandidateId ?? null,
      restartRequired: pendingPluginCandidateId !== undefined,
      recoveryAvailable,
      recoveryMode,
      recoveryRows: recoveryMode ? 4 : 0,
      recoveryReason: recoveryMode ? 'manual' : null,
    }),
    logs: () => ({ path: logPath }),
    operationBusy: () => false,
    quitting: () => false,
  }
  const effects = {
    runDetached(action) { action() },
    desktopUpdateCheck: () => calls.push('desktopUpdateCheck'),
    updateCheck: () => calls.push('updateCheck'),
    updateRestore: () => calls.push('updateRestore'),
    candidatePrepare: channel => calls.push(['candidatePrepare', channel]),
    candidateActivate: id => calls.push(['candidateActivate', id]),
    snapshotList: () => [{ snapshotId: 'snapshot-1', createdAt: '2026-08-22T00:00:00.000Z', kind: 'pre-switch', count: 2, bytes: 42, path: 'C:\\secret\\snapshot-1' }],
    snapshotCreate: () => calls.push('snapshotCreate'),
    snapshotRestore: id => calls.push(['snapshotRestore', id]),
    openLogFolder: path => calls.push(['openLogFolder', path]),
    openWorkspace: () => calls.push('openWorkspace'),
    restart: () => calls.push('restart'),
    navigate: route => calls.push(['navigate', route]),
    openPath: (path, intent) => { calls.push(['openPath', path, intent]); return { ok: true } },
    openSettingsDocument: () => { calls.push('openSettingsDocument'); return { opened: true } },
    workspaceContext: value => calls.push(['workspaceContext', value]),
    workspaceTheme: value => calls.push(['workspaceTheme', value]),
    titlebarMenu: value => calls.push(['titlebarMenu', value]),
    titlebarNavigate: value => { calls.push(['titlebarNavigate', value]); return { moved: true, direction: value } },
    openPluginManager: () => calls.push('openPluginManager'),
    pluginList: () => ({ plugins: [] }),
    pluginDiscover: () => ({ entries: [] }),
    pluginTransaction: request => { calls.push(['pluginTransaction', request]); return { action: request.action, candidateId: 'candidate-plugin' } },
    pluginMarketInstall: request => { calls.push(['pluginMarketInstall', request]); return { candidateId: 'candidate-market-install' } },
    pluginMarketUpdate: request => { calls.push(['pluginMarketUpdate', request]); return { candidateId: 'candidate-market-update' } },
    pluginRemovePreview: request => { calls.push(['pluginRemovePreview', request]); return { ...request, previewDigest: 'a'.repeat(64), confirmationToken: `remove:${'a'.repeat(64)}` } },
    pluginConfirmRemove: request => { calls.push(['pluginConfirmRemove', request]); return { action: 'remove', candidateId: 'candidate-remove' } },
    pluginInstall: (...args) => calls.push(['pluginInstall', ...args]),
    pluginEnabled: (...args) => calls.push(['pluginEnabled', ...args]),
    pluginUpdate: (...args) => calls.push(['pluginUpdate', ...args]),
    pluginRemove: (...args) => calls.push(['pluginRemove', ...args]),
    pluginRestart: () => calls.push('pluginRestart'),
    pluginSafeStart: () => calls.push('pluginSafeStart'),
    pluginSafeExit: () => calls.push('pluginSafeExit'),
    openPluginDocs: url => calls.push(['openPluginDocs', url]),
    openPluginSource: url => calls.push(['openPluginSource', url]),
  }
  const host = createDesktopIpcHost({
    ipcMain,
    windows: { management, harness, pluginManager },
    origins: { harness: 'http://127.0.0.1:43123' },
    paths: { managementRenderer: rendererPath, pluginManager: pluginPath },
    state,
    effects,
    adapters: {
      normalizeWorkspaceContext: value => ({ active: value.active, roots: value.roots.map(root => root.toLowerCase()) }),
      normalizePluginSourceUrl: value => value.replace(/\/+$/, ''),
    },
    logger: { write: () => {} },
  })
  host.register()
  const managementEvent = { sender: management.webContents, senderFrame: { url: management.url } }
  const harnessEvent = { sender: harness.webContents, senderFrame: { url: harness.url } }
  const pluginEvent = { sender: pluginManager.webContents, senderFrame: { url: pluginManager.url } }
  const untrustedEvent = { sender: {}, senderFrame: { url: management.url } }
  return { host, handlers, listeners, calls, management, harness, managementEvent, harnessEvent, pluginEvent, untrustedEvent, state }
}

test('desktop IPC host registers every inbound channel exactly once', () => {
  const fixture = createFixture()
  assert.deepEqual([...fixture.host.registeredChannels()].sort(), [...IPC_REGISTRATION_CHANNEL_VALUES].sort())
  assert.equal(fixture.handlers.size + fixture.listeners.size, IPC_REGISTRATION_CHANNEL_VALUES.length)
  assert.equal(fixture.listeners.has(IPC_CHANNELS.workspaceContext), true)
  assert.equal(fixture.listeners.has(IPC_CHANNELS.workspace.theme), true)
  assert.equal(fixture.host.register(), fixture.host.register())
})

test('code-only rollback accepts only the recorded previous program from a trusted idle management page', async () => {
  const fixture = createFixture()
  fixture.state.candidate = () => ({ state: 'active', available: true, busy: false, codeRollbackAvailable: true, previousReleaseId: 'previous-code', switchAvailable: false })
  const activate = fixture.handlers.get(IPC_CHANNELS.candidate.activate)
  assert.equal(activate(fixture.untrustedEvent, 'previous-code').ok, false)
  assert.equal(activate(fixture.managementEvent, 'unrecorded-code').ok, false)
  assert.equal(activate(fixture.managementEvent, 'previous-code').ok, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(fixture.calls.filter(call => Array.isArray(call) && call[0] === 'candidateActivate'), [['candidateActivate', 'previous-code']])
  fixture.state.candidate = () => ({ available: true, busy: true, codeRollbackAvailable: true, previousReleaseId: 'previous-code' })
  assert.equal(activate(fixture.managementEvent, 'previous-code').ok, false)
})

test('desktop IPC host enforces sender roles before effects', async () => {
  const fixture = createFixture()
  const status = fixture.handlers.get(IPC_CHANNELS.status.get)
  assert.deepEqual(status(fixture.untrustedEvent), { ok: false, error: 'Untrusted status request' })
  assert.equal(status(fixture.managementEvent).ok, true)

  const openPath = fixture.handlers.get(IPC_CHANNELS.openPath)
  assert.deepEqual(openPath(fixture.managementEvent, '/workspace/file.txt'), { ok: false, error: 'Untrusted path-open request' })
  assert.deepEqual(openPath(fixture.harnessEvent, '/workspace/file.txt'), { ok: true })

  const openSettings = fixture.handlers.get(IPC_CHANNELS.workspace.openSettings)
  assert.deepEqual(await openSettings(fixture.managementEvent), { ok: false, error: 'Untrusted Harness settings request' })
  assert.deepEqual(await openSettings(fixture.harnessEvent), { opened: true })

  const openUpdate = fixture.handlers.get(IPC_CHANNELS.workspace.openUpdate)
  assert.deepEqual(await openUpdate(fixture.managementEvent), { ok: false, error: 'Untrusted workspace update request' })
  assert.deepEqual(await openUpdate(fixture.harnessEvent), { ok: true })

  fixture.listeners.get(IPC_CHANNELS.workspace.theme)(fixture.harnessEvent, { preference: 'system', resolved: 'light' })
  fixture.listeners.get(IPC_CHANNELS.workspace.theme)(fixture.managementEvent, { preference: 'dark', resolved: 'dark' })
  assert.deepEqual(fixture.calls.filter(call => Array.isArray(call) && call[0] === 'workspaceTheme'), [['workspaceTheme', { preference: 'system', resolved: 'light' }]])

  assert.deepEqual(fixture.handlers.get(IPC_CHANNELS.workspace.titlebarMenu)(fixture.managementEvent, { menu: 'file', x: 8, y: 40 }), { ok: false, error: 'Untrusted title-bar menu request' })
  assert.deepEqual(fixture.handlers.get(IPC_CHANNELS.workspace.titlebarMenu)(fixture.harnessEvent, { menu: 'file', x: 8, y: 40 }), { ok: true })
  assert.deepEqual(fixture.handlers.get(IPC_CHANNELS.workspace.titlebarNavigate)(fixture.harnessEvent, 'back'), {
    ok: true,
    navigation: { moved: true, direction: 'back' },
  })

  const restart = fixture.handlers.get(IPC_CHANNELS.app.restart)
  assert.deepEqual(restart(fixture.untrustedEvent), { ok: false, error: 'Untrusted restart request' })
  assert.deepEqual(restart(fixture.harnessEvent), { ok: true, accepted: true })
  assert.equal(fixture.calls.includes('restart'), true)

  const list = fixture.handlers.get(IPC_CHANNELS.plugins.list)
  assert.deepEqual(list(fixture.managementEvent), { ok: false, error: 'Untrusted plugin request' })
  assert.deepEqual(list(fixture.pluginEvent), {
    ok: true,
    catalog: { plugins: [] },
    transactionAvailable: false,
    transactionState: 'unavailable',
    transactionReason: null,
  })
  assert.equal(fixture.calls.some(call => Array.isArray(call) && call[0] === 'openPath'), true)
  assert.equal(fixture.calls.some(call => Array.isArray(call) && call[0] === 'navigate' && call[1] === 'update'), true)
  await fixture.handlers.get(IPC_CHANNELS.app.navigate)(fixture.managementEvent, 'overview')
})

test('plugin safe mode is an explicit trusted control and reports its projected state', () => {
  const startFixture = createFixture({ recoveryAvailable: true })
  const start = startFixture.handlers.get(IPC_CHANNELS.plugins.safeStart)
  assert.deepEqual(start(startFixture.harnessEvent), { ok: false, error: 'Untrusted plugin safe-mode request' })
  assert.deepEqual(start(startFixture.managementEvent), { ok: true, accepted: true })
  assert.equal(startFixture.calls.at(-1), 'pluginSafeStart')
  const startStatus = startFixture.host.buildDesktopStatus()
  assert.equal(startStatus.plugins.recoveryAvailable, true)
  assert.equal(startStatus.plugins.recoveryMode, false)

  const exitFixture = createFixture({ recoveryAvailable: true, recoveryMode: true })
  const exit = exitFixture.handlers.get(IPC_CHANNELS.plugins.safeExit)
  assert.deepEqual(exit(exitFixture.managementEvent), { ok: true, accepted: true })
  assert.equal(exitFixture.calls.at(-1), 'pluginSafeExit')
  const exitStatus = exitFixture.host.buildDesktopStatus()
  assert.equal(exitStatus.plugins.recoveryMode, true)
  assert.equal(exitStatus.plugins.recoveryRows, 4)
  assert.equal(exitStatus.plugins.recoveryReason, 'manual')
})

test('invalid IPC arguments do not reach privileged effects', () => {
  const fixture = createFixture()
  const before = fixture.calls.length
  assert.match(fixture.handlers.get(IPC_CHANNELS.mode.set)(fixture.managementEvent, 'legacy').error, /Invalid mode/)
  assert.match(fixture.handlers.get(IPC_CHANNELS.candidate.prepare)(fixture.managementEvent, 'invalid').error, /Invalid candidate channel/)
  assert.match(fixture.handlers.get(IPC_CHANNELS.snapshots.restore)(fixture.managementEvent, '../secret').error, /Invalid snapshot id/)
  assert.match(fixture.handlers.get(IPC_CHANNELS.plugins.install)(fixture.pluginEvent, 'plugin && delete', false).error, /Invalid plugin spec/)
  assert.match(fixture.handlers.get(IPC_CHANNELS.plugins.enabled)(fixture.pluginEvent, '../plugin', true).error, /Invalid plugin name/)
  assert.equal(fixture.listeners.get(IPC_CHANNELS.workspaceContext)(fixture.harnessEvent, { active: 1, roots: [] }), undefined)
  assert.equal(fixture.listeners.get(IPC_CHANNELS.workspace.theme)(fixture.harnessEvent, 'blue'), undefined)
  assert.match(fixture.handlers.get(IPC_CHANNELS.workspace.titlebarMenu)(fixture.harnessEvent, { menu: 'window', x: 0, y: 40 }).error, /Invalid title-bar menu/)
  assert.match(fixture.handlers.get(IPC_CHANNELS.workspace.titlebarNavigate)(fixture.harnessEvent, 'reload').error, /Invalid title-bar navigation/)
  assert.equal(fixture.calls.length, before)
})

test('structured plugin IPC validates exact objects and never falls back to legacy mutation', async () => {
  const fixture = createFixture({ pluginTransactionAvailable: true })
  const transaction = fixture.handlers.get(IPC_CHANNELS.plugins.transaction)
  const preview = fixture.handlers.get(IPC_CHANNELS.plugins.removePreview)
  const confirm = fixture.handlers.get(IPC_CHANNELS.plugins.confirmRemove)

  const installed = await transaction(fixture.managementEvent, {
    action: 'install',
    source: { type: 'npm', package: '@example/plugin', versionOrTag: '1.2.3' },
    buildPermissions: { '@example/plugin': false },
  })
  assert.equal(installed.ok, true)
  assert.equal(installed.report.candidateId, 'candidate-plugin')
  assert.match(transaction(fixture.managementEvent, { action: 'install', source: 'plugin && delete' }).error, /plugin source/i)
  assert.match(transaction(fixture.managementEvent, { action: 'configure', name: '../plugin', config: {} }).error, /plugin name/i)

  const removalPreview = await preview(fixture.managementEvent, { name: '@example/plugin' })
  assert.equal(removalPreview.ok, true)
  const removal = await confirm(fixture.managementEvent, {
    name: '@example/plugin',
    previewDigest: 'a'.repeat(64),
    confirmationToken: `remove:${'a'.repeat(64)}`,
  })
  assert.equal(removal.ok, true)
  assert.deepEqual(fixture.calls.filter(call => Array.isArray(call) && call[0].startsWith('plugin')), [
    ['pluginTransaction', { action: 'install', source: { type: 'npm', package: '@example/plugin', versionOrTag: '1.2.3' }, buildPermissions: { '@example/plugin': false } }],
    ['pluginRemovePreview', { name: '@example/plugin' }],
    ['pluginConfirmRemove', { name: '@example/plugin', previewDigest: 'a'.repeat(64), confirmationToken: `remove:${'a'.repeat(64)}` }],
  ])
})

test('Harness market updates are exact, candidate-backed, and narrower than generic plugin transactions', async () => {
  const fixture = createFixture({ pluginTransactionAvailable: true, pendingPluginCandidateId: 'candidate-market-update' })
  const marketUpdate = fixture.handlers.get(IPC_CHANNELS.plugins.marketUpdate)
  const activate = fixture.handlers.get(IPC_CHANNELS.plugins.activateMarketUpdate)
  const genericTransaction = fixture.handlers.get(IPC_CHANNELS.plugins.transaction)

  assert.equal(genericTransaction(fixture.harnessEvent, { action: 'update', name: 'dshmarket' }).ok, false)
  assert.equal(marketUpdate(fixture.managementEvent, { name: 'dshmarket', kind: 'npm', target: '1.31.1' }).ok, false)
  assert.match(marketUpdate(fixture.harnessEvent, { name: 'dshmarket', kind: 'github', target: 'main' }).error, /commit/i)

  const staged = await marketUpdate(fixture.harnessEvent, { name: 'dshmarket', kind: 'npm', target: '1.31.1' })
  assert.equal(staged.ok, true)
  assert.equal(staged.report.candidateId, 'candidate-market-update')
  assert.deepEqual(fixture.calls.at(-1), ['pluginMarketUpdate', { name: 'dshmarket', kind: 'npm', target: '1.31.1' }])

  const batch = await marketUpdate(fixture.harnessEvent, {
    updates: [
      { name: 'plugin-a', kind: 'npm', target: '1.2.3' },
      { name: 'plugin-b', kind: 'npm', target: '2.3.4' },
    ],
  })
  assert.equal(batch.ok, true)
  assert.deepEqual(fixture.calls.at(-1), ['pluginMarketUpdate', {
    updates: [
      { name: 'plugin-a', kind: 'npm', target: '1.2.3' },
      { name: 'plugin-b', kind: 'npm', target: '2.3.4' },
    ],
  }])

  const restarted = activate(fixture.harnessEvent)
  assert.equal(restarted.ok, true)
  assert.equal(restarted.candidateId, 'candidate-market-update')
  assert.equal(fixture.calls.at(-1), 'pluginRestart')
})

test('Harness market installs accept only catalog-shaped GitHub addresses and stage candidates', async () => {
  const fixture = createFixture({ pluginTransactionAvailable: true })
  const marketInstall = fixture.handlers.get(IPC_CHANNELS.plugins.marketInstall)

  assert.equal(marketInstall(fixture.managementEvent, { url: 'https://github.com/HanaAyane/dsh-reasoning-effort' }).ok, false)
  assert.match(marketInstall(fixture.harnessEvent, { url: 'file:///C:/plugin' }).error, /GitHub/i)
  assert.match(marketInstall(fixture.harnessEvent, { url: 'https://github.com/HanaAyane/dsh-reasoning-effort', spec: 'evil' }).error, /Unknown/i)

  const staged = await marketInstall(fixture.harnessEvent, { url: 'https://github.com/HanaAyane/dsh-reasoning-effort/' })
  assert.equal(staged.ok, true)
  assert.equal(staged.report.candidateId, 'candidate-market-install')
  assert.deepEqual(fixture.calls.at(-1), ['pluginMarketInstall', { url: 'https://github.com/HanaAyane/dsh-reasoning-effort' }])
})

test('status projection is sanitized and notification uses the canonical event channel', () => {
  const fixture = createFixture()
  const status = fixture.host.buildDesktopStatus()
  assert.doesNotMatch(status.startup.message, /should-not-leak|Bearer should-not-leak/)
  assert.match(status.startup.message, /REDACTED/)
  assert.equal(status.candidate.available, false)
  assert.equal(status.snapshots.available, false)
  assert.equal(status.mode.switchAvailable, false)
  fixture.host.notify()
  assert.equal(fixture.harness.sent.at(-1).channel, IPC_CHANNELS.updates.changed)
  assert.equal(fixture.management.sent.at(-1).channel, IPC_CHANNELS.status.changed)
  assert.doesNotMatch(fixture.management.sent.at(-1).value.startup.message, /should-not-leak|Bearer should-not-leak/)
})

test('read-only mode status reports a running stable owner even when mode switching is unavailable', () => {
  const fixture = createFixture()
  fixture.state.mode = () => ({ active: 'stable', state: 'ready', stable: { status: { state: 'ready' } } })
  const status = fixture.host.buildDesktopStatus()
  assert.equal(status.mode.active, 'stable')
  assert.equal(status.mode.compatibility, 'managed')
  assert.equal(status.mode.stable.state, 'ready')
  assert.equal(status.mode.switchAvailable, false)
})

test('IPC status boundary caps huge diagnostics and removes credential substrings', () => {
  const fixture = createFixture({ diagnostic: true })
  const status = fixture.host.buildDesktopStatus()
  const strings = []
  const collect = value => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect)
  }
  collect(status)
  assert.ok(strings.every(value => value.length <= DIAGNOSTIC_RENDERER_STATUS_MAX_CHARS))
  assert.doesNotMatch(JSON.stringify(status), /ipc-status-secret-123456789/)
})

test('candidate, snapshots, updates, workspace and logs report unavailable without effects', () => {
  const fixture = createFixture({ ready: false, logPath: undefined, updateAvailable: false })
  const unavailableResults = [
    fixture.handlers.get(IPC_CHANNELS.candidate.prepare)(fixture.managementEvent, 'next'),
    fixture.handlers.get(IPC_CHANNELS.candidate.activate)(fixture.managementEvent, 'candidate-1'),
    fixture.handlers.get(IPC_CHANNELS.snapshots.list)(fixture.managementEvent),
    fixture.handlers.get(IPC_CHANNELS.snapshots.create)(fixture.managementEvent),
    fixture.handlers.get(IPC_CHANNELS.snapshots.restore)(fixture.managementEvent, 'snapshot-1'),
    fixture.handlers.get(IPC_CHANNELS.update.check)(fixture.managementEvent),
    fixture.handlers.get(IPC_CHANNELS.update.restore)(fixture.managementEvent),
    fixture.handlers.get(IPC_CHANNELS.update.desktopCheck)(fixture.managementEvent),
    fixture.handlers.get(IPC_CHANNELS.workspace.open)(fixture.managementEvent),
    fixture.handlers.get(IPC_CHANNELS.logs.open)(fixture.managementEvent),
  ]
  for (const result of unavailableResults) assert.equal(result.ok, false)
  assert.deepEqual(fixture.handlers.get(IPC_CHANNELS.logs.read)(fixture.managementEvent), { ok: true, lines: [], path: null, truncated: false })
  assert.deepEqual(fixture.calls, [])
})

test('candidate IPC projects ready metadata and invokes only the exact validated candidate effects', () => {
  const fixture = createFixture({ candidateAvailable: true })
  const status = fixture.handlers.get(IPC_CHANNELS.candidate.status)(fixture.managementEvent)
  assert.equal(status.ok, true)
  assert.equal(status.candidate.id, 'candidate-1')
  assert.equal(status.candidate.physicalProfileName, 'ricardo-stable-candidate-1')
  assert.deepEqual(fixture.handlers.get(IPC_CHANNELS.candidate.prepare)(fixture.managementEvent, 'stable'), { ok: true, accepted: true })
  assert.deepEqual(fixture.handlers.get(IPC_CHANNELS.candidate.activate)(fixture.managementEvent, 'candidate-1'), { ok: true, accepted: true })
  assert.equal(fixture.handlers.get(IPC_CHANNELS.candidate.activate)(fixture.managementEvent, 'candidate-2').ok, false)
  assert.deepEqual(fixture.calls.filter(call => Array.isArray(call) && call[0].startsWith('candidate')), [
    ['candidatePrepare', 'stable'],
    ['candidateActivate', 'candidate-1'],
  ])
})

test('snapshot IPC exposes verified summaries without filesystem paths and routes mutations through effects', async () => {
  const fixture = createFixture({ snapshotsAvailable: true })
  const status = fixture.host.buildDesktopStatus().snapshots
  assert.equal(status.available, true)
  assert.equal(status.count, 1)
  const listed = await fixture.handlers.get(IPC_CHANNELS.snapshots.list)(fixture.managementEvent)
  assert.equal(listed.ok, true)
  assert.equal(listed.snapshots.length, 1)
  assert.equal(listed.snapshots[0].snapshotId, 'snapshot-1')
  assert.equal(Object.hasOwn(listed.snapshots[0], 'path'), false)
  assert.deepEqual(fixture.handlers.get(IPC_CHANNELS.snapshots.create)(fixture.managementEvent), { ok: true, accepted: true })
  assert.deepEqual(fixture.handlers.get(IPC_CHANNELS.snapshots.restore)(fixture.managementEvent, 'snapshot-1'), { ok: true, accepted: true })
  assert.equal(fixture.calls.includes('snapshotCreate'), true)
  assert.equal(fixture.calls.some(call => Array.isArray(call) && call[0] === 'snapshotRestore' && call[1] === 'snapshot-1'), true)
})
