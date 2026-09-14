// Temporary visual target behind the installed app; no profile or network use.
const { app, BrowserWindow, screen } = require('electron')
const { mkdtempSync } = require('node:fs')
const { join } = require('node:path')
app.setPath('userData', mkdtempSync(join(require('node:os').tmpdir(), 'dsh-backdrop-proof-')))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const bounds = screen.getPrimaryDisplay().workArea
  const window = new BrowserWindow({ ...bounds, frame: false, title: 'DSH Backdrop Proof', show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  window.loadURL('data:text/html,' + encodeURIComponent('<title>DSH Backdrop Proof</title><style>html,body{margin:0;height:100%;background:linear-gradient(0deg,#00ff40 0 50%,#ff0080 50% 100%)}h1{padding:80px;color:black;font:60px sans-serif}</style><h1>DSH BACKDROP TEST</h1>'))
  window.show()
  setTimeout(() => app.quit(), 300000)
})
app.on('window-all-closed', () => app.quit())
