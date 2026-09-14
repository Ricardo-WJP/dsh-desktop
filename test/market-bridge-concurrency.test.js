import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

function fixture({ count = 40, update, install, activate } = {}) {
  let registration
  const listeners = new Map()
  const timers = new Map()
  const effects = []
  let timerId = 0
  class Element {
    constructor(textContent) { this.textContent = textContent }
    closest() { return this }
  }
  const context = vm.createContext({
    console: { warn() {} }, URL, Request, Response, Element,
    location: new URL('http://127.0.0.1:3080/'),
    window: { __ModuleLoader__: { load: value => { registration = value } } },
    document: { querySelector: () => null, createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} },
      addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId },
    clearTimeout: id => timers.delete(id),
    fetch: async () => Response.json({ updates: Object.fromEntries(Array.from({ length: count }, (_, i) => [
      `plugin-${i}`, { kind: 'npm', latest: '2.0.0', updateAvailable: true },
    ])) }),
    dshDesktop: { openPath: async () => ({ ok: true }), publishWorkspaceContext() {},
      updateMarketPlugin: update, installMarketPlugin: install ?? (async () => ({ ok: true })),
      activateMarketUpdate: activate ?? (async () => ({ ok: true })) },
  })
  vm.runInContext(readFileSync(new URL('../src/plugins/dsh-desktop-integration/lib/client.js', import.meta.url), 'utf8'), context)
  registration.factory(() => {}).apply({
    sessions: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} }, openPath() {} },
    locale: { register: () => () => {}, bind: () => value => value },
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose) },
  })
  return {
    all: () => listeners.get('click')({ target: new Element('全部更新') }),
    update: name => context.fetch('/dsh-market/update', { method: 'POST', body: JSON.stringify({ name }) }),
    install: () => context.fetch('/dsh-market/install', { method: 'POST', body: JSON.stringify({ url: 'npm:example-plugin' }) }),
    activate: async () => { for (const fn of [...timers.values()]) fn(); await Promise.resolve() },
    dispose: () => effects.reverse().forEach(fn => fn()),
  }
}

test('simultaneous update-all rows share one transaction and include plugins after row 32', async () => {
  const calls = []
  let release
  const waiting = new Promise(resolve => { release = resolve })
  const f = fixture({ update: async request => { calls.push(request); await waiting; return { ok: true } } })
  f.all()
  const first = f.update('plugin-0')
  const second = f.update('plugin-39')
  release()
  const responses = await Promise.all([first, second])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].updates.length, 40)
  assert.equal(responses.every(response => response.ok), true)
  assert.equal((await responses[1].json()).batchSize, 40)
  f.dispose()
})

test('completed update-all batch cannot satisfy a later update with its old candidate', async () => {
  const calls = []
  const f = fixture({ count: 2, update: async request => {
    calls.push(request)
    return { ok: true, report: { candidateId: `candidate-${calls.length}` } }
  } })
  try {
    f.all()
    await f.update('plugin-0')
    const last = await (await f.update('plugin-1')).json()
    assert.equal(last.batchSize, 2)
    const next = await (await f.update('plugin-0')).json()
    assert.equal(calls.length, 2)
    assert.equal(next.candidateId, 'candidate-2')
    f.all()
    await f.update('plugin-0')
    assert.equal(calls[2].updates.length, 2)
  } finally { f.dispose() }
})

test('double-click install shares its result and unmount prevents delayed activation', async () => {
  let installs = 0
  let activations = 0
  let release
  const waiting = new Promise(resolve => { release = resolve })
  const f = fixture({ update: async () => ({ ok: true }), install: async () => { installs++; await waiting; return { ok: true } }, activate: async () => { activations++; return { ok: true } } })
  const first = f.install()
  const second = f.install()
  await new Promise(resolve => setImmediate(resolve))
  f.dispose()
  release()
  const responses = await Promise.all([first, second])
  assert.equal(installs, 1)
  assert.equal(responses.every(response => response.ok), true)
  await f.activate()
  assert.equal(activations, 0)
})

test('failed concurrent batch rows return the same failure and never activate', async () => {
  let calls = 0
  let activations = 0
  const f = fixture({ update: async () => { calls++; return { ok: false, error: 'candidate boot failed' } }, activate: async () => { activations++; return { ok: true } } })
  f.all()
  const responses = await Promise.all([f.update('plugin-0'), f.update('plugin-1')])
  assert.equal(calls, 1)
  for (const response of responses) { assert.equal(response.status, 409); assert.match((await response.json()).error, /candidate boot failed/) }
  await f.activate()
  assert.equal(activations, 0)
  f.dispose()
})
