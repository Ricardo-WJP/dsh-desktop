function createNativeImage(nativeImage, iconPath) {
  if (nativeImage?.createFromPath && typeof iconPath === 'string') return nativeImage.createFromPath(iconPath)
  return iconPath
}

function buildMenu(Menu, labels, handlers) {
  if (typeof Menu?.buildFromTemplate !== 'function') return undefined
  return Menu.buildFromTemplate([
    { label: labels.status, enabled: false },
    { type: 'separator' },
    { label: labels.open, click: handlers.open },
    { label: labels.openWorkspace, enabled: labels.workspaceEnabled === true, click: handlers.openWorkspace },
    { label: labels.openLogs, click: handlers.openLogs },
    { type: 'separator' },
    { label: labels.desktopUpdate, click: handlers.desktopUpdate },
    { label: labels.dshUpdate, click: handlers.dshUpdate },
    { type: 'separator' },
    { label: labels.restart, click: handlers.restart },
    { type: 'separator' },
    { label: labels.quit, click: handlers.quit },
  ])
}

/**
 * Keeps the desktop owner alive while its windows are hidden. This module is
 * deliberately dependency-injected so tray lifecycle can be tested without a
 * real Windows shell.
 */
export function createBackgroundTray({
  Tray,
  Menu,
  nativeImage,
  iconPath,
  labels = {},
  onOpen = () => {},
  onOpenWorkspace = () => {},
  onOpenLogs = () => {},
  onDesktopUpdate = () => {},
  onDshUpdate = () => {},
  onRestart = () => {},
  onQuit = () => {},
} = {}) {
  if (typeof Tray !== 'function') throw new TypeError('Invalid Tray constructor')
  if (typeof iconPath !== 'string' || iconPath.trim() === '') throw new TypeError('Invalid tray icon path')

  const tray = new Tray(createNativeImage(nativeImage, iconPath))
  const handlers = {
    open: onOpen,
    openWorkspace: onOpenWorkspace,
    openLogs: onOpenLogs,
    desktopUpdate: onDesktopUpdate,
    dshUpdate: onDshUpdate,
    restart: onRestart,
    quit: onQuit,
  }
  const setLabels = nextLabels => {
    labels = { ...labels, ...nextLabels }
    const menu = buildMenu(Menu, labels, handlers)
    if (menu !== undefined && typeof tray.setContextMenu === 'function') tray.setContextMenu(menu)
    if (typeof tray.setToolTip === 'function' && labels.tooltip) tray.setToolTip(labels.tooltip)
    return menu
  }

  setLabels(labels)
  tray.on?.('double-click', onOpen)

  return {
    tray,
    setLabels,
    setIcon(nextIconPath) {
      if (typeof nextIconPath !== 'string' || nextIconPath.trim() === '') return false
      tray.setImage?.(createNativeImage(nativeImage, nextIconPath))
      return true
    },
    destroy() {
      tray.destroy?.()
    },
  }
}
