import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createBackgroundTray } from '../src/background-tray.js'

class FakeTray extends EventEmitter {
  constructor(icon) {
    super()
    this.icon = icon
    this.menu = undefined
    this.tooltip = undefined
    this.destroyed = false
  }

  setContextMenu(menu) { this.menu = menu }
  setToolTip(value) { this.tooltip = value }
  setImage(value) { this.icon = value }
  destroy() { this.destroyed = true }
}

test('background tray exposes native management actions and updates its icon', () => {
  const calls = []
  const menus = []
  const Menu = { buildFromTemplate: template => { const menu = { template }; menus.push(menu); return menu } }
  const trayOwner = createBackgroundTray({
    Tray: FakeTray,
    Menu,
    nativeImage: { createFromPath: path => ({ path }) },
    iconPath: 'white.ico',
    labels: {
      status: '正在运行',
      open: '打开',
      openWorkspace: '打开工作区',
      openLogs: '打开日志',
      desktopUpdate: '检查桌面端更新',
      dshUpdate: '检查 DSH 更新',
      restart: '重启',
      quit: '退出',
      tooltip: '后台运行',
      workspaceEnabled: false,
    },
    onOpen: () => calls.push('open'),
    onOpenWorkspace: () => calls.push('workspace'),
    onOpenLogs: () => calls.push('logs'),
    onDesktopUpdate: () => calls.push('desktop-update'),
    onDshUpdate: () => calls.push('dsh-update'),
    onRestart: () => calls.push('restart'),
    onQuit: () => calls.push('quit'),
  })

  assert.deepEqual(trayOwner.tray.icon, { path: 'white.ico' })
  assert.equal(trayOwner.tray.tooltip, '后台运行')
  assert.deepEqual(trayOwner.tray.menu.template.map(item => item.label).filter(Boolean), [
    '正在运行', '打开', '打开工作区', '打开日志', '检查桌面端更新', '检查 DSH 更新', '重启', '退出',
  ])
  assert.equal(trayOwner.tray.menu.template[3].enabled, false)
  trayOwner.setLabels({ workspaceEnabled: true })
  assert.equal(trayOwner.tray.menu.template[3].enabled, true)
  trayOwner.tray.menu.template[2].click()
  trayOwner.tray.menu.template[3].click()
  trayOwner.tray.menu.template[4].click()
  trayOwner.tray.menu.template[6].click()
  trayOwner.tray.menu.template[7].click()
  trayOwner.tray.menu.template[9].click()
  trayOwner.tray.menu.template[11].click()
  trayOwner.tray.emit('double-click')
  assert.deepEqual(calls, ['open', 'workspace', 'logs', 'desktop-update', 'dsh-update', 'restart', 'quit', 'open'])

  assert.equal(trayOwner.setIcon('black.ico'), true)
  assert.deepEqual(trayOwner.tray.icon, { path: 'black.ico' })
  assert.equal(menus.length, 2)
  trayOwner.destroy()
  assert.equal(trayOwner.tray.destroyed, true)
})
