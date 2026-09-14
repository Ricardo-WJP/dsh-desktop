import { existsSync } from 'node:fs'
import { release } from 'node:os'
import * as defaultPath from 'node:path'
import {
  createMainNavigationPolicy,
  createManagementNavigationPolicy,
} from './navigation.js'
import { applyWindowsWindowFrameTheme } from './windows-window-frame.js'
import { installShellUiOverrides } from './shell-ui-overrides.js'
import { installUpdateUi } from './update-ui.js'

const MANAGEMENT_ROUTES = new Set([
  'loading',
  'overview',
  'mode',
  'update',
  'recovery',
  'diagnostics',
  'error',
])

const PRELOAD_FILES = Object.freeze({
  management: 'preload.cjs',
  workspace: 'workspace-preload.cjs',
  splash: 'splash-preload.cjs',
})

const DEFAULT_TITLE_BAR_COLOR = '#0c1017'
const WORKSPACE_TITLE_BAR_HEIGHT = 40
const WORKSPACE_ACRYLIC = process.platform === 'win32' && Number(release().split('.')[2]) >= 22621
const SPLASH_TITLE_BAR_HEIGHT = 36
const DSH_MOTION_MEDIA = Object.freeze({
  features: Object.freeze([
    Object.freeze({ name: 'prefers-reduced-motion', value: 'no-preference' }),
  ]),
})

function resolveValue(value, fallback) {
  try {
    const resolved = typeof value === 'function' ? value() : value
    return resolved === undefined ? fallback : resolved
  } catch {
    return fallback
  }
}

function isOpen(window) {
  try {
    return window?.isDestroyed?.() === false
  } catch {
    return false
  }
}

function callCallback(callback, ...args) {
  if (typeof callback !== 'function') return undefined
  try { return callback(...args) } catch { return undefined }
}

function normalizeQuery(values) {
  if (values === undefined || values === null || typeof values !== 'object' || Array.isArray(values)) return {}
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]))
}

function validateManagementRoute(route) {
  if (typeof route !== 'string' || !MANAGEMENT_ROUTES.has(route)) throw new TypeError('Invalid management route')
  return route
}

/**
 * Owns the Electron window surface without owning any runtime, update, or IPC
 * state. The main process supplies those owners through callbacks and keeps this
 * adapter executable with a fake Electron surface in tests.
 */
