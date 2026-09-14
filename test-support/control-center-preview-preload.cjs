'use strict'
const { contextBridge, ipcRenderer } = require('electron')
const invoke = (name, ...args) => ipcRenderer.invoke('control-center-fixture', name, args)
const group = names => Object.fromEntries(names.map(name => [name.split('.').at(-1), (...args) => invoke(name, ...args)]))
contextBridge.exposeInMainWorld('dshDesktop', {
  status: { get: () => invoke('status.get'), subscribe: () => () => {} },
  app: group(['app.restart', 'app.navigate']),
  workspace: group(['workspace.open']),
  logs: group(['logs.read', 'logs.open']),
  mode: group(['mode.get', 'mode.set']),
  update: group(['update.probe', 'update.check', 'update.restore', 'update.desktopCheck']),
  candidate: group(['candidate.status', 'candidate.prepare', 'candidate.activate']),
  snapshots: group(['snapshots.list', 'snapshots.create', 'snapshots.restore']),
  recovery: group(['recovery.startPluginSafeMode', 'recovery.exitPluginSafeMode']),
})
