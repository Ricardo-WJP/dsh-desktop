import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { generatePreloads, generatedPreloadPath } from '../src/ipc/preload-generator.js'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const smokeApp = fileURLToPath(new URL('../test-support/electron-sandbox-smoke.cjs', import.meta.url))

const preloadSmokeSpecs = Object.freeze([
  Object.freeze({ preload: generatedPreloadPath('management', root), bridge: 'dshDesktop', methods: Object.freeze(['status', 'mode', 'candidate', 'update', 'snapshots', 'recovery', 'logs', 'workspace', 'app']) }),
  Object.freeze({ preload: generatedPreloadPath('workspace', root), bridge: 'dshDesktop', methods: Object.freeze(['openPath', 'openSettingsDocument', 'openUpdate', 'checkUpdate', 'getUpdates', 'checkUpdates', 'executeUpdates', 'openUpdateLink', 'onUpdatesChanged', 'updateMarketPlugin', 'installMarketPlugin', 'activateMarketUpdate', 'restart', 'startSafeMode', 'openLogs', 'publishWorkspaceContext', 'reportTheme']) }),
  Object.freeze({ preload: generatedPreloadPath('splash', root), bridge: 'dshOnboarding', methods: Object.freeze(['recommendations', 'install', 'progress', 'skip', 'window']) }),
])

test('Electron sandbox loads all generated preloads and exposes only their role bridges', { timeout: 90_000 }, () => {
  if (!["management", "workspace", "splash"].every(kind => existsSync(generatedPreloadPath(kind, root)))) generatePreloads(root)
  const electron = require('electron')
  const env = { ...process.env, DSH_PRELOAD_SMOKE_SPECS: JSON.stringify(preloadSmokeSpecs) }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(electron, ['--headless', '--disable-gpu', smokeApp], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, output)
  assert.match(output, /PRELOAD_SMOKE_OK dshDesktop/)
})
