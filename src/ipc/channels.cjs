'use strict'

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

// Channel names are shared by the ESM main process and both sandboxed CJS
// preloads. Validation and ownership rules remain in contracts.js.
module.exports = deepFreeze({
  status: { get: 'dsh-desktop:status', changed: 'dsh-desktop:state-changed' },
  updates: { get: 'dsh-desktop:updates-get', check: 'dsh-desktop:updates-check', execute: 'dsh-desktop:updates-execute', open: 'dsh-desktop:updates-open', changed: 'dsh-desktop:updates-changed' },
  mode: { get: 'dsh-desktop:mode-get', set: 'dsh-desktop:mode-set' },
  candidate: { status: 'dsh-desktop:candidate-status', prepare: 'dsh-desktop:candidate-prepare', activate: 'dsh-desktop:candidate-activate' },
  update: { check: 'dsh-desktop:update-check', probe: 'dsh-desktop:update-probe', restore: 'dsh-desktop:update-restore', desktopCheck: 'dsh-desktop:desktop-update-check' },
  plugins: {
    openManager: 'dsh-desktop:plugins-open-manager',
    list: 'dsh-desktop:plugins-list',
    catalog: 'dsh-desktop:plugins-catalog',
    discover: 'dsh-desktop:plugins-discover',
    transaction: 'dsh-desktop:plugins-transaction',
    marketInstall: 'dsh-desktop:plugins-market-install',
    marketUpdate: 'dsh-desktop:plugins-market-update',
    activateMarketUpdate: 'dsh-desktop:plugins-market-update-activate',
    removePreview: 'dsh-desktop:plugins-remove-preview',
    confirmRemove: 'dsh-desktop:plugins-confirm-remove',
    install: 'dsh-desktop:plugins-install',
    update: 'dsh-desktop:plugins-update',
    enabled: 'dsh-desktop:plugins-enabled',
    remove: 'dsh-desktop:plugins-remove',
    restart: 'dsh-desktop:plugins-restart',
    safeStart: 'dsh-desktop:plugins-safe-start',
    safeExit: 'dsh-desktop:plugins-safe-exit',
    docs: 'dsh-desktop:plugins-docs',
    source: 'dsh-desktop:plugins-source',
  },
  snapshots: { list: 'dsh-desktop:snapshots-list', create: 'dsh-desktop:snapshot-create', restore: 'dsh-desktop:snapshot-restore' },
  logs: { read: 'dsh-desktop:logs-read', open: 'dsh-desktop:logs-open' },
  workspace: {
    open: 'dsh-desktop:workspace-open',
    openSettings: 'dsh-desktop:workspace-open-settings',
    openUpdate: 'dsh-desktop:workspace-open-update',
    updateCheck: 'dsh-desktop:workspace-update-check',
    theme: 'dsh-desktop:workspace-theme',
    titlebarMenu: 'dsh-desktop:workspace-titlebar-menu',
    titlebarNavigate: 'dsh-desktop:workspace-titlebar-navigate',
  },
  app: { restart: 'dsh-desktop:restart', navigate: 'dsh-desktop:navigate' },
  openPath: 'dsh-desktop:open-path',
  workspaceContext: 'dsh-desktop:workspace-context',
})
