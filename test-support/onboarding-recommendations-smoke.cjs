'use strict'
const { app, BrowserWindow, ipcMain } = require('electron')
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
const root = resolve(__dirname, '..')
const output = join(root, 'output/onboarding-recommendations-qa')
mkdirSync(output, { recursive: true })
app.setPath('userData', mkdtempSync(join(output, 'isolated-')))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const { readOnboardingRecommendations, mergeOnboardingRecommendations, onboardingInstallSources } = await import('../src/onboarding.js')
  let suite = false
  let autoConfigure = false
  const calls = []
  ipcMain.handle('fixture:recommendations', () => ({ ok: true, flavor: suite ? 'suite' : 'base', preselectAll: suite, autoConfigure, level: 'full',
    recommendations: mergeOnboardingRecommendations(readOnboardingRecommendations({ suite }), [{ name: 'dshmarket', version: 'fixture', enabled: true }]), installedCount: 1,
  }))
  ipcMain.handle('fixture:install', (_event, request) => {
    const sources = onboardingInstallSources(request.selectedIds, { suite, repositoryRoot: root })
    calls.push({ suite, selectedIds: request.selectedIds, packageNames: sources.map(entry => entry.packageName) })
    // This is a source-validation fixture only. No installer is called.
    return { ok: true }
  })
  const window = new BrowserWindow({ show: false, width: 1200, height: 820, useContentSize: true, webPreferences: {
    preload: join(__dirname, 'onboarding-recommendations-preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false,
  } })
  const report = { ok: false, fixture: true, actualPluginInstallation: false, views: [], calls, errors: [] }
  window.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message) })
  try {
    for (const flavor of ['base', 'suite']) for (const theme of ['light', 'dark']) {
      suite = flavor === 'suite'
      await window.loadFile(join(root, 'src/pages/plugins-onboarding.html'), { query: { theme, fixture: flavor } })
      await new Promise(resolve => setTimeout(resolve, 200))
      await window.webContents.capturePage()
      const state = await window.webContents.executeJavaScript(`({count:document.querySelectorAll('input[type="checkbox"]').length,disabled:document.querySelectorAll('input[type="checkbox"]:disabled').length,checked:[...document.querySelectorAll('input[type="checkbox"]')].filter(el=>el.checked).length,title:document.getElementById('title').textContent,overflow:document.documentElement.scrollWidth>innerWidth})`)
      assert.equal(state.count, suite ? 6 : 3)
      assert.equal(state.disabled, suite ? 0 : 1)
      assert.equal(state.checked, suite ? 6 : 0)
      assert.equal(state.overflow, false)
      assert.ok(await window.webContents.executeJavaScript(`document.querySelector('.intro').getBoundingClientRect().top >= 0`), 'full list heading must remain reachable')
      if (suite) assert.equal(state.title, '安装推荐插件')
      report.views.push({ flavor, theme, ...state })
      writeFileSync(join(output, `${flavor}-${theme}.png`), (await window.webContents.capturePage()).toPNG())
      if (suite) {
        const selectedBefore = await window.webContents.executeJavaScript(`document.querySelector('input[type="checkbox"]').value`)
        await window.webContents.executeJavaScript(`document.getElementById('next-page').click(); document.getElementById('previous-page').click()`)
        assert.equal(await window.webContents.executeJavaScript(`document.querySelector('input[type="checkbox"]').value`), selectedBefore)
        assert.equal(await window.webContents.executeJavaScript(`document.querySelector('input[type="checkbox"]').checked`), true)
        assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('input[type="checkbox"]').length`), 6)
        await window.webContents.executeJavaScript(`document.querySelector('input[type="checkbox"]').click(); document.getElementById('next-page').click(); document.getElementById('previous-page').click()`)
        assert.equal(await window.webContents.executeJavaScript(`document.querySelector('input[type="checkbox"]').checked`), false, 'unchecked state persists across pages')
        await window.webContents.executeJavaScript(`document.querySelector('input[type="checkbox"]').click(); for(let i=0;i<4;i++)document.getElementById('next-page').click()`)
        assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('input[type="checkbox"]').length`), 3, 'last page has only the remaining entries')
        assert.equal(await window.webContents.executeJavaScript(`document.getElementById('next-page').disabled`), true)
        await window.webContents.executeJavaScript(`for(let i=0;i<4;i++)document.getElementById('previous-page').click()`)
      }
      await window.webContents.executeJavaScript(`(() => { const controls=[...document.querySelectorAll('input[type="checkbox"]:not(:disabled)')]; if(!controls.some(el=>el.checked)) controls[0].click(); document.getElementById('install').click(); })()`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(calls.length, 4)
    assert.ok(calls.every(call => !call.packageNames.includes('dshmarket')))
    suite = true
    autoConfigure = true
    await window.loadFile(join(root, 'src/pages/plugins-onboarding.html'), { query: { theme: 'dark', fixture: 'auto' } })
    await new Promise(resolve => setTimeout(resolve, 600))
    assert.equal(calls.length, 5, 'fresh share setup must submit exactly once')
    assert.equal(calls.at(-1).packageNames.length, 26, 'already-installed package is not reinstalled')
    assert.match(await window.webContents.executeJavaScript(`document.getElementById('title').textContent`), /首次联网自动配置/)
    writeFileSync(join(output, 'suite-auto-dark.png'), (await window.webContents.capturePage()).toPNG())
    assert.deepEqual(report.errors, [])
    report.ok = true
  } catch (error) { report.error = error.stack }
  finally { writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ok:report.ok,error:report.error,views:report.views.length,sourceChecks:calls.length})); window.destroy(); app.exit(report.ok ? 0 : 1) }
}).catch(error => { console.error(error); app.exit(1) })