export function createWindowHost({
  BrowserWindow,
  shell = {},
  path = defaultPath,
  rendererOrigin,
  getHarnessOrigin = () => undefined,
  callbacks = {},
  exists = existsSync,
} = {}) {
  if (typeof BrowserWindow !== 'function') throw new TypeError('Invalid BrowserWindow constructor')
  if (typeof path?.join !== 'function') throw new TypeError('Invalid path adapter')
  if (typeof getHarnessOrigin !== 'function') throw new TypeError('Invalid Harness origin callback')
  if (typeof exists !== 'function') throw new TypeError('Invalid path existence callback')

  const join = path.join.bind(path)
  const callback = (name, fallback) => typeof callbacks?.[name] === 'function' ? callbacks[name] : fallback
  const isQuitting = callback('isQuitting', () => false)
  const generatedPreloadOverride = callback('generatedPreloadPath')
  const rendererPathOverride = callback('rendererEntryPath')
  const pagePathOverride = callback('pagePath')
  const getDesktopIcon = callback('getDesktopIcon', () => join(import.meta.dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'))
  const getTheme = callback('getTheme', () => ({ dark: true, windowBackground: '#0c1017', titleBarColor: DEFAULT_TITLE_BAR_COLOR, titleBarSymbolColor: '#f9fafb' }))
  const getDownloadsPath = callback('getDownloadsPath', () => undefined)
  const setNativeWindowBorder = callback('setNativeWindowBorder', applyWindowsWindowFrameTheme)

  let managementWindow
  let workspaceWindow
  let splashWindow
  let managementRendererOrigin
  const acrylicWindows = new WeakSet()

  function desktopIcon() {
    return resolveValue(getDesktopIcon, join(import.meta.dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'))
  }

  function theme() {
    const supplied = resolveValue(getTheme, {})
    return {
      dark: supplied?.dark !== false,
      windowBackground: supplied?.windowBackground ?? (supplied?.dark === false ? '#f3f5f8' : '#0c1017'),
      titleBarColor: supplied?.titleBarColor ?? (supplied?.dark === false ? '#f3f5f8' : DEFAULT_TITLE_BAR_COLOR),
      titleBarSymbolColor: supplied?.titleBarSymbolColor ?? (supplied?.dark === false ? '#111827' : '#f9fafb'),
      windowBorderColor: supplied?.windowBorderColor ?? (supplied?.dark === false ? '#f9fafb' : '#0c1017'),
    }
  }

  function applyNativeWindowFrame(window) {
    if (!isOpen(window)) return false
    const nextTheme = theme()
    return callCallback(setNativeWindowBorder, window, {
      borderColor: acrylicWindows.has(window) ? 0xfffffffe : nextTheme.windowBorderColor,
      captionColor: acrylicWindows.has(window) ? 0xffffffff : nextTheme.titleBarColor,
      textColor: nextTheme.titleBarSymbolColor,
      ...(acrylicWindows.has(window) ? { cornerPreference: 2 } : {}),
    }) === true
  }

  function installNativeWindowFrame(window) {
    const reapply = () => applyNativeWindowFrame(window)
    // Electron and DWM can recalculate the non-client frame after creation,
    // navigation, activation, maximize and restore. Microsoft explicitly makes
    // the app responsible for refreshing DWMWA_BORDER_COLOR on state changes.
    for (const event of ['ready-to-show', 'show', 'focus', 'blur', 'restore', 'maximize', 'unmaximize']) {
      window.on?.(event, reapply)
    }
    window.webContents?.on?.('did-finish-load', reapply)
    reapply()
  }

  function applyWindowTheme(window) {
    if (!isOpen(window)) return false
    try {
      const nextTheme = theme()
      const icon = desktopIcon()
      if (typeof window.setIcon === 'function' && typeof icon === 'string') window.setIcon(icon)
      if (process.platform === 'win32' && (window === workspaceWindow || window === splashWindow) && typeof window.setTitleBarOverlay === 'function') {
        window.setTitleBarOverlay({
          color: window === splashWindow ? nextTheme.windowBackground : WORKSPACE_ACRYLIC ? '#00000000' : nextTheme.titleBarColor,
          symbolColor: nextTheme.titleBarSymbolColor,
          height: window === splashWindow ? SPLASH_TITLE_BAR_HEIGHT : WORKSPACE_TITLE_BAR_HEIGHT,
        })
      }
      applyNativeWindowFrame(window)
      return true
    } catch {
      // Native BrowserWindow methods throw after the underlying window begins
      // teardown even when the JavaScript reference is still reachable.
      return false
    }
  }

  function installDshMotionPolicy(window) {
    const webContents = window?.webContents
    const debuggerApi = webContents?.debugger
    if (typeof debuggerApi?.attach !== 'function' || typeof debuggerApi?.sendCommand !== 'function') return false

    let attachedByHost = false
    try {
      const alreadyAttached = typeof debuggerApi.isAttached === 'function' && debuggerApi.isAttached()
      if (!alreadyAttached) {
        debuggerApi.attach('1.3')
        attachedByHost = true
      }

      const apply = () => {
        try {
          const pending = debuggerApi.sendCommand('Emulation.setEmulatedMedia', DSH_MOTION_MEDIA)
          pending?.catch?.(() => {})
        } catch {
          // A platform without Electron's debugger protocol keeps its native
          // media preference and remains fully usable.
        }
      }
      apply()
      const onStartLoading = () => apply()
      webContents.on?.('did-start-loading', onStartLoading)
      window.once?.('closed', () => {
        // BrowserWindow.webContents throws after the BrowserWindow has been
        // destroyed. Keep the captured WebContents reference for teardown.
        webContents.removeListener?.('did-start-loading', onStartLoading)
        if (!attachedByHost || typeof debuggerApi.detach !== 'function') return
        try {
          if (typeof debuggerApi.isAttached !== 'function' || debuggerApi.isAttached()) debuggerApi.detach()
        } catch {
          // The window is already closing; there is nothing left to recover.
        }
      })
      return true
    } catch {
      if (attachedByHost && typeof debuggerApi.detach === 'function') {
        try { debuggerApi.detach() } catch { /* keep startup resilient */ }
      }
      return false
    }
  }

  function rendererDevelopmentUrl() {
    const supplied = resolveValue(rendererOrigin, undefined)
    if (supplied === undefined || supplied === null || String(supplied).trim() === '') return undefined
    const value = typeof supplied === 'object' && supplied !== null
      ? supplied.url ?? supplied.rendererUrl ?? supplied.origin
      : supplied
    if (typeof value !== 'string' || value.trim() === '') return undefined
    try {
      const parsed = new URL(value)
      if (!['http:', 'https:'].includes(parsed.protocol)) return undefined
      if (parsed.username !== '' || parsed.password !== '') return undefined
      if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return undefined
      return parsed.origin
    } catch {
      return undefined
    }
  }

  function rendererEntryPath() {
    if (typeof rendererPathOverride === 'function') return rendererPathOverride()
    return join(import.meta.dirname, '..', 'build', 'renderer', 'index.html')
  }

  function pagePath(name) {
    if (typeof pagePathOverride === 'function') return pagePathOverride(name)
    return join(import.meta.dirname, 'pages', name)
  }

  function generatedPreloadPath(roleOrFilename) {
    if (typeof generatedPreloadOverride === 'function') return generatedPreloadOverride(roleOrFilename)
    const filename = PRELOAD_FILES[roleOrFilename] ?? roleOrFilename
    if (typeof filename !== 'string' || filename.trim() === '') throw new TypeError(`Invalid preload role: ${String(roleOrFilename)}`)
    const generated = join(import.meta.dirname, '..', 'build', 'preload', filename)
    if (!exists(generated)) throw new Error(`Generated preload is missing: ${generated}; run npm run build:preloads`)
    return generated
  }

  function getManagementRendererOrigin() {
    return managementRendererOrigin
  }

  function managementRendererAvailable() {
    return rendererDevelopmentUrl() !== undefined || exists(rendererEntryPath())
  }

  function getWindow(role) {
    if (role === 'management' || role === 'manager' || role === 'renderer') return managementWindow
    if (role === 'workspace' || role === 'harness' || role === 'main') return workspaceWindow
    if (role === 'splash' || role === 'loading') return splashWindow
    if (role !== undefined && role !== null && typeof role === 'object') return role
    return undefined
  }

  function closeWindow(window) {
    if (!isOpen(window) || typeof window.close !== 'function') return false
    window.close()
    return true
  }

  function show(roleOrWindow) {
    const window = getWindow(roleOrWindow ?? 'workspace')
    if (!isOpen(window) || typeof window.show !== 'function') return false
    // The splash surface is the interactive first-run page. Explicitly restore
    // mouse input and focus here so it cannot remain behind the workspace or a
    // stale loading surface after a restart.
    if (window === splashWindow && typeof window.setIgnoreMouseEvents === 'function') window.setIgnoreMouseEvents(false)
    window.show()
    if (window === splashWindow) {
      window.moveTop?.()
      window.focus?.()
      window.webContents?.focus?.()
      // Some Windows/Electron startup paths restore a stale input-ignore flag
      // after show(). Set it again after activation so the onboarding page is
      // genuinely mouse-interactive, not only keyboard-focusable.
      if (typeof window.setIgnoreMouseEvents === 'function') window.setIgnoreMouseEvents(false)
    }
    return true
  }

  function isVisible(roleOrWindow) {
    const window = getWindow(roleOrWindow)
    if (!isOpen(window)) return false
    try {
      return window.isVisible?.() === true
    } catch {
      return false
    }
  }

  function focus(roleOrWindow) {
    const window = getWindow(roleOrWindow ?? 'workspace')
    if (!isOpen(window)) return false
    if (window.isMinimized?.()) window.restore?.()
    show(window)
    window.focus?.()
    return true
  }

  function reload(roleOrWindow = 'workspace') {
    const window = getWindow(roleOrWindow)
    if (!isOpen(window) || typeof window.reload !== 'function') return false
    window.reload()
    return true
  }

  function navigateWorkspaceHistory(direction) {
    if (!['back', 'forward'].includes(direction)) throw new TypeError('Invalid workspace navigation direction')
    const window = getWindow('workspace')
    if (!isOpen(window)) return { moved: false, reason: 'workspace-unavailable' }
    const navigation = window.webContents?.navigationHistory
    if (navigation === undefined
      || typeof navigation.getAllEntries !== 'function'
      || typeof navigation.getActiveIndex !== 'function') {
      return { moved: false, reason: 'navigation-history-unavailable' }
    }

    const entries = navigation.getAllEntries()
    const activeIndex = navigation.getActiveIndex()
    const targetIndex = activeIndex + (direction === 'back' ? -1 : 1)
    const target = Array.isArray(entries) ? entries[targetIndex] : undefined
    const harnessOrigin = getHarnessOrigin()
    if (target === undefined || typeof harnessOrigin !== 'string') return { moved: false, reason: 'no-history-entry' }
    try {
      if (new URL(target.url).origin !== new URL(harnessOrigin).origin) {
        return { moved: false, reason: 'outside-harness' }
      }
    } catch {
      return { moved: false, reason: 'invalid-history-entry' }
    }

    if (direction === 'back' && typeof navigation.goBack === 'function') navigation.goBack()
    else if (direction === 'forward' && typeof navigation.goForward === 'function') navigation.goForward()
    else return { moved: false, reason: 'navigation-unavailable' }
    return { moved: true, direction }
  }

  function safeDownloadFilename(value) {
    const safe = String(value ?? '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '')
      .trim()
    return safe === '' ? undefined : safe.slice(0, 180)
  }

  function timestampedDownloadFilename(prefix, extension) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    return `${prefix}-${stamp}${extension}`
  }

  function uniqueDownloadPath(directory, filename) {
    const dot = filename.lastIndexOf('.')
    const stem = dot > 0 ? filename.slice(0, dot) : filename
    const extension = dot > 0 ? filename.slice(dot) : ''
    let target = join(directory, filename)
    for (let index = 2; exists(target) && index < 10_000; index += 1) {
      target = join(directory, `${stem} (${index})${extension}`)
    }
    return target
  }

  function installWorkspaceDownloadPolicy(window) {
    const session = window.webContents?.session
    if (typeof session?.on !== 'function') return
    const onDownload = (_event, item, sourceWebContents) => {
      if (sourceWebContents !== window.webContents || typeof item?.setSavePath !== 'function') return
      const harnessOrigin = getHarnessOrigin()
      const downloadsPath = resolveValue(getDownloadsPath, undefined)
      if (typeof harnessOrigin !== 'string' || typeof downloadsPath !== 'string' || downloadsPath.trim() === '') return
      const urls = typeof item.getURLChain === 'function'
        ? item.getURLChain()
        : [typeof item.getURL === 'function' ? item.getURL() : undefined]
      let trusted = false
      try {
        const expectedOrigin = new URL(harnessOrigin).origin
        trusted = urls.some(url => typeof url === 'string' && new URL(url).origin === expectedOrigin)
      } catch {
        return
      }
      if (!trusted) return

      const mimeType = typeof item.getMimeType === 'function' ? String(item.getMimeType()).toLowerCase() : ''
      let filename = safeDownloadFilename(typeof item.getFilename === 'function' ? item.getFilename() : undefined)
      if (filename === undefined) {
        filename = timestampedDownloadFilename('DeepSeek-Harness-Download', mimeType.includes('zip') ? '.zip' : '.bin')
      } else if (/\.tmp$/i.test(filename) && mimeType.includes('zip')) {
        filename = timestampedDownloadFilename('DeepSeek-Harness-Session', '.zip')
      }
      item.setSavePath(uniqueDownloadPath(downloadsPath, filename))
    }
    session.on('will-download', onDownload)
    window.once?.('closed', () => session.removeListener?.('will-download', onDownload))
  }

  function installWorkspaceNavigation(window) {
    const allowedWorkspacePermissions = new Set(['clipboard-sanitized-write', 'notifications'])
    const permissionAllowed = (permission, requestingOrigin, details = {}) => {
      if (new URL(requestingOrigin).origin !== new URL(getHarnessOrigin()).origin) return false
      if (allowedWorkspacePermissions.has(permission)) return true
      if (permission !== 'media') return false
      const mediaTypes = Array.isArray(details.mediaTypes)
        ? details.mediaTypes
        : typeof details.mediaType === 'string'
          ? [details.mediaType]
          : []
      return mediaTypes.length > 0 && mediaTypes.every(type => type === 'audio')
    }
    const policy = createMainNavigationPolicy({
      getHarnessOrigin,
      desktopPaths: [pagePath('loading.html'), pagePath('error.html')],
      loadHarness: url => window.loadURL(url),
      openExternal: url => shell.openExternal?.(url),
    })
    const trustedLoginUrl = value => {
      try {
        const url = new URL(value)
        if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false
        const host = url.hostname.toLowerCase()
        return host === 'auth.openai.com'
          || host === 'chatgpt.com'
          || host.endsWith('.openai.com')
          || host === 'accounts.google.com'
          || host === 'oauth2.googleapis.com'
      } catch {
        return false
      }
    }
    window.webContents.setWindowOpenHandler(details => {
      if (details?.url === 'about:blank') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            show: false,
            frame: false,
            skipTaskbar: true,
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              webSecurity: true,
              allowRunningInsecureContent: false,
            },
          },
        }
      }
      return policy.handleWindowOpen(details)
    })
    window.webContents.on('did-create-window', (child, details = {}) => {
      if (details.url !== 'about:blank' || !isOpen(child)) {
        child?.close?.()
        return
      }
      child.hide?.()
      child.setSkipTaskbar?.(true)
      child.webContents?.setWindowOpenHandler?.(() => ({ action: 'deny' }))
      const sendToSystemBrowser = (event, url) => {
        event?.preventDefault?.()
        if (trustedLoginUrl(url)) shell.openExternal?.(url)
        child.close?.()
      }
      child.webContents?.on?.('will-navigate', sendToSystemBrowser)
      child.webContents?.on?.('will-redirect', sendToSystemBrowser)
    })
    window.webContents.on('will-navigate', policy.handleWillNavigate)
    window.webContents.on('will-redirect', policy.handleWillRedirect)

    window.webContents.session.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
      try {
        return permissionAllowed(permission, requestingOrigin, details)
      } catch {
        return false
      }
    })
    window.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      try {
        const requestingOrigin = new URL(details?.requestingUrl ?? webContents.getURL()).origin
        callback(permissionAllowed(permission, requestingOrigin, details))
      } catch {
        callback(false)
      }
    })
  }

  function installManagementNavigation(window) {
    const policy = createManagementNavigationPolicy({
      rendererPath: rendererEntryPath(),
      developmentOrigin: managementRendererOrigin,
      openExternal: url => shell.openExternal?.(url),
    })
    window.webContents.setWindowOpenHandler(policy.handleWindowOpen)
    window.webContents.on('will-navigate', policy.handleWillNavigate)
    window.webContents.on('will-redirect', policy.handleWillRedirect)
  }

  function securityPreferences(role) {
    const preload = PRELOAD_FILES[role]
    return {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      ...(preload === undefined ? {} : { preload: generatedPreloadPath(role) }),
    }
  }

  function createManagementWindow() {
    const nextTheme = theme()
    const developmentUrl = rendererDevelopmentUrl()
    managementRendererOrigin = developmentUrl === undefined ? undefined : new URL(developmentUrl).origin
    const window = new BrowserWindow({
      width: 1180,
      height: 860,
      minWidth: 900,
      minHeight: 620,
      show: false,
      autoHideMenuBar: true,
      title: 'DeepSeek Harness Desktop',
      icon: desktopIcon(),
      backgroundColor: nextTheme.windowBackground,
      webPreferences: securityPreferences('management'),
    })
    installDshMotionPolicy(window)
    installNativeWindowFrame(window)
    if (process.platform === 'win32' && typeof window.setMenuBarVisibility === 'function') {
      window.setMenuBarVisibility(false)
    }
    installManagementNavigation(window)
    window.once('ready-to-show', () => window.show())
    window.on('closed', () => {
      if (managementWindow !== window) return
      managementWindow = undefined
      managementRendererOrigin = undefined
      callCallback(callbacks.onManagementClosed, window)
    })
    return window
  }

  function createWorkspaceWindow() {
    const nextTheme = theme()
    const window = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 840,
      minHeight: 600,
      show: false,
      // Keep the native Windows frame, resize handles and caption buttons, but
      // let the trusted preload own the compact left-side navigation/menu row.
      autoHideMenuBar: true,
      ...(process.platform === 'win32' ? {
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: WORKSPACE_ACRYLIC ? '#00000000' : nextTheme.titleBarColor,
          symbolColor: nextTheme.titleBarSymbolColor,
          height: WORKSPACE_TITLE_BAR_HEIGHT,
        },
      } : {}),
      title: 'DeepSeek Harness Desktop',
      icon: desktopIcon(),
      backgroundColor: WORKSPACE_ACRYLIC ? '#00000000' : nextTheme.windowBackground,
      // Keep resize handling but omit the external, untinted non-client gutter.
      // System Acrylic supplies its own opaque/fallback tint underneath CSS
      // alpha. A transparent compositor surface lets the user's opacity work
      // against actual windows behind us, independently of contrast.
      ...(WORKSPACE_ACRYLIC ? { transparent: true, backgroundMaterial: 'none', thickFrame: false } : {}),
      webPreferences: securityPreferences('workspace'),
    })
    if (WORKSPACE_ACRYLIC) acrylicWindows.add(window)
    installDshMotionPolicy(window)
    installNativeWindowFrame(window)
    installShellUiOverrides(window)
    installUpdateUi(window)
    if (process.platform === 'win32' && typeof window.setMenuBarVisibility === 'function') {
      window.setMenuBarVisibility(false)
    }
    installWorkspaceNavigation(window)
    installWorkspaceDownloadPolicy(window)
    window.on('close', event => {
      if (callCallback(callbacks.onWorkspaceCloseRequested, window) === true) event.preventDefault()
    })
    window.on('closed', () => {
      if (workspaceWindow !== window) return
      workspaceWindow = undefined
      callCallback(callbacks.onWorkspaceClosed, window)
    })
    return window
  }

  function createSplashWindow() {
    const nextTheme = theme()
    const window = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 840,
      minHeight: 600,
      show: false,
      center: true,
      resizable: true,
      minimizable: true,
      maximizable: true,
      movable: true,
      fullscreenable: false,
      focusable: true,
      autoHideMenuBar: true,
      ...(process.platform === 'win32' ? {
        // Keep native resize/move semantics and caption buttons while removing
        // the visible title strip from the startup and recommendation pages.
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: nextTheme.windowBackground,
          symbolColor: nextTheme.titleBarSymbolColor,
          height: SPLASH_TITLE_BAR_HEIGHT,
        },
      } : {}),
      title: 'DeepSeek Harness Desktop',
      icon: desktopIcon(),
      backgroundColor: nextTheme.windowBackground,
      webPreferences: securityPreferences('splash'),
    })
    installDshMotionPolicy(window)
    installNativeWindowFrame(window)
    if (process.platform === 'win32' && typeof window.setMenuBarVisibility === 'function') {
      window.setMenuBarVisibility(false)
    }
    if (typeof window.setIgnoreMouseEvents === 'function') window.setIgnoreMouseEvents(false)
    window.webContents?.on?.('did-finish-load', () => {
      if (splashWindow !== window) return
      if (typeof window.setIgnoreMouseEvents === 'function') window.setIgnoreMouseEvents(false)
    })
    window.on('closed', () => {
      if (splashWindow !== window) return
      splashWindow = undefined
      if (!isQuitting() && !isVisible(workspaceWindow)) callCallback(callbacks.onSplashClosed, window)
    })
    callCallback(callbacks.onSplashCreated, window)
    return window
  }

  function create(role = 'workspace', options = {}) {
    if (role === 'management' || role === 'manager' || role === 'renderer') {
      if (isOpen(managementWindow)) return managementWindow
      managementWindow = createManagementWindow(options)
      return managementWindow
    }
    if (role === 'workspace' || role === 'harness' || role === 'main') {
      if (isOpen(workspaceWindow)) return workspaceWindow
      workspaceWindow = createWorkspaceWindow(options)
      return workspaceWindow
    }
    if (role === 'splash' || role === 'loading') {
      if (isOpen(splashWindow)) return splashWindow
      splashWindow = createSplashWindow(options)
      return splashWindow
    }
    throw new TypeError(`Unknown window role: ${String(role)}`)
  }

  function loadPage(roleOrWindow, page, query = {}) {
    const window = getWindow(roleOrWindow)
    if (!isOpen(window)) return Promise.resolve(false)
    return Promise.resolve(window.loadFile(pagePath(page), { query: normalizeQuery(query) })).then(() => window)
  }

  function currentLoadingWindow() {
    if (isOpen(splashWindow)) return splashWindow
    if (isOpen(workspaceWindow)) return workspaceWindow
    return undefined
  }

  function loadManagementRoute(route, values = {}, options = {}) {
    const canContinue = typeof options === 'function'
      ? options
      : typeof options?.canContinue === 'function'
        ? options.canContinue
        : () => true
    if (!canContinue()) return Promise.resolve(false)
    if (!isOpen(managementWindow)) {
      try { create('management') } catch { return Promise.resolve(false) }
    }
    if (!isOpen(managementWindow) || !managementRendererAvailable()) return Promise.resolve(false)
    const safeRoute = validateManagementRoute(route)
    const query = normalizeQuery(values)
    const developmentUrl = rendererDevelopmentUrl()
    const window = managementWindow
    const loading = developmentUrl === undefined
      ? window.loadFile(rendererEntryPath(), { query: { route: safeRoute, ...query } })
      : window.loadURL(`${developmentUrl}#/${safeRoute}?${new URLSearchParams({ route: safeRoute, ...query }).toString()}`)
    return Promise.resolve(loading).then(() => {
      if (!canContinue() || !isOpen(window)) return false
      callCallback(callbacks.onManagementRouteLoaded, safeRoute, window)
      window.show?.()
      window.focus?.()
      return true
    })
  }

  function executeLoadingScript(script, roleOrWindow) {
    const window = getWindow(roleOrWindow ?? currentLoadingWindow())
    if (!isOpen(window)) return Promise.resolve(false)
    if (typeof window.webContents?.executeJavaScript !== 'function') return Promise.resolve(false)
    return Promise.resolve(window.webContents.executeJavaScript(script, true)).then(() => true)
  }

  function loadWorkspace(url) {
    const window = getWindow('workspace')
    if (!isOpen(window)) return Promise.resolve(false)
    return Promise.resolve(window.loadURL(url)).then(() => true)
  }

  function reveal(options = {}) {
    const canReveal = typeof options === 'function'
      ? options
      : typeof options?.canReveal === 'function'
        ? options.canReveal
        : () => true
    if (!canReveal()) return false
    if (callCallback(callbacks.onRevealRequested) === true) return true
    const workspace = workspaceWindow
    const management = managementWindow
    if (isOpen(workspace) && (getHarnessOrigin() !== undefined || !isOpen(management))) workspace.show()
    if (isOpen(management)) management.show()
    const splash = splashWindow
    splashWindow = undefined
    closeWindow(splash)
    callCallback(callbacks.onRevealed)
    return true
  }

  function close(role) {
    if (role !== undefined) return closeWindow(getWindow(role))
    let closed = false
    for (const window of [splashWindow, managementWindow, workspaceWindow]) {
      closed = closeWindow(window) || closed
    }
    return closed
  }

  function hasOpenWindows() {
    if (typeof BrowserWindow.getAllWindows === 'function') {
      try { return BrowserWindow.getAllWindows().length > 0 } catch { /* use tracked refs */ }
    }
    return [managementWindow, workspaceWindow, splashWindow].some(isOpen)
  }

  function focusActive() {
    return focus('workspace') || focus('management') || focus('splash')
  }

  function updateTheme() {
    for (const window of [managementWindow, workspaceWindow, splashWindow]) applyWindowTheme(window)
    return true
  }

  const host = {
    create,
    createManagementWindow: () => create('management'),
    createWorkspaceWindow: () => create('workspace'),
    createWindow: () => create('workspace'),
    createSplashWindow: () => create('splash'),
    show,
    isVisible,
    focus,
    focusActive,
    reload,
    navigateWorkspaceHistory,
    close,
    closeWindow: roleOrWindow => closeWindow(getWindow(roleOrWindow)),
    loadManagementRoute,
    loadPage,
    loadFallbackPage: loadPage,
    updateTheme,
    loadWorkspace,
    executeLoadingScript,
    managementRendererAvailable,
    currentLoadingWindow,
    reveal,
    hasOpenWindows,
    isOpen: role => isOpen(getWindow(role)),
    getWindow,
    get managementWindow() { return managementWindow },
    get workspaceWindow() { return workspaceWindow },
    get mainWindow() { return workspaceWindow },
    get splashWindow() { return splashWindow },
    get managementRendererOrigin() { return managementRendererOrigin },
    get rendererOrigin() { return managementRendererOrigin },
    rendererDevelopmentUrl,
    rendererEntryPath,
    pagePath,
    generatedPreloadPath,
  }

  return Object.freeze(host)
}

export const WINDOW_PRELOAD_FILES = PRELOAD_FILES
