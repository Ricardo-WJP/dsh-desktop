'use strict'
// Renders the real compiled React UI with a synthetic, isolated host. This
// exercises layout and interaction only; it never operates the installed DSH.
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
const root = resolve(__dirname, '..')
const output = resolve(process.argv[2] || join(root, 'output/control-center-qa'))
const isolated = mkdtempSync(join(tmpdir(), 'dsh-control-center-qa-'))
app.setPath('userData', isolated)
app.setPath('sessionData', isolated)
const status = {
  app: { version: '0.1.55', ready: true },
  mode: { active: 'stable', compatibility: 'native', switchAvailable: true, stable: { state: 'ready' }, dev: { state: 'stopped', watcher: 'idle' } },
  startup: { phase: 'ready', progress: 100, message: '工作区已就绪' },
  runtime: { version: '0.1.2-rc.1', source: 'managed' },
  data: { state: 'independent', home: 'C:\\Fixture\\user-data' },
  workspace: { ready: true, origin: 'http://127.0.0.1:3080' },
  update: { state: 'idle', currentVersion: '0.1.2-rc.1', latestVersion: null, updateAvailable: false, available: true, busy: false, checkAvailable: true, restoreAvailable: false, managedRestoreAvailable: false },
  desktopUpdate: { state: 'unavailable', currentVersion: '0.1.55', available: false, releaseSourceConfigured: false, supported: true, externalReleaseAvailable: false, busy: false, checkAvailable: false, progress: 0, downloaded: false, targetVersion: null },
  candidate: { state: 'idle', available: true, busy: false, prepareAvailable: true, switchAvailable: false, previousReleaseId: 'fixture-previous', codeRollbackAvailable: true, reason: null },
  plugins: { state: 'ready', available: true, busy: false, installed: 12, recoveryAvailable: true, recoveryMode: false, recoveryRows: 0, recoveryReason: null },
  snapshots: { state: 'available', available: true, busy: false, count: 0, totalBytes: 0, reason: null },
  logs: { state: 'available', path: 'C:\\Users\\Fixture\\AppData\\Roaming\\dsh-desktop\\logs\\desktop-with-a-very-long-unbroken-diagnostic-filename-for-layout-regression.log' },
}
const calls = []
const errors = []
let snapshotFixture = []
ipcMain.handle('control-center-fixture', async (_event, name, args) => {
  calls.push({ name, args })
  if (name === 'status.get') return { ok: true, status }
  if (name === 'logs.read') return { ok: true, lines: [], path: status.logs.path, truncated: false }
  if (name === 'snapshots.list') return { ok: true, snapshots: snapshotFixture }
  if (name === 'candidate.status') return { ok: true, candidate: status.candidate }
  if (name === 'mode.get') return { ok: true, mode: status.mode }
  await new Promise(resolve => setTimeout(resolve, 300))
  if (name === 'app.restart') return { ok: false, error: '模拟验证：服务暂时无法重启，请查看日志。' }
  if (name === 'update.probe') return { ok: true, available: false, error: '模拟验证：网络暂时不可用。' }
  return { ok: true, accepted: true }
})
app.whenReady().then(async () => {
  mkdirSync(output, { recursive: true })
  const window = new BrowserWindow({ show: false, width: 1400, height: 900, useContentSize: true,
    webPreferences: { preload: join(__dirname, 'control-center-preview-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  })
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  window.webContents.on('render-process-gone', (_event, detail) => errors.push(JSON.stringify(detail)))
  const report = { syntheticHost: true, realCompiledRenderer: true, screenshots: [], measurements: [], calls, errors }
  try {
    for (const theme of ['dark', 'light']) {
      nativeTheme.themeSource = theme
      for (const [width, height] of [[1400, 900], [760, 780], [520, 760]]) {
        window.setContentSize(width, height)
        for (const route of ['overview', 'update', 'recovery', 'diagnostics', 'mode']) {
          const probeCount = calls.filter(call => call.name === 'update.probe').length
          await window.loadFile(join(root, 'build/renderer/index.html'), { hash: `/${route}`, query: { fixtureCase: `${theme}-${width}-${route}` } })
          await new Promise(resolve => setTimeout(resolve, route === 'update' ? 1100 : 500))
          if (route === 'update') assert.equal(calls.filter(call => call.name === 'update.probe').length - probeCount, 1, 'failed automatic update check must not retry in a render loop')
          if (route === 'update') {
            let visibleError = false
            for (let attempt = 0; attempt < 30 && !visibleError; attempt++) {
              visibleError = await window.webContents.executeJavaScript("document.body.innerText.includes('DSH 更新检测失败')")
              if (!visibleError) await new Promise(resolve => setTimeout(resolve, 100))
            }
            assert.equal(visibleError, true, 'network failure must remain visible after the update probe')
          }
          await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
          const measurements = await window.webContents.executeJavaScript(`({
            width:innerWidth, scroll:document.documentElement.scrollWidth,
            buttons:[...document.querySelectorAll('button')].map(el=>({text:el.innerText,disabled:el.disabled,width:el.getBoundingClientRect().width})),
            text:document.body.innerText,
          })`)
          report.measurements.push({ theme, width, route, ...measurements })
          assert.ok(measurements.scroll <= measurements.width + 1, `${theme}/${route}/${width} horizontal overflow`)
          if (route === 'diagnostics') {
            const contained = await window.webContents.executeJavaScript(`(() => {
              const path = document.querySelector('.diagnostics-file-path');
              const card = document.querySelector('.diagnostics-file-card');
              if (!path || !card) return false;
              const p = path.getBoundingClientRect(), c = card.getBoundingClientRect();
              return path.scrollWidth <= path.clientWidth + 1 && p.right <= c.right && p.bottom <= c.bottom;
            })()`);
            assert.ok(contained, 'long log path must stay inside its card');
          }
          const file = `${theme}-${width}-${route}.png`
          writeFileSync(join(output, file), (await window.webContents.capturePage()).toPNG())
          report.screenshots.push(file)
        }
      }
    }
    nativeTheme.themeSource = 'dark'
    window.setContentSize(1400, 900)
    await window.loadFile(join(root, 'build/renderer/index.html'), { hash: '/overview', query: { fixtureCase: 'interaction' } })
    await new Promise(resolve => setTimeout(resolve, 500))
    const before = calls.filter(call => call.name === 'app.restart').length
    const clicked = await window.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button')].find(el=>el.innerText.trim()==='重启服务');
      if (!button || button.disabled) return false;
      button.click(); button.click(); return true;
    })()`)
    assert.equal(clicked, true, 'restart action must be available in the ready fixture')
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(calls.filter(call => call.name === 'app.restart').length - before, 1, 'double click must submit only once')
    const feedback = await window.webContents.executeJavaScript(`document.body.innerText`)
    assert.match(feedback, /模拟验证：服务暂时无法重启/)
    writeFileSync(join(output, 'interaction-restart-error.png'), (await window.webContents.capturePage()).toPNG())
    report.interaction = { duplicateSubmissionBlocked: true, restartFailureVisible: true }
    snapshotFixture = [{ id: 'fixture-snapshot-1', snapshotId: 'fixture-snapshot-1', createdAt: '2026-09-06T00:00:00.000Z', kind: 'manual', count: 3, bytes: 1024 }]
    await window.loadFile(join(root, 'build/renderer/index.html'), { hash: '/recovery', query: { fixtureCase: 'snapshot-confirmation' } })
    await new Promise(resolve => setTimeout(resolve, 500))
    const restoreBefore = calls.filter(call => call.name === 'snapshots.restore').length
    const cancel = await window.webContents.executeJavaScript(`(() => {
      window.__qaConfirmations = [];
      window.confirm = message => { window.__qaConfirmations.push(message); return false; };
      const button = [...document.querySelectorAll('button')].find(el=>!el.disabled && el.innerText.trim()==='恢复此快照');
      if (!button) return false; button.click(); return true;
    })()`)
    assert.equal(cancel, true, 'verified snapshot must expose a restore action')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(calls.filter(call => call.name === 'snapshots.restore').length, restoreBefore, 'cancel must not restore')
    const warnings = await window.webContents.executeJavaScript("window.__qaConfirmations.join(' ')")
    assert.match(warnings, /覆盖/)
    assert.match(warnings, /备份/)
    await window.webContents.executeJavaScript(`(() => {
      window.confirm = () => true;
      [...document.querySelectorAll('button')].find(el=>!el.disabled && el.innerText.trim()==='恢复此快照').click();
    })()`)
    await new Promise(resolve => setTimeout(resolve, 500))
    const restores = calls.filter(call => call.name === 'snapshots.restore')
    assert.equal(restores.length - restoreBefore, 1)
    assert.equal(restores.at(-1).args[0], 'fixture-snapshot-1')
    report.interaction.snapshotCancelPreservesData = true
    report.interaction.snapshotConfirmationRequired = true
    report.interaction.snapshotRestoreBoundToSelectedId = true
    report.ok = errors.length === 0
  } catch (error) {
    report.ok = false
    report.error = error.stack
  } finally {
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ ok: report.ok, error: report.error, screenshots: report.screenshots.length, output }))
    window.destroy()
    app.exit(report.ok ? 0 : 1)
  }
}).catch(error => { console.error(error); app.exit(1) })
