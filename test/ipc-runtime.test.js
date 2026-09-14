import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import {
  IPC_CHANNELS,
  IPC_CHANNEL_VALUES,
  IPC_EVENT_CHANNEL_VALUES,
  IPC_REGISTRATION_CHANNEL_VALUES,
} from '../src/ipc/contracts.js'
import { ONBOARDING_CHANNELS } from '../src/onboarding.js'
import { generatePreloads, generatedPreloadPath, renderPreload } from '../src/ipc/preload-generator.js'

if (!existsSync(generatedPreloadPath('management')) || !existsSync(generatedPreloadPath('workspace')) || !existsSync(generatedPreloadPath('splash'))) generatePreloads()
import { createIpcRegistrar } from '../src/ipc/registration.js'

function loadPreload(filePath) {
  const source = readFileSync(filePath, 'utf8')
  const calls = []
  const exposed = {}
  const listeners = new Map()
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api } },
    ipcRenderer: {
      invoke: (channel, ...args) => { calls.push({ type: 'invoke', channel, args }); return Promise.resolve({ ok: true }) },
      send: (channel, ...args) => { calls.push({ type: 'send', channel, args }) },
      on: (channel, listener) => { calls.push({ type: 'on', channel }); listeners.set(channel, listener) },
      removeListener: (channel, listener) => { calls.push({ type: 'removeListener', channel }); if (listeners.get(channel) === listener) listeners.delete(channel) },
    },
  }
  const localRequire = createRequire(pathToFileURL(filePath).href)
  const require = request => request === 'electron' ? electron : localRequire(request)
  vm.runInNewContext(source, { require, console, Object, Promise }, { filename: filePath })
  return { api: Object.values(exposed)[0], calls }
}

async function exerciseManagementPreload(api) {
  assert.equal('openPath' in api, false)
  assert.equal('publishWorkspaceContext' in api, false)
  await api.status.get()
  const unsubscribe = api.status.subscribe(() => {})
  await api.mode.get(); await api.mode.set('stable')
  await api.candidate.status(); await api.candidate.prepare('next'); await api.candidate.activate('candidate-1')
  await api.update.probe(); await api.update.check(); await api.update.restore(); await api.update.desktopCheck()
  await api.snapshots.list(); await api.snapshots.create(); await api.snapshots.restore('snapshot-1')
  await api.recovery.startPluginSafeMode(); await api.recovery.exitPluginSafeMode()
  await api.logs.read(); await api.logs.open(); await api.workspace.open(); await api.app.restart(); await api.app.navigate('overview')
  unsubscribe()
}

async function exerciseWorkspacePreload(api) {
  await api.openPath('/workspace/file.txt')
  await api.openSettingsDocument()
  await api.openUpdate()
  await api.checkUpdate()
  await api.getUpdates(); await api.checkUpdates(); await api.openUpdateLink('desktop')
  await api.executeUpdates({ dsh: false, desktop: true, desktopVersion: '2.0.0' })
  api.onUpdatesChanged(() => {})()
  await api.installMarketPlugin({ url: 'https://github.com/HanaAyane/dsh-reasoning-effort' })
  await api.updateMarketPlugin({ name: 'dshmarket', kind: 'npm', target: '1.31.1' })
  await api.activateMarketUpdate()
  await api.startSafeMode()
  await api.restart()
  await api.openLogs()
  api.publishWorkspaceContext({ active: '/workspace', roots: ['/workspace'] })
  api.reportTheme({ preference: 'system', resolved: 'light' })
  assert.deepEqual(Object.keys(api).sort(), ['openPath', 'openSettingsDocument', 'openUpdate', 'checkUpdate', 'getUpdates', 'checkUpdates', 'executeUpdates', 'openUpdateLink', 'onUpdatesChanged', 'installMarketPlugin', 'updateMarketPlugin', 'activateMarketUpdate', 'startSafeMode', 'restart', 'openLogs', 'publishWorkspaceContext', 'reportTheme'].sort())
}

