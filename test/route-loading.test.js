import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8')
const controller = readFileSync(new URL('../src/desktop-runtime-controller.js', import.meta.url), 'utf8')
const windowHost = readFileSync(new URL('../src/window-host.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../src/ipc/desktop-host.js', import.meta.url), 'utf8')

 test('management route loading is hash-based and does not inject into the Harness page', () => {
  assert.match(app, /window\.location\.hash/)
  assert.match(app, /routeFromLocation/)
  assert.match(app, /LoadingRoute/)
  assert.match(app, /ErrorRoute/)
  assert.match(windowHost, /function loadManagementRoute\(route/)
  assert.match(windowHost, /window\.loadFile\(rendererEntryPath\(\)/)
  assert.match(windowHost, /window\.loadURL\(`\$\{developmentUrl\}/)
  assert.match(windowHost, /function loadWorkspace\(url\)/)
  const overview = controller.indexOf("loadManagementRoute('overview'")
  const ready = controller.indexOf("setStartupState('ready'")
  assert.ok(overview >= 0 && ready > overview, 'management overview must load before ready publication')
  assert.match(controller, /await windows\.loadWorkspace\(url\)[\s\S]*?isPublished\(generation, nextServer\)/)
  assert.match(controller, /workspaceReadiness\.markReady\(generation, nextServer\)/)
  assert.match(host, /if \(\(readState\('workspace', \{\}\) \?\? \{\}\)\.ready !== true\) return unavailable\('Workspace window'\)/)
  // Compatibility gates may inspect or rewrite a plugin's serialized source.
  // The desktop controller itself must never construct a DOM observer.
  assert.doesNotMatch(controller, /^\s*(?:const|let|var)\s+\w+\s*=\s*new MutationObserver\(/m)
  assert.match(controller, /async function start\(message = copy\.preparing, \{ signal \} = \{\}\)/)
  assert.match(controller, /errorDetail\(error\)/)
  assert.doesNotMatch(controller, /void (?:start|showError|installDefaultPlugins)\(/)
})
