import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { loadingStateScript, normalizeProgress } from '../src/startup-progress.js'

test('normalizes startup progress to an integer percentage', () => {
  assert.equal(normalizeProgress(-4), 0)
  assert.equal(normalizeProgress(47.6), 48)
  assert.equal(normalizeProgress(140), 100)
  assert.equal(normalizeProgress('not-a-number'), 0)
})

test('serializes startup state and its real phase as data when evaluated', () => {
  const script = loadingStateScript('</script><script>alert(1)</script>', 42, 'loading-services')
  let received
  runInNewContext(script, {
    window: {
      setStartupState(state) { received = state },
    },
  })
  assert.equal(received.message, '</script><script>alert(1)</script>')
  assert.equal(received.progress, 42)
  assert.equal(received.stage, 'loading-services')
})

test('startup page has a hidden-titlebar drag strip and one centered real-stage line', () => {
  const page = readFileSync(new URL('../src/pages/loading.html', import.meta.url), 'utf8')
  assert.doesNotMatch(page, /window-bar|data-window-action/)
  assert.match(page, /\.drag-strip[^}]*-webkit-app-region: drag/)
  assert.match(page, /\.startup-logo[^}]*top: 43%/)
  assert.match(page, /loading-services[\s\S]*本地服务/)
  assert.match(page, /harness-ready[\s\S]*验证服务状态/)
  assert.match(page, /loading-workspace[\s\S]*载入工作区/)
  assert.match(page, /progress-sheen/)
  assert.match(page, /animation: progress-sheen 2\.35s linear infinite/)
  assert.match(page, /\.progress-label[^}]*text-align: center/)
  assert.doesNotMatch(page, /progress-heading|progress-step|step-label|1 \/ 6/)
  assert.match(page, /prefers-reduced-motion: reduce/)
  assert.doesNotMatch(page, /pointermove|screenX|screenY|setPosition/)
})

test('desktop integration is verified before the compatibility-aware initial start', () => {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  const readyHandler = source.slice(source.indexOf('app.whenReady().then'))
  const recover = readyHandler.indexOf('await runtimeController.recoverPendingRelease()')
  const install = readyHandler.indexOf('installDesktopPluginForNewWebProfile({')
  const start = readyHandler.indexOf('startInitialHarnessWithCompatibilityRepair()')

  assert.ok(recover >= 0)
  assert.ok(install > recover)
  assert.ok(start > install)
  assert.doesNotMatch(readyHandler, /installDefaultPlugins\(/)
  assert.match(readyHandler, /Verified the bundled desktop integration is current/i)
})

test('startup renders the animated loading page before a potentially long compatibility migration', () => {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  const start = source.indexOf('async function startInitialHarnessWithCompatibilityRepair()')
  const end = source.indexOf('\nasync function ensureOnboardingCandidate', start)
  const initialStart = source.slice(start, end)
  const loading = initialStart.indexOf('await showInitialCompatibilityLoading()')
  const repair = initialStart.indexOf('repairActiveCompatibility')
  const loadingHelper = source.slice(
    source.indexOf('async function showInitialCompatibilityLoading()'),
    start,
  )

  assert.ok(start >= 0)
  assert.ok(end > start)
  assert.ok(loading >= 0)
  assert.ok(repair > loading)
  assert.match(loadingHelper, /loadFallbackPage\(loadingWindow, 'loading\.html'/)
  assert.match(loadingHelper, /windowHost\.show\(loadingWindow\)/)
})

test('bundled live-profile plugins are not prepared during candidate-only startup', () => {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  const readyHandler = source.slice(source.indexOf('app.whenReady().then'))
  const workspace = readyHandler.indexOf("windowHost.create('workspace')")
  const bundled = readyHandler.indexOf('await runtimeController.prepareBundledPlugins()')
  const start = readyHandler.indexOf('startInitialHarnessWithCompatibilityRepair()')

  assert.ok(workspace >= 0)
  assert.equal(bundled, -1)
  assert.ok(start > workspace)
})

test('startup opens the familiar DSH workspace while management stays an explicit auxiliary window', () => {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  const readyHandler = source.slice(source.indexOf('app.whenReady().then'))
  const initialWindow = readyHandler.slice(0, readyHandler.indexOf('const releaseRecovery'))

  assert.match(initialWindow, /windowHost\.create\('workspace'\)/)
  assert.doesNotMatch(initialWindow, /windowHost\.create\('management'\)/)
  assert.doesNotMatch(source, /copy\.managementCenter, click: showManagementCenter/)
  assert.match(source, /const PREFERRED_LOCALE = 'zh-CN'/)
  assert.match(source, /app\.commandLine\.appendSwitch\('lang', PREFERRED_LOCALE\)/)
})

test('pending release recovery runs before any DSH profile installation or preparation', () => {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  const readyHandler = source.slice(source.indexOf('app.whenReady().then'))
  const recover = readyHandler.indexOf('await runtimeController.recoverPendingRelease()')
  const install = readyHandler.indexOf('installDesktopPluginForNewWebProfile({')
  const bundled = readyHandler.indexOf('await runtimeController.prepareBundledPlugins()')

  assert.ok(recover >= 0)
  assert.ok(install > recover)
  assert.equal(bundled, -1)
  assert.match(readyHandler, /Verified the bundled desktop integration is current/i)
})

test('startup resumes a journaled plugin candidate before touching the normal profile path', () => {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  const readyHandler = source.slice(source.indexOf('app.whenReady().then'))
  const recover = readyHandler.indexOf('await runtimeController.recoverPendingRelease()')
  const staged = readyHandler.indexOf('pendingCandidateId', recover)
  const resume = readyHandler.indexOf("restartPluginChanges('startup-plugin-resume')", staged)
  const install = readyHandler.indexOf('installDesktopPluginForNewWebProfile({', recover)

  assert.ok(recover >= 0)
  assert.ok(staged > recover)
  assert.ok(resume > staged)
  assert.ok(install > resume)
})

test('plugin onboarding progress waits for the real candidate stages', () => {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  const start = source.indexOf("progress({ phase: 'candidate-ready'")
  const end = source.indexOf('const staged = await runtimeController.pluginInstallMany', start)
  const installPrelude = source.slice(start, end)

  assert.ok(start >= 0)
  assert.ok(end > start)
  assert.match(installPrelude, /phase: 'install'[\s\S]*value: 35/)
  assert.doesNotMatch(installPrelude, /value: 42/)
})
