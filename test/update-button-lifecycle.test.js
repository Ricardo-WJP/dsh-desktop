import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

test('an update probe settling after disposal cannot recreate its button or timer', async () => {
  const source = readFileSync(new URL('../src/plugins/dsh-desktop-integration/lib/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('    function installUpdateButton()')
  const end = source.indexOf('    function installAppearanceSettings(', start)
  assert(start >= 0 && end > start)
  const timers = new Map()
  let nextTimer = 0
  let finishProbe
  let appended = 0
  class Element {
    dataset = {}
    classList = { add() {} }
    querySelector() { return null }
    setAttribute() {}
    addEventListener() {}
    append() { appended++ }
    remove() {}
  }
  const context = vm.createContext({
    HTMLElement: Element,
    document: { body: {}, createElement: () => new Element() },
    MutationObserver: class { observe() {} disconnect() {} },
    console,
    bridge: { checkUpdate: () => new Promise(resolve => { finishProbe = resolve }) },
    settingsButton: () => new Element(), settingsRow: () => new Element(),
    updateIcon: () => new Element(),
    UPDATE_BUTTON_MARKER: 'test-update',
    window: { setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer }, clearTimeout: id => timers.delete(id) },
  })
  const dispose = vm.runInContext(`${source.slice(start, end)};installUpdateButton()`, context)
  const first = [...timers.values()][0]
  timers.clear()
  first()
  dispose()
  finishProbe({ ok: true, available: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(appended, 0)
  assert.equal(timers.size, 0)
})
