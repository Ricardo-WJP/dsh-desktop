import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { release } from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createWindowHost } from '../src/window-host.js'

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this.url = 'about:blank'
    this.windowOpenHandler = undefined
    this.permissionCheckHandler = undefined
    this.permissionRequestHandler = undefined
    this.session = new EventEmitter()
    this.session.setPermissionCheckHandler = handler => { this.permissionCheckHandler = handler }
    this.session.setPermissionRequestHandler = handler => { this.permissionRequestHandler = handler }
    this.executedScripts = []
    this.debugger = {
      attached: false,
      commands: [],
      isAttached: () => this.debugger.attached,
      attach: version => { this.debugger.attached = true; this.debugger.attachVersion = version },
      sendCommand: (method, params) => {
        this.debugger.commands.push({ method, params })
        return Promise.resolve()
      },
      detach: () => { this.debugger.attached = false; this.debugger.detached = true },
    }
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler
  }

  getURL() {
    return this.url
  }

  executeJavaScript(script, userGesture) {
    this.executedScripts.push({ script, userGesture })
    return Promise.resolve()
  }

  send() {}
}

class FakeBrowserWindow extends EventEmitter {
  static instances = []

  static reset() {
    FakeBrowserWindow.instances = []
  }

  static getAllWindows() {
    return FakeBrowserWindow.instances.filter(window => !window.destroyed)
  }

  constructor(options) {
    super()
    this.options = options
    this._webContents = new FakeWebContents()
    this.visible = options.show === true
    this.minimized = false
    this.destroyed = false
    this.focused = false
    this.ignoreMouseEvents = undefined
    this.loads = []
    this.titleBarOverlays = []
    FakeBrowserWindow.instances.push(this)
  }

  get webContents() {
    if (this.destroyed) throw new Error('Object has been destroyed')
    return this._webContents
  }

  isDestroyed() {
    return this.destroyed
  }

  isVisible() {
    return this.visible
  }

  isMinimized() {
    return this.minimized
  }

  restore() {
    this.minimized = false
  }

  show() {
    this.visible = true
  }

  hide() {
    this.visible = false
  }

  focus() {
    this.focused = true
  }

  setIgnoreMouseEvents(value) {
    this.ignoreMouseEvents = value
  }

  setTitleBarOverlay(value) {
    this.titleBarOverlays.push(value)
  }

  close() {
    if (this.destroyed) return
    const event = { prevented: false, preventDefault: () => { event.prevented = true } }
    this.emit('close', event)
    if (event.prevented) return
    this.destroyed = true
    this.visible = false
    this.emit('closed')
  }

  loadURL(url) {
    this.loads.push({ type: 'url', url })
    this.webContents.url = url
    return Promise.resolve()
  }

  loadFile(file, options) {
    this.loads.push({ type: 'file', file, options })
    this.webContents.url = pathToFileURL(file).href
    return Promise.resolve()
  }

  reload() {
    this.reloaded = true
  }
}

function makeHost({ rendererOrigin, harnessOrigin = 'http://127.0.0.1:43121', onWorkspaceCloseRequested, onRevealRequested, setNativeWindowBorder, getTheme, getDownloadsPath, pathExists } = {}) {
  FakeBrowserWindow.reset()
  const events = []
  const host = createWindowHost({
    BrowserWindow: FakeBrowserWindow,
    shell: { openExternal: url => events.push({ type: 'external', url }) },
    path,
    rendererOrigin,
    getHarnessOrigin: () => harnessOrigin,
    exists: pathExists ?? (() => true),
    callbacks: {
      getLanguage: () => 'en',
      onWorkspaceClosed: () => events.push({ type: 'workspace-closed' }),
      onSplashClosed: () => events.push({ type: 'splash-closed' }),
      ...(onWorkspaceCloseRequested === undefined ? {} : { onWorkspaceCloseRequested }),
      ...(onRevealRequested === undefined ? {} : { onRevealRequested }),
      ...(setNativeWindowBorder === undefined ? {} : { setNativeWindowBorder }),
      ...(getTheme === undefined ? {} : { getTheme }),
      ...(getDownloadsPath === undefined ? {} : { getDownloadsPath }),
    },
  })
  return { host, events }
}

function assertSecurity(window, expectedPreload) {
  assert.deepEqual(window.options.webPreferences, {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    ...(expectedPreload === undefined ? {} : { preload: expectedPreload }),
  })
}

