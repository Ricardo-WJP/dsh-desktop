import { fileURLToPath } from 'node:url'

/** URL policy shared by every BrowserWindow navigation handler. */

/**
 * Return true only for a URL served by this exact Harness instance.
 * @param {string} target
 * @param {string | undefined} harnessOrigin
 */
export function isHarnessUrl(target, harnessOrigin) {
  if (harnessOrigin === undefined) return false
  try {
    const url = new URL(target)
    return url.protocol === 'http:' && url.origin === harnessOrigin
  } catch {
    return false
  }
}

/** Return true for a URL that is safe to hand to the operating system. */
export function isExternalHttpUrl(target) {
  try {
    const protocol = new URL(target).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Return true only for one of the app-owned fallback pages.
 *
 * Keeping this check here prevents each BrowserWindow navigation handler from
 * inventing a slightly different file URL policy.
 */
export function isDesktopPage(target, allowedPaths = []) {
  try {
    const parsed = new URL(target)
    if (parsed.protocol !== 'file:') return false
    return allowedPaths.includes(fileURLToPath(parsed))
  } catch {
    return false
  }
}

/**
 * Return true only for the app-owned management renderer in production or the
 * explicitly allowed local Vite origin during development.
 */
export function isManagementPage(target, { rendererPath, developmentOrigin } = {}) {
  try {
    const parsed = new URL(target)
    if (parsed.protocol === 'file:') return rendererPath !== undefined && fileURLToPath(parsed) === rendererPath
    return developmentOrigin !== undefined && parsed.origin === developmentOrigin
  } catch {
    return false
  }
}

function openExternalSafely(openExternal, url) {
  if (typeof openExternal !== 'function' || !isExternalHttpUrl(url)) return
  try {
    Promise.resolve(openExternal(url)).catch(() => {})
  } catch {
    // Navigation policy must never turn a rejected OS handoff into an
    // unhandled rejection or a renderer navigation.
  }
}

/** Build side-effect-free handlers for the management BrowserWindow. */
export function createManagementNavigationPolicy({ rendererPath, developmentOrigin, openExternal = () => {} } = {}) {
  const handleWillNavigate = (event, url) => {
    if (isManagementPage(url, { rendererPath, developmentOrigin })) return
    event.preventDefault()
    openExternalSafely(openExternal, url)
  }
  return Object.freeze({
    handleWindowOpen: () => ({ action: 'deny' }),
    handleWillNavigate,
    handleWillRedirect: handleWillNavigate,
  })
}

/**
 * Build side-effect-free handlers for the workspace BrowserWindow.
 * The main process supplies the live Harness origin and OS actions, which
 * makes the navigation decision executable without starting Electron.
 */
export function createMainNavigationPolicy({
  getHarnessOrigin = () => undefined,
  desktopPaths = [],
  loadHarness = () => {},
  openExternal = () => {},
} = {}) {
  const loadHarnessSafely = url => {
    try {
      Promise.resolve(loadHarness(url)).catch(() => {})
    } catch {
      // A navigation callback cannot surface a rejected BrowserWindow load to
      // Chromium; the owner logs/handles the operation separately.
    }
  }
  const handleWindowOpen = ({ url }) => {
    if (isHarnessUrl(url, getHarnessOrigin())) loadHarnessSafely(url)
    else openExternalSafely(openExternal, url)
    return { action: 'deny' }
  }

  const handleWillNavigate = (event, url) => {
    if (isDesktopPage(url, desktopPaths) || isHarnessUrl(url, getHarnessOrigin())) return
    event.preventDefault()
    openExternalSafely(openExternal, url)
  }

  return Object.freeze({
    handleWindowOpen,
    handleWillNavigate,
    handleWillRedirect: handleWillNavigate,
  })
}