async function exerciseSplashPreload(api) {
  await api.recommendations()
  await api.install({ selectedIds: ['npm:dshmarket'], transactionId: 'onboarding-test' })
  const unsubscribe = api.progress.subscribe(() => {})
  unsubscribe()
  await api.skip()
  await api.window.minimize(); await api.window.toggleMaximize(); await api.window.close()
  assert.deepEqual(Object.keys(api).sort(), ['recommendations', 'install', 'progress', 'skip', 'window'].sort())
}
test('generated preloads are deterministic and carry the canonical channel contract', () => {
  const managementPath = generatedPreloadPath('management')
  const workspacePath = generatedPreloadPath('workspace')
  const splashPath = generatedPreloadPath('splash')
  assert.equal(readFileSync(managementPath, 'utf8'), renderPreload('management'))
  assert.equal(readFileSync(workspacePath, 'utf8'), renderPreload('workspace'))
  assert.equal(readFileSync(splashPath, 'utf8'), renderPreload('splash'))
  assert.equal(existsSync(new URL('../build/preload/plugin-preload.cjs', import.meta.url)), false)
  assert.equal(existsSync(new URL('../src/preload.cjs', import.meta.url)), false)
  assert.equal(existsSync(new URL('../src/plugin-preload.cjs', import.meta.url)), false)
  assert.equal(existsSync(new URL('../src/workspace-preload.cjs', import.meta.url)), false)
  assert.doesNotMatch(readFileSync(managementPath, 'utf8'), /require\(['\"]\.\/ipc\/channels\.cjs['\"]\)/)
  assert.doesNotMatch(readFileSync(workspacePath, 'utf8'), /require\(['\"]\.\/ipc\/channels\.cjs['\"]\)/)
  const splashSource = readFileSync(splashPath, 'utf8')
  assert.match(splashSource, /contextBridge\.exposeInMainWorld\('dshOnboarding'/)
  assert.match(splashSource, /recommendations: \(\) => invoke\(onboarding\.recommendations\)/)
  assert.match(splashSource, /install: request => invoke\(onboarding\.install, request\)/)
  assert.match(splashSource, /progress: Object\.freeze\(\{ subscribe: subscribeProgress \}\)/)
  const managementSource = readFileSync(managementPath, 'utf8')
  assert.match(managementSource, /desktopCheck: \(\) => invoke\(channels\.update\.desktopCheck\)/)
  assert.match(managementSource, /probe: \(\) => invoke\(channels\.update\.probe\)/)
  assert.match(managementSource, /startPluginSafeMode: \(\) => invoke\(channels\.plugins\.safeStart\)/)
   const managementBridge = managementSource.slice(managementSource.indexOf("contextBridge.exposeInMainWorld"))
  assert.doesNotMatch(managementBridge, /openPath|publishWorkspaceContext/)
  const workspaceSource = readFileSync(workspacePath, 'utf8')
  const workspaceBridge = workspaceSource.slice(workspaceSource.indexOf("contextBridge.exposeInMainWorld"))
  assert.match(workspaceBridge, /openPath/)
  assert.match(workspaceBridge, /openUpdate/)
  assert.match(workspaceBridge, /installMarketPlugin/)
  assert.match(workspaceBridge, /updateMarketPlugin/)
  assert.match(workspaceBridge, /activateMarketUpdate/)
  assert.match(workspaceBridge, /startSafeMode/)
  assert.match(workspaceBridge, /publishWorkspaceContext/)
  assert.match(workspaceBridge, /reportTheme/)
})

test('generated IPC channel source reaches every exposed preload operation', async () => {
  const management = loadPreload(generatedPreloadPath('management'))
  const workspace = loadPreload(generatedPreloadPath('workspace'))
  const splash = loadPreload(generatedPreloadPath('splash'))
  await exerciseManagementPreload(management.api)
  await exerciseWorkspacePreload(workspace.api)
  await exerciseSplashPreload(splash.api)
  const used = new Set([...management.calls, ...workspace.calls, ...splash.calls].map(call => call.channel).filter(Boolean))
  const exposedPluginChannels = new Set([
    IPC_CHANNELS.plugins.marketInstall,
    IPC_CHANNELS.plugins.marketUpdate,
    IPC_CHANNELS.plugins.activateMarketUpdate,
    IPC_CHANNELS.plugins.safeStart,
    IPC_CHANNELS.plugins.safeExit,
  ])
  assert.deepEqual(
    [...used].filter(channel => Object.values(IPC_CHANNELS.plugins).includes(channel)).sort(),
    [...exposedPluginChannels].sort(),
  )
  assert.ok(used.has(IPC_CHANNELS.status.get))
  assert.ok(used.has(IPC_CHANNELS.workspaceContext))
  assert.ok(used.has(IPC_CHANNELS.workspace.theme))
  assert.equal(IPC_CHANNELS.openPath, 'dsh-desktop:open-path')
  assert.equal(IPC_CHANNELS.workspaceContext, 'dsh-desktop:workspace-context')
  assert.ok(used.has(ONBOARDING_CHANNELS.recommendations))
  assert.ok(used.has(ONBOARDING_CHANNELS.install))
  assert.ok(used.has(ONBOARDING_CHANNELS.skip))
  assert.ok(used.has(ONBOARDING_CHANNELS.window.minimize))
  assert.ok(used.has(ONBOARDING_CHANNELS.window.toggleMaximize))
  assert.ok(used.has(ONBOARDING_CHANNELS.window.close))
})

test('IPC registrar enforces the inbound contract and reports complete registration', () => {
  const calls = []
  const fakeIpcMain = {
    handle: (channel, listener) => { calls.push({ type: 'handle', channel, listener }) },
    on: (channel, listener) => { calls.push({ type: 'on', channel, listener }) },
  }
  const registrar = createIpcRegistrar(fakeIpcMain)
  for (const channel of IPC_REGISTRATION_CHANNEL_VALUES) {
    if (channel === IPC_CHANNELS.workspaceContext || channel === IPC_CHANNELS.workspace.theme) registrar.on(channel, () => {})
    else registrar.handle(channel, () => {})
  }
  assert.equal(registrar.assertComplete(), true)
  assert.deepEqual(registrar.registeredChannels(), IPC_REGISTRATION_CHANNEL_VALUES)
  assert.deepEqual(calls.map(call => call.channel), IPC_REGISTRATION_CHANNEL_VALUES)
  assert.equal(calls.find(call => call.channel === IPC_CHANNELS.workspaceContext)?.type, 'on')
  assert.throws(() => registrar.handle(IPC_CHANNELS.status.changed, () => {}), /not an inbound registration/)
  assert.throws(() => registrar.handle(IPC_CHANNELS.status.get, () => {}), /more than once/)
  assert.throws(() => registrar.handle(undefined, () => {}), /Unknown IPC channel/)
  assert.throws(() => registrar.on(undefined, () => {}), /Unknown IPC channel/)
  assert.equal(new Set(IPC_CHANNEL_VALUES).size, IPC_CHANNEL_VALUES.length)
  assert.deepEqual(IPC_EVENT_CHANNEL_VALUES, [IPC_CHANNELS.status.changed, IPC_CHANNELS.updates.changed])

  const incomplete = createIpcRegistrar(fakeIpcMain)
  incomplete.handle(IPC_CHANNELS.status.get, () => {})
  assert.throws(() => incomplete.assertComplete(), /Missing IPC registrations/)
})