test('window host creates security-hardened windows with role-specific preloads', () => {
  const { host } = makeHost()
  const management = host.create('management')
  const workspace = host.create('workspace')
  const splash = host.create('splash')

  assertSecurity(management, host.generatedPreloadPath('management'))
  assertSecurity(workspace, host.generatedPreloadPath('workspace'))
  assertSecurity(splash, host.generatedPreloadPath('splash'))
  assert.match(management.options.webPreferences.preload, /[\\/]preload\.cjs$/)
  assert.match(workspace.options.webPreferences.preload, /[\\/]workspace-preload\.cjs$/)
  assert.equal(host.getWindow('pluginManager'), undefined)
  assert.doesNotMatch(readFileSync(new URL('../src/window-host.js', import.meta.url), 'utf8'), /MutationObserver/)
  assert.equal(workspace.options.title, 'DeepSeek Harness Desktop')
  assert.equal(workspace.options.width, 1400)
  assert.equal(workspace.options.height, 900)
  if (process.platform === 'win32') {
    assert.equal(workspace.options.autoHideMenuBar, true)
    assert.equal(workspace.options.titleBarStyle, 'hidden')
    assert.deepEqual(workspace.options.titleBarOverlay, {
      color: Number(release().split('.')[2]) >= 22621 ? '#00000000' : '#0c1017',
      symbolColor: '#f9fafb',
      height: 40,
    })
  }
  assert.equal(splash.options.center, true)
  assert.equal(splash.options.width, 1400)
  assert.equal(splash.options.height, 900)
  assert.equal(splash.options.focusable, true)
  assert.equal(splash.options.resizable, true)
  assert.equal(splash.options.movable, true)
  assert.equal(splash.options.minWidth, 840)
  assert.equal(splash.options.minHeight, 600)
  if (process.platform === 'win32') {
    assert.notEqual(splash.options.thickFrame, false)
    assert.notEqual(splash.options.frame, false)
    assert.notEqual(splash.options.transparent, true)
    assert.equal(splash.options.backgroundColor, '#0c1017')
    assert.equal(splash.options.titleBarStyle, 'hidden')
    assert.deepEqual(splash.options.titleBarOverlay, {
      color: '#0c1017',
      symbolColor: '#f9fafb',
      height: 36,
    })
  }
})

test('owned DSH windows force the local no-preference motion policy', () => {
  const { host } = makeHost()
  const windows = [host.create('management'), host.create('workspace'), host.create('splash')]

  for (const window of windows) {
    assert.equal(window.webContents.debugger.attached, true)
    assert.deepEqual(window.webContents.debugger.commands, [{
      method: 'Emulation.setEmulatedMedia',
      params: { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] },
    }])
  }

  windows[1].webContents.emit('did-start-loading')
  assert.equal(windows[1].webContents.debugger.commands.length, 2)
  windows[1].close()
  assert.equal(windows[1]._webContents.debugger.attached, false)
  assert.equal(windows[1]._webContents.debugger.detached, true)
})

test('workspace saves trusted ZIP downloads with a stable user-facing filename', () => {
  const { host } = makeHost({
    getDownloadsPath: () => 'C:\\Users\\tester\\Downloads',
    pathExists: value => !String(value).includes('Downloads'),
  })
  const workspace = host.create('workspace')
  const paths = []
  const download = {
    getURL: () => 'blob:http://127.0.0.1:43121/session-export',
    getFilename: () => '64dc8b67-4958-4ec5-983a-3fde3cf580ce.tmp',
    getMimeType: () => 'application/zip',
    setSavePath: value => paths.push(value),
  }

  workspace.webContents.session.emit('will-download', {}, download, workspace.webContents)
  assert.equal(paths.length, 1)
  assert.match(paths[0], /[\\/]Downloads[\\/]DeepSeek-Harness-Session-\d{8}-\d{6}\.zip$/)

  download.getURL = () => 'blob:https://example.com/untrusted'
  workspace.webContents.session.emit('will-download', {}, download, workspace.webContents)
  assert.equal(paths.length, 1)
})

