import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function load() {
  let registration
  const cleanups = []
  const original = { component: props => props, options: { id: 'legacy-control' } }
  const entries = [original]
  let listener
  const slots = {
    entries: name => name === 'conversation.input.left' ? entries : [],
    subscribe: (name, fn) => { if (name === 'conversation.input.left') listener = fn; return () => {} },
    register: (options, component) => { const entry = { options, component }; entries.push(entry); return () => entries.splice(entries.indexOf(entry), 1) },
  }
  class Directory {
    constructor() { this.ctx = { session: 'caller-without-remote' }; this.catalog = { ctx: { remote: { session: 'provider-authorized' } } } }
    directoryFor(id) { return [id, this.ctx.remote.session] }
  }
  const service = new Directory()
  const initialMethod = Directory.prototype.directoryFor
  const effect = callback => { const stop = callback(); if (typeof stop === 'function') cleanups.push(stop) }
  const context = vm.createContext({ console, window: { __ModuleLoader__: { load: r => { registration = r } } },
    dshDesktop: { openPath() {}, publishWorkspaceContext() {} } })
  vm.runInContext(readFileSync(new URL('../src/plugins/dsh-desktop-integration/lib/client.js', import.meta.url), 'utf8'), context)
  const plugin = registration.factory(name => { assert.equal(name, 'react'); return { createElement: (component, props) => component(props) } })
  const store = { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} }
  plugin.apply({ sessions: { list: store }, workspaces: { list: store, openPath() {} }, locale: { register: () => () => {}, bind: () => key => key }, effect,
    inject: (names, callback) => callback({ effect, slots, modelDirectories: service }) })
  return { entries, original, service, initialMethod, notify: () => listener(), dispose: () => cleanups.reverse().forEach(stop => stop()) }
}

test('model directory delegates to its own injected provider without granting remotes to callers', () => {
  const f = load()
  assert.deepEqual(f.service.directoryFor('session-a'), ['session-a', 'provider-authorized'])
  assert.equal(f.service.ctx.remote, undefined)
  f.dispose()
  assert.equal(Object.getPrototypeOf(f.service).directoryFor, f.initialMethod)
})

test('legacy composer gets reactive draft/session snapshots and retains the original actions', () => {
  const f = load()
  const wrapper = f.entries.find(entry => entry !== f.original)
  const actions = { setDraft() {} }
  const render = draft => wrapper.component({ useInput: select => select({ draft }), useSession: select => select({ sessionId: 'session-a' }), inputActions: actions })
  assert.equal(render('').input.draft, '')
  const typed = render('a real draft')
  assert.equal(typed.input.draft, 'a real draft')
  assert.equal(typed.session.sessionId, 'session-a')
  assert.equal(typed.inputActions, actions)
  f.notify(); f.notify()
  assert.equal(f.entries.length, 2)
  f.entries.splice(f.entries.indexOf(f.original), 1)
  f.notify()
  assert.equal(f.entries.length, 0, 'removing a plugin also removes its adapter')
  f.dispose()
})
