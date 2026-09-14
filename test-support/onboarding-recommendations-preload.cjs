'use strict'
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('dshOnboarding', {
  recommendations: () => ipcRenderer.invoke('fixture:recommendations'),
  install: request => ipcRenderer.invoke('fixture:install', request),
  skip: async () => ({ ok: true }),
  progress: { subscribe: () => () => {} },
})