test('window host themes the native frame for every owned window', () => {
  const calls = []
  const { host } = makeHost({
    getTheme: () => ({ dark: false, windowBorderColor: '#f9fafb' }),
    setNativeWindowBorder: (window, options) => {
      calls.push({ window, options })
      return true
    },
  })
  const management = host.create('management')
  const workspace = host.create('workspace')
  const splash = host.create('splash')

  assert.deepEqual(calls.map(call => call.window), [management, workspace, splash])
  assert.deepEqual(calls.map(call => call.options), [
    { borderColor: '#f9fafb', captionColor: '#f3f5f8', textColor: '#111827' },
    { borderColor: process.platform === 'win32' && Number(release().split('.')[2]) >= 22621 ? 0xfffffffe : '#f9fafb', captionColor: process.platform === 'win32' && Number(release().split('.')[2]) >= 22621 ? 0xffffffff : '#f3f5f8', textColor: '#111827', ...(process.platform === 'win32' && Number(release().split('.')[2]) >= 22621 ? { cornerPreference: 2 } : {}) },
    { borderColor: '#f9fafb', captionColor: '#f3f5f8', textColor: '#111827' },
  ])
  assert.equal(workspace.options.titleBarStyle, process.platform === 'win32' ? 'hidden' : undefined)
  assert.notEqual(workspace.options.frame, false)
  assert.equal(workspace.options.thickFrame, process.platform === 'win32' && Number(release().split('.')[2]) >= 22621 ? false : undefined)
  if (process.platform === 'win32' && Number(release().split('.')[2]) >= 22621) {
    assert.equal(workspace.options.backgroundMaterial, 'none')
    assert.equal(workspace.options.transparent, true)
    assert.equal(workspace.options.backgroundColor, '#00000000')
    assert.equal(splash.options.backgroundMaterial, undefined)
    assert.equal(management.options.backgroundMaterial, undefined)
  }
})

test('workspace title-bar history stays inside the active Harness origin', () => {
  const { host } = makeHost()
  const workspace = host.create('workspace')
  let activeIndex = 2
  const movements = []
  workspace.webContents.navigationHistory = {
    getAllEntries: () => [
      { url: 'file:///C:/desktop/loading.html' },
      { url: 'http://127.0.0.1:43121/tasks' },
      { url: 'http://127.0.0.1:43121/session/2' },
      { url: 'http://127.0.0.1:43121/settings' },
    ],
    getActiveIndex: () => activeIndex,
    goBack: () => { activeIndex -= 1; movements.push('back') },
    goForward: () => { activeIndex += 1; movements.push('forward') },
  }

  assert.deepEqual(host.navigateWorkspaceHistory('back'), { moved: true, direction: 'back' })
  assert.deepEqual(host.navigateWorkspaceHistory('back'), { moved: false, reason: 'outside-harness' })
  assert.deepEqual(host.navigateWorkspaceHistory('forward'), { moved: true, direction: 'forward' })
  assert.deepEqual(movements, ['back', 'forward'])
  assert.throws(() => host.navigateWorkspaceHistory('reload'), /Invalid workspace navigation direction/)
})

test('workspace reapplies its themed DWM border after frame lifecycle changes', () => {
  const sequence = []
  let borderColor = '#f9fafb'
  const { host } = makeHost({
    getTheme: () => ({ dark: borderColor === '#0c1017', windowBorderColor: borderColor }),
    setNativeWindowBorder: (_window, options) => {
      sequence.push({ type: 'border', color: options.borderColor })
      return true
    },
  })
  const workspace = host.create('workspace')
  sequence.length = 0
  for (const event of ['ready-to-show', 'show', 'focus', 'blur', 'restore', 'maximize', 'unmaximize']) {
    workspace.emit(event)
  }
  workspace.webContents.emit('did-finish-load')
  const acrylic = process.platform === 'win32' && Number(release().split('.')[2]) >= 22621
  assert.deepEqual(sequence, Array.from({ length: 8 }, () => ({ type: 'border', color: acrylic ? 0xfffffffe : '#f9fafb' })))

  borderColor = '#0c1017'
  sequence.length = 0
  host.updateTheme()
  assert.deepEqual(sequence, [{ type: 'border', color: acrylic ? 0xfffffffe : '#0c1017' }])
})

