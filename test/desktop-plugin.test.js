import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const packageUrl = new URL('../src/plugins/dsh-desktop-integration/package.json', import.meta.url)
const clientUrl = new URL('../src/plugins/dsh-desktop-integration/lib/client.js', import.meta.url)
const overlayUrl = new URL('../src/dsh-desktop.patch.yml', import.meta.url)
const preloadUrl = new URL('../build/preload/workspace-preload.cjs', import.meta.url)
const mainUrl = new URL('../src/main.js', import.meta.url)
const hostUrl = new URL('../src/ipc/desktop-host.js', import.meta.url)

test('desktop adapter is a standalone dual-face DSH client package', () => {
  const manifest = JSON.parse(readFileSync(packageUrl, 'utf8'))
  assert.equal(manifest.name, '@dsh-desktop/integration')
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-workspace',
    '@deepseek-ai/dsh-client-ui-theme',
  ])
})

test('desktop overlay adds only the adapter plugin', () => {
  const overlay = readFileSync(overlayUrl, 'utf8')
  assert.match(overlay, /id: dsh-desktop-integration/)
  assert.match(overlay, /name: '@dsh-desktop\/integration'/)
  assert.doesNotMatch(overlay, /id:\s+(?:api-gateway|ui-conversation|ui-workspace)\b/)
})

