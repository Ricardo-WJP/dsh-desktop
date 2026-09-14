import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { installShellUiOverrides, DESKTOP_UI } from '../src/shell-ui-overrides.js'

test('shell injection is once per window, valid JS, and restores after navigation', async () => {
  const wc = new EventEmitter(), calls = []
  wc.isDestroyed = () => false
  wc.executeJavaScript = async script => calls.push(script)
  const window = { webContents: wc }
  installShellUiOverrides(window)
  installShellUiOverrides(window)
  assert.equal(wc.listenerCount('dom-ready'), 1)
  wc.emit('dom-ready'); wc.emit('did-finish-load')
  await Promise.resolve()
  assert.equal(calls.length, 2)
  new vm.Script(calls[0])
  const exposed = calls[0].replace('if (document.body) start()', 'window.testClamp = clampSidebar; if (document.body) start()')
  const style = { textContent: '' }
  const context = { window: {}, document: { body: null, addEventListener() {}, getElementById: () => style } }
  vm.runInNewContext(exposed, context)
  assert.equal(context.window.testClamp(200), 240)
  assert.equal(context.window.testClamp(500), 420)
  assert.equal(context.window.testClamp(320), 320)
  assert.deepEqual([DESKTOP_UI.sidebarMinWidth, DESKTOP_UI.sidebarMaxWidth], [240, 420])
  wc.isDestroyed = () => true
  wc.emit('dom-ready'); await Promise.resolve()
  assert.equal(calls.length, 2)
})

test('settings inherits chrome without blanket leaf colours or a second drag titlebar', () => {
  const css = readFileSync(new URL('../src/shell-ui-overrides.css', import.meta.url), 'utf8')
  const js = readFileSync(new URL('../src/shell-ui-overrides.js', import.meta.url), 'utf8')
  assert.match(css, /nav\.dcu-settings-nav \{ background-color: transparent !important; \}/)
  assert.doesNotMatch(css, /\.dcu-settings-main::before/)
  assert.match(css, /inset: 40px 0 0 !important/)
  assert.match(css, /:has\(\.dcu-settings-page\)/)
  assert.doesNotMatch(js, /nav\.querySelectorAll\('\*'\)/)
  assert.match(css, /overflow: visible/)
  assert.doesNotMatch(css, /overflow: hidden/)
  assert.match(css, /box-shadow: none !important/)
  assert.match(css, /#dsh-desktop-titlebar button \{[\s\S]*?corner-shape: superellipse\(1\.5\)/)
  assert.match(css, /\[data-dcu-official-turn-navigator\] button::before \{\s+left: 0;\s+right: auto;/)
  assert.match(css, /\.re-setting-switch-knob \{ border-radius: 50% !important; corner-shape: round !important/)
  assert.ok(js.includes("row.removeAttribute('inert')"))
  assert.ok(js.includes('nav.appendChild(handle)'))
  assert.doesNotMatch(js, /setAttribute\('d', CODEX_FOLDER_D\)/)
  for (const event of ['pointercancel', 'blur']) {
    assert.ok(js.includes(`window.addEventListener('${event}', up)`))
    assert.ok(js.includes(`window.removeEventListener('${event}', up)`))
  }
})

test('native resize echoes cannot overwrite a settings-owned width', async () => {
  const wc = new EventEmitter(); let script, resize
  wc.isDestroyed = () => false
  wc.executeJavaScript = async value => { script = value }
  installShellUiOverrides({ webContents: wc }); wc.emit('dom-ready'); await Promise.resolve()
  script = script.replace('if (document.body) start()', 'window.qa = { observe: observeNativeSidebar, own: n => { settingsWidthOwner = n; sharedSidebarWidth = 330 }, width: () => sharedSidebarWidth }; if (document.body) start()')
  const nav = { isConnected: true }
  let activeNav = nav, nativeWidth = 280
  const aside = { hasAttribute: () => false, setAttribute() {}, getBoundingClientRect: () => ({ width: nativeWidth }) }
  const context = { window: {}, ResizeObserver: class { constructor(cb) { resize = cb } observe() {} },
    document: { body: null, addEventListener() {}, getElementById: () => ({ textContent: '' }),
      querySelector: selector => selector === 'aside' ? aside : selector === 'nav.dcu-settings-nav' ? activeNav : null } }
  vm.runInNewContext(script, context)
  context.window.qa.observe(); context.window.qa.own(nav)
  resize(); assert.equal(context.window.qa.width(), 330)
  nativeWidth = 315; resize(); assert.equal(context.window.qa.width(), 330)
  nav.isConnected = false; activeNav = null
  resize(); assert.equal(context.window.qa.width(), 315)
})

test('removed settings pages are released without dropping the connected resize owner', async () => {
  const wc = new EventEmitter(); let script
  wc.isDestroyed = () => false
  wc.executeJavaScript = async value => { script = value }
  installShellUiOverrides({ webContents: wc }); wc.emit('dom-ready'); await Promise.resolve()
  script = script.replace('if (document.body) start()', 'window.qa = { own: n => { chromeState.nav = n; settingsWidthOwner = n }, patch, owners: () => [chromeState.nav, settingsWidthOwner] }; if (document.body) start()')
  const context = { window: {}, document: { body: null, addEventListener() {}, getElementById: () => ({ textContent: '' }), querySelector: () => null } }
  vm.runInNewContext(script, context)
  const nav = { isConnected: true }
  context.window.qa.own(nav); context.window.qa.patch()
  assert.equal(context.window.qa.owners()[0], nav)
  assert.equal(context.window.qa.owners()[1], nav)
  nav.isConnected = false; context.window.qa.patch()
  assert.equal(context.window.qa.owners()[0], null)
  assert.equal(context.window.qa.owners()[1], null)
})