test('workspace navigation wiring preserves exact Harness allow-list and redirect denial', () => {
  const { host, events } = makeHost()
  const workspace = host.create('workspace')
  const prevented = []
  const event = { preventDefault: () => prevented.push(true) }

  assert.deepEqual(workspace.webContents.windowOpenHandler({ url: 'https://outside.example/' }), { action: 'deny' })
  workspace.webContents.emit('will-navigate', event, 'http://127.0.0.1:43121/workspace')
  workspace.webContents.emit('will-redirect', event, 'https://outside.example/redirect')
  assert.equal(prevented.length, 1)
  assert.deepEqual(events, [
    { type: 'external', url: 'https://outside.example/' },
    { type: 'external', url: 'https://outside.example/redirect' },
  ])

  assert.equal(workspace.webContents.permissionCheckHandler(undefined, 'clipboard-sanitized-write', 'http://127.0.0.1:43121'), true)
  assert.equal(workspace.webContents.permissionCheckHandler(undefined, 'notifications', 'http://127.0.0.1:43121'), true)
  assert.equal(workspace.webContents.permissionCheckHandler(undefined, 'notifications', 'http://127.0.0.1:43121/'), true)
  assert.equal(workspace.webContents.permissionCheckHandler(undefined, 'notifications', 'http://127.0.0.1:43121/workspace'), true)
  assert.equal(workspace.webContents.permissionCheckHandler(undefined, 'media', 'http://127.0.0.1:43121', { mediaType: 'audio' }), true)
  assert.equal(workspace.webContents.permissionCheckHandler(undefined, 'media', 'http://127.0.0.1:43121', { mediaType: 'video' }), false)
  assert.equal(workspace.webContents.permissionCheckHandler(undefined, 'media', 'http://127.0.0.1:43121', {}), false)
  assert.equal(workspace.webContents.permissionCheckHandler(undefined, 'clipboard-sanitized-write', 'http://127.0.0.1:43122'), false)
  assert.equal(workspace.webContents.permissionCheckHandler(undefined, 'notifications', 'not-an-origin'), false)
  let permission
  workspace.webContents.permissionRequestHandler({ getURL: () => 'http://127.0.0.1:43121/path' }, 'clipboard-sanitized-write', value => { permission = value })
  assert.equal(permission, true)
  workspace.webContents.permissionRequestHandler({ getURL: () => 'http://127.0.0.1:43121/path' }, 'notifications', value => { permission = value })
  assert.equal(permission, true)
  workspace.webContents.permissionRequestHandler(
    { getURL: () => 'http://127.0.0.1:43121/path' },
    'media',
    value => { permission = value },
    { requestingUrl: 'http://127.0.0.1:43121/path', mediaTypes: ['audio'] },
  )
  assert.equal(permission, true)
  workspace.webContents.permissionRequestHandler(
    { getURL: () => 'http://127.0.0.1:43121/path' },
    'media',
    value => { permission = value },
    { requestingUrl: 'http://127.0.0.1:43121/path', mediaTypes: ['audio', 'video'] },
  )
  assert.equal(permission, false)
  workspace.webContents.permissionRequestHandler({ getURL: () => 'https://outside.example/' }, 'clipboard-sanitized-write', value => { permission = value })
  assert.equal(permission, false)
})

test('workspace sends only trusted OAuth popup navigation to the system browser', () => {
  const { host, events } = makeHost()
  const workspace = host.create('workspace')
  const allowed = workspace.webContents.windowOpenHandler({ url: 'about:blank' })
  assert.equal(allowed.action, 'allow')
  assert.equal(allowed.overrideBrowserWindowOptions.show, false)
  assert.equal(allowed.overrideBrowserWindowOptions.webPreferences.sandbox, true)

  const trustedPopup = new FakeBrowserWindow({ show: false })
  workspace.webContents.emit('did-create-window', trustedPopup, { url: 'about:blank' })
  let prevented = false
  trustedPopup.webContents.emit('will-navigate', { preventDefault: () => { prevented = true } }, 'https://auth.openai.com/oauth/authorize')
  assert.equal(prevented, true)
  assert.equal(trustedPopup.isDestroyed(), true)
  assert.deepEqual(events, [{ type: 'external', url: 'https://auth.openai.com/oauth/authorize' }])

  const untrustedPopup = new FakeBrowserWindow({ show: false })
  workspace.webContents.emit('did-create-window', untrustedPopup, { url: 'about:blank' })
  untrustedPopup.webContents.emit('will-navigate', { preventDefault() {} }, 'https://outside.example/oauth')
  assert.equal(untrustedPopup.isDestroyed(), true)
  assert.equal(events.length, 1)
})