test('client adapter exposes native actions without spawning local processes', () => {
  const source = readFileSync(clientUrl, 'utf8')
  assert.match(source, /workspaces\.openPath = openPath/)
  assert.match(source, /bridge\.openPath\(path, 'auto'\)/)
  assert.match(source, /bridge\.publishWorkspaceContext/)
  assert.match(source, /bridge\.reportTheme/)
  assert.match(source, /ctx\.theme\.getTheme\(\)/)
  assert.match(source, /ctx\.on\('theme\/change'/)
  assert.doesNotMatch(source, /conversation\.session\.header|padding-right:146px|translateY\(8px\)/)
  assert.match(source, /data-dsh-taskboard-entry/)
  assert.match(source, /data-dsh-skill-explorer-entry/)
  assert.match(source, /width:16px!important/)
  assert.match(source, /body\[data-ds-dark-theme\] \.dcu-root/)
  assert.match(source, /--dcu-sidebar-active:#313236/)
  assert.match(source, /prefers-color-scheme:light/)
  assert.match(source, /body:not\(\[data-ds-dark-theme\]\) \.dcu-root\{background:#f1f2f4!important/)
  assert.match(source, /header:has\(\[data-dcu-inline-tabs\]\)\{box-sizing:border-box!important;height:42px!important;min-height:42px!important;padding-top:6px!important;padding-bottom:6px!important/)
  assert.match(source, /\[class\*="headerUtilities"\].*align-self:center!important/)
  assert.match(source, /\.nArs4W_panel \.nArs4W_pane>\.nArs4W_tabBar\{box-sizing:border-box!important;height:42px!important;min-height:42px!important/)
  assert.match(source, /\.nArs4W_panel \.nArs4W_pane>\.nArs4W_tabBar \.nArs4W_tab\{box-sizing:border-box!important;height:40px!important;min-height:40px!important/)
  assert.match(source, /installCodexTaskBoardBridge/)
  assert.match(source, /dshDesktopTaskboardAnchor newSession/)
  assert.match(source, /dshDesktopTaskboardSource/)
  assert.match(source, /data-dsh-taskboard-proxy/)
  assert.match(source, /expandedButton = entry\.cloneNode\(true\)/)
  assert.match(source, /dshDesktopCodexTaskboardCompact/)
  assert.doesNotMatch(source, /dsh-desktop-workspace-editor/)
  assert.match(source, /installWorkspaceMenuActions/)
  assert.doesNotMatch(source, /dshDesktopWindowDragRegion|-webkit-app-region:drag/)
  assert.match(source, /installLayoutCompatibility/)
  assert.match(source, /installNativeSettingsDocumentBridge/)
  assert.match(source, /bridge\.openSettingsDocument\(\)/)
  assert.match(source, /dshDesktopSidebarTooltip/)
  assert.match(source, /data-dsh-desktop-compact-action/)
  assert.match(source, /\.dcu-compact-shell button/)
  assert.match(source, /button\.closest\('\[role="dialog"\]'\) !== null/)
  assert.match(source, /data-dsh-desktop-custom-settings-icon/)
  assert.match(source, /dshDesktopCustomSettingsIcon = 'true'/)
  assert.doesNotMatch(source, /DESKTOP_DEFERRED_MARKET_UPDATES/)
  assert.match(source, /dshDesktopManagedMarketCompatibility/)
  assert.doesNotMatch(source, /body\[data-dsh-sidebar-collapsed\] \[data-dsh-taskboard-entry\]/)
  assert.doesNotMatch(source, /(?:max-)?width:calc\(100% - var\(--dsh-sidebar-width/)
  assert.match(source, /const panelOpen = panelWidth > 1/)
  assert.match(source, /setAttribute\('data-dsh-desktop-panel-open', 'true'\)/)
  assert.match(source, /data-dsh-desktop-settings-list/)
  assert.match(source, /data-dsh-desktop-settings-overlay/)
  assert.match(source, /data-dsh-desktop-settings-dialog/)
  assert.match(source, /data-dsh-desktop-settings-ancestor/)
  assert.match(source, /Only the native DSH Settings dialog owns a navigation rail/)
  assert.match(source, /dshDesktopSettingsAncestor = 'true'/)
  assert.match(source, /transform:none!important;translate:none!important;scale:none!important/)
  assert.match(source, /delete element\.dataset\.dshDesktopSettingsAncestor/)
  assert.match(source, /inset:40px 0 0!important/)
  assert.match(source, /height:min\(700px,calc\(100vh - 88px\)\)!important/)
  assert.match(source, /\.dyn-opt-pop,\.dyn-opt-result\{left:auto!important;right:0!important/)
  assert.match(source, /dyn-opt-select option\{background-color:#2c2c2e!important;color:#f5f5f7!important/)
  assert.match(source, /overlay\.dataset\.dshDesktopSettingsOverlay = 'true'/)
  assert.match(source, /delete element\.dataset\.dshDesktopSettingsOverlay/)
  assert.match(source, /\.dcu-expanded-shell\{flex:1 1 0!important/)
  assert.match(source, /\.dcu-root\{width:100%!important;min-width:0!important\}/)
  assert.match(source, /\.dcu-root>\.dcu-expanded-shell\{width:100%!important;min-width:0!important\}/)
  assert.match(source, /\.dcu-root>\.dcu-expanded-shell>\.dcu-head\{box-sizing:border-box!important;width:100%!important;min-width:0!important;overflow:hidden!important\}/)
  assert.match(source, /\.dcu-root>\.dcu-expanded-shell>\.dcu-head-actions\{min-width:64px!important;flex:none!important\}/)
  assert.match(source, /semanticTree = workspace\.querySelector/)
  assert.match(source, /padding-bottom:16px!important/)
  assert.match(source, /dcu-compact-nav/)
  assert.match(source, /data-dsh-desktop-sidebar-defaults/)
  assert.match(source, /const processedStartupControls = new WeakSet\(\)/)
  assert.match(source, /new Set\(\['task', 'extensions', 'pinned', 'recent'\]\)/)
  assert.match(source, /processedStartupControls\.has\(button\)/)
  assert.match(source, /defaultsApplied \? 'applied' : 'applying'/)
  assert.match(source, /data-dsh-desktop-expert-button/)
  assert.match(source, /\.aag-btn>span/)
  assert.match(source, /padding:0 6px!important/)
  assert.match(source, /markExpertComposerButton/)
  assert.match(source, /markComposerActionLayout/)
  assert.match(source, /dshDesktopComposerActionButton/)
  assert.match(source, /conversation\.input\.model/)
  assert.doesNotMatch(source, /actionRects|--dsh-desktop-composer-action-shift', '\$\{/)
  assert.match(source, /closest\('\.dcu-settings-seat'\)/)
  assert.match(source, /available \? 60_000 : 8_000/)
  assert.match(source, /'editor', pendingPath, 'editor'/)
  assert.match(source, /'fileManager', pendingPath, 'default'/)
  assert.match(source, /用编辑器打开/)
  assert.match(source, /打开文件夹/)
  assert.match(source, /Open Folder/)
  assert.doesNotMatch(source, /child_process|exec\(|spawn\(/)
})

test('preload and main process pass only recognized native open intents', () => {
  const preload = readFileSync(preloadUrl, 'utf8')
  const main = readFileSync(mainUrl, 'utf8')
  const host = readFileSync(hostUrl, 'utf8')
  assert.match(preload, /openPath: \(path, intent = 'auto'\)/)
  assert.match(host, /\['auto', 'editor', 'default'\]\.includes\(intent\)/)
  assert.match(host, /callEffect\('openPath', path, intent\)/)
  assert.match(main, /openPath: \(path, intent\) => reportDesktopAction\(\(\) => openDesktopPath\(path, intent\)\)/)
})

test('desktop-managed market updates survive market package replacement and fail closed', async () => {
  const source = readFileSync(clientUrl, 'utf8')
  const preload = readFileSync(preloadUrl, 'utf8')
  let registration
  let managedRequest
  let managedInstallRequest
  let activationRequested = false
  let marketClick
  class FakeElement {
    constructor(textContent) { this.textContent = textContent }
    closest() { return this }
  }
  const bridge = {
    openPath: async () => ({ ok: true }),
    publishWorkspaceContext: () => {},
    installMarketPlugin: async request => {
      managedInstallRequest = request
      return { ok: true, report: { candidateId: 'candidate-market-install' } }
    },
    updateMarketPlugin: async request => {
      managedRequest = request
      return { ok: true, report: { candidateId: 'candidate-market-update' } }
    },
    activateMarketUpdate: async () => {
      activationRequested = true
      return { ok: true }
    },
  }
  const nativeFetch = async input => {
    const url = String(input)
    if (url.startsWith('/dsh-market/updates')) {
      return new Response(JSON.stringify({
        updates: {
          dshmarket: { kind: 'npm', latest: '1.31.1', updateAvailable: true },
          'plugin-a': { kind: 'npm', latest: '1.2.3', updateAvailable: true },
          'plugin-b': { kind: 'npm', latest: '2.3.4', updateAvailable: true },
          '@linxin666/dsh-client-ui-task-board': { kind: 'npm', current: '0.3.6', latest: '0.3.10', updateAvailable: true },
          '@linxin666/dsh-doctor': { kind: 'npm', current: '0.3.10', latest: '0.3.11', updateAvailable: true },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`Unexpected native fetch: ${url}`)
  }
  const context = vm.createContext({
    console,
    dshDesktop: bridge,
    fetch: nativeFetch,
    URL,
    Request,
    Response,
    Element: FakeElement,
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, setAttribute() {}, remove() {} }),
      head: { append() {} },
      addEventListener: (type, callback) => { if (type === 'click') marketClick = callback },
      removeEventListener() {},
    },
    location: new URL('http://127.0.0.1:3080/'),
    setTimeout: callback => { callback(); return 1 },
    clearTimeout: () => {},
    window: { __ModuleLoader__: { load: value => { registration = value } } },
  })
  vm.runInContext(source, context)
  const plugin = registration.factory(() => assert.fail('client adapter should not require UI modules'))
  const snapshot = { items: [], current: undefined }
  const effects = []
  plugin.apply({
    sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} }, openPath: async () => {} },
    locale: { register: () => () => {}, bind: () => key => key },
    effect: callback => {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push(dispose)
    },
  })

  const response = await context.fetch('/dsh-market/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'dshmarket' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(JSON.stringify(managedRequest)), { name: 'dshmarket', kind: 'npm', target: '1.31.1' })
  assert.equal(activationRequested, true)
  const liveProbe = await context.fetch('/dsh-market/updates?force=1')
  const liveUpdates = JSON.parse(await liveProbe.text()).updates
  assert.equal(liveUpdates['@linxin666/dsh-client-ui-task-board'].updateAvailable, true)
  assert.equal(liveUpdates['@linxin666/dsh-doctor'].updateAvailable, true)
  activationRequested = false
  marketClick({ target: new FakeElement('全部更新') })
  const batchResponse = await context.fetch('/dsh-market/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'plugin-a' }),
  })
  assert.equal(batchResponse.status, 200)
  assert.deepEqual(JSON.parse(JSON.stringify(managedRequest)), {
    updates: [
      { name: 'dshmarket', kind: 'npm', target: '1.31.1' },
      { name: 'plugin-a', kind: 'npm', target: '1.2.3' },
      { name: 'plugin-b', kind: 'npm', target: '2.3.4' },
      { name: '@linxin666/dsh-client-ui-task-board', kind: 'npm', target: '0.3.10' },
      { name: '@linxin666/dsh-doctor', kind: 'npm', target: '0.3.11' },
    ],
  })
  assert.equal(JSON.parse(await batchResponse.text()).batchSize, 5)
  activationRequested = false
  const installResponse = await context.fetch('/dsh-market/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://github.com/HanaAyane/dsh-reasoning-effort' }),
  })
  assert.equal(installResponse.status, 200)
  assert.deepEqual(JSON.parse(JSON.stringify(managedInstallRequest)), { url: 'https://github.com/HanaAyane/dsh-reasoning-effort' })
  assert.equal(activationRequested, true)
  assert.equal(context.fetch.dshDesktopManagedMarketInstall, true)
  assert.match(preload, /installMarketPlugin: request => ipcRenderer\.invoke\(channels\.plugins\.marketInstall, request\)/)
  assert.match(preload, /updateMarketPlugin: request => ipcRenderer\.invoke\(channels\.plugins\.marketUpdate, request\)/)
  assert.match(preload, /activateMarketUpdate: \(\) => ipcRenderer\.invoke\(channels\.plugins\.activateMarketUpdate\)/)
  assert.doesNotMatch(source, /node_modules[\\/]dshmarket|writeFile|child_process/)

  for (const dispose of effects.reverse()) dispose()
  assert.equal(context.fetch, nativeFetch)
})

test('client adapter replaces and restores the Harness path action at runtime', async () => {
  const source = readFileSync(clientUrl, 'utf8')
  let registration
  const opened = []
  const published = []
  const bridge = {
    openPath: async (path, intent) => {
      opened.push({ path, intent })
      return { ok: true }
    },
    publishWorkspaceContext: value => published.push(value),
  }
  const context = vm.createContext({
    console,
    dshDesktop: bridge,
    window: { __ModuleLoader__: { load: value => { registration = value } } },
  })
  vm.runInContext(source, context)

  assert.equal(registration.id, '@dsh-desktop/integration')
  const plugin = registration.factory(() => assert.fail('client adapter should not require UI modules'))
  assert.deepEqual(Array.from(plugin.inject), ['sessions', 'workspaces', 'locale', 'theme'])

  const subscribers = []
  const originalOpenPath = async () => { throw new Error('unexpected fallback') }
  const workspaceSnapshot = {
    items: [{ path: '/workspace', workspaceId: 'workspace-1' }],
    recentWorkspaceId: 'workspace-1',
  }
  const workspaces = {
    list: {
      getSnapshot: () => workspaceSnapshot,
      subscribe: callback => {
        subscribers.push(callback)
        return () => {}
      },
    },
    openPath: originalOpenPath,
  }
  const sessionSnapshot = {
    current: 'session-1',
    byId: { 'session-1': { cwd: '/workspace' } },
  }
  const sessions = {
    list: {
      getSnapshot: () => sessionSnapshot,
      subscribe: callback => {
        subscribers.push(callback)
        return () => {}
      },
    },
  }
  const effects = []
  plugin.apply({
    sessions,
    workspaces,
    locale: {
      register: () => () => {},
      bind: () => key => key,
    },
    effect: callback => {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push(dispose)
    },
  })

  assert.notEqual(workspaces.openPath, originalOpenPath)
  await workspaces.openPath('/workspace/src/main.js')
  assert.deepEqual(opened, [{ path: '/workspace/src/main.js', intent: 'auto' }])
  assert.deepEqual(JSON.parse(JSON.stringify(published)), [{ active: '/workspace', roots: ['/workspace'] }])
  assert.equal(subscribers.length, 2)
  sessionSnapshot.current = undefined
  subscribers[0]()
  assert.deepEqual(JSON.parse(JSON.stringify(published.at(-1))), { active: '/workspace', roots: ['/workspace'] })

  for (const dispose of effects.reverse()) dispose()
  assert.equal(workspaces.openPath, originalOpenPath)
})