test('management routes load exact production files and development loopback URLs', async () => {
  const lazy = makeHost()
  assert.equal(await lazy.host.loadManagementRoute('update', { lang: 'zh' }), true)
  const lazyWindow = lazy.host.getWindow('management')
  assert.equal(lazyWindow.visible, true)
  assert.equal(lazyWindow.focused, true)
  assert.deepEqual(lazyWindow.loads[0], {
    type: 'file',
    file: lazy.host.rendererEntryPath(),
    options: { query: { route: 'update', lang: 'zh' } },
  })

  const production = makeHost()
  const productionWindow = production.host.create('management')
  assert.equal(await production.host.loadManagementRoute('overview', { lang: 'en', progress: 42 }), true)
  assert.deepEqual(productionWindow.loads[0], {
    type: 'file',
    file: production.host.rendererEntryPath(),
    options: { query: { route: 'overview', lang: 'en', progress: '42' } },
  })

  const development = makeHost({ rendererOrigin: 'http://127.0.0.1:5173' })
  const developmentWindow = development.host.create('management')
  assert.equal(development.host.managementRendererOrigin, 'http://127.0.0.1:5173')
  assert.equal(await development.host.loadManagementRoute('overview', { lang: 'en' }), true)
  assert.equal(developmentWindow.loads[0].url, 'http://127.0.0.1:5173#/overview?route=overview&lang=en')
  assert.equal(development.host.managementRendererAvailable(), true)
})

test('focus, loading window and reveal/close behavior are host-owned', async () => {
  const { host, events } = makeHost({ rendererOrigin: 'http://127.0.0.1:5173' })
  const splash = host.create('splash')
  const workspace = host.create('workspace')
  workspace.minimized = true
  assert.equal(host.show('splash'), true)
  assert.equal(splash.ignoreMouseEvents, false)
  assert.equal(splash.focused, true)
  assert.equal(host.focus('workspace'), true)
  assert.equal(workspace.minimized, false)
  assert.equal(workspace.focused, true)
  assert.equal(host.currentLoadingWindow(), splash)

  assert.equal(host.reveal(), true)
  assert.equal(workspace.visible, true)
  assert.equal(splash.isDestroyed(), true)
  assert.equal(host.currentLoadingWindow(), workspace)

  host.close('workspace')
  assert.equal(host.getWindow('workspace'), undefined)
  assert.deepEqual(events.filter(event => event.type === 'workspace-closed'), [{ type: 'workspace-closed' }])
})

test('reveal can be held by the first-run onboarding surface without closing the splash', () => {
  let holds = true
  const { host } = makeHost({
    onRevealRequested: () => holds,
  })
  const splash = host.create('splash')
  const workspace = host.create('workspace')

  assert.equal(host.reveal(), true)
  assert.equal(workspace.isVisible(), false)
  assert.equal(splash.isDestroyed(), false)
  holds = false
  assert.equal(host.reveal(), true)
  assert.equal(workspace.isVisible(), true)
  assert.equal(splash.isDestroyed(), true)
})

test('closing the splash tolerates a stale destroyed workspace reference', () => {
  const { host, events } = makeHost()
  const workspace = host.create('workspace')
  const splash = host.create('splash')
  workspace.isDestroyed = () => { throw new Error('Object has been destroyed') }
  workspace.isVisible = () => { throw new Error('Object has been destroyed') }

  assert.doesNotThrow(() => splash.close())
  assert.deepEqual(events.filter(event => event.type === 'splash-closed'), [{ type: 'splash-closed' }])
})

test('theme refresh ignores native calls racing BrowserWindow teardown', () => {
  const { host } = makeHost()
  const workspace = host.create('workspace')
  workspace.setTitleBarOverlay = () => { throw new Error('Object has been destroyed') }
  assert.doesNotThrow(() => host.updateTheme())
})

test('workspace close can be converted into a tray hide without destroying the owner', () => {
  const { host } = makeHost({
    onWorkspaceCloseRequested: window => {
      window.hide()
      return true
    },
  })
  const workspace = host.create('workspace')
  workspace.show()
  workspace.close()
  assert.equal(workspace.isDestroyed(), false)
  assert.equal(workspace.isVisible(), false)
  assert.equal(host.getWindow('workspace'), workspace)
})
