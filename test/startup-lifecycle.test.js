import assert from 'node:assert/strict'
import test from 'node:test'
import { createHarnessLifecycleOwner } from '../src/startup-lifecycle.js'

function fakeServer(name, events) {
  return {
    name,
    async stop() { events.push(`stop:${name}`) },
  }
}

test('stale generations cannot clear or stop a newer published server', async () => {
  const events = []
  const publications = []
  const owner = createHarnessLifecycleOwner({
    onPublish: value => publications.push(`publish:${value.server.name}`),
    onClear: value => publications.push(`clear:${value.server.name}`),
  })
  const first = owner.begin()
  const firstServer = fakeServer('first', events)
  owner.attach(first, firstServer)
  assert.equal(owner.publish(first, firstServer, 'http://127.0.0.1:4101'), true)

  const second = owner.begin()
  const secondServer = fakeServer('second', events)
  owner.attach(second, secondServer)
  assert.equal(await owner.stopLocal(first, firstServer), true)
  assert.equal(owner.publish(second, secondServer, 'http://127.0.0.1:4102'), true)

  assert.equal(owner.clearPublished(first, firstServer), false)
  assert.equal(owner.isPublished(second, secondServer), true)
  assert.equal(await owner.stopLocal(first, firstServer), false)
  assert.deepEqual(events, ['stop:first'])
  assert.deepEqual(publications, ['publish:first', 'clear:first', 'publish:second'])
})

test('an older startup only stops its own server after a restart invalidates it', async () => {
  const events = []
  const owner = createHarnessLifecycleOwner()
  const first = owner.begin()
  const firstServer = fakeServer('first', events)
  owner.attach(first, firstServer)
  const second = owner.begin()
  await owner.stopOlder(second)
  const secondServer = fakeServer('second', events)
  owner.attach(second, secondServer)
  assert.equal(owner.publish(second, secondServer, 'http://127.0.0.1:4202'), true)
  assert.equal(owner.isCurrent(first), false)
  assert.equal(await owner.stopLocal(first, firstServer), false)
  assert.equal(owner.isPublished(second, secondServer), true)
  assert.deepEqual(events, ['stop:first'])
})

test('stopAll invalidates in-flight generations before awaiting owned cleanup', async () => {
  const events = []
  let release
  const owner = createHarnessLifecycleOwner()
  const generation = owner.begin()
  const server = {
    async stop() {
      events.push('stop-start')
      await new Promise(resolve => { release = resolve })
      events.push('stop-end')
    },
  }
  owner.attach(generation, server)
  const stopping = owner.stopAll()
  assert.equal(owner.isCurrent(generation), false)
  assert.equal(owner.publish(generation, server, 'http://127.0.0.1:4300'), false)
  release()
  await stopping
  assert.deepEqual(events, ['stop-start', 'stop-end'])
})

test('stale attachments are rejected instead of becoming orphaned local servers', async () => {
  const events = []
  const owner = createHarnessLifecycleOwner()
  const first = owner.begin()
  const second = owner.begin()
  const staleServer = fakeServer('stale', events)
  const currentServer = fakeServer('current', events)

  assert.equal(owner.attach(first, staleServer), false)
  assert.equal(owner.attach(second, currentServer), true)
  await owner.stopAll()

  assert.deepEqual(events, ['stop:current'])
})

test('overlapping startup tasks cannot publish, navigate, or report stale work', async () => {
  const events = []
  let releaseFirst
  const owner = createHarnessLifecycleOwner({
    onPublish: publication => events.push(`publish:${publication.server.name}`),
    onClear: publication => events.push(`clear:${publication.server.name}`),
  })
  const first = owner.run(async context => {
    const server = fakeServer('first', events)
    assert.equal(context.attach(server), true)
    await new Promise(resolve => { releaseFirst = resolve })
    if (!context.isCurrent()) return false
    assert.equal(context.publish(server, 'http://127.0.0.1:4401'), true)
    events.push('workspace:first')
    events.push('management:error:first')
    events.push('ready:first')
    return true
  })

  // The second start owns the latest token and cleans the first local server
  // before it publishes any route or ready state.
  const second = owner.run(async context => {
    const server = fakeServer('second', events)
    assert.equal(context.attach(server), true)
    assert.equal(context.publish(server, 'http://127.0.0.1:4402'), true)
    events.push('workspace:second')
    events.push('management:overview:second')
    events.push('ready:second')
    return true
  }, { stopOlder: true })
  assert.equal(await second, true)

  releaseFirst()
  assert.equal(await first, false)
  assert.deepEqual(events, [
    'stop:first',
    'publish:second',
    'workspace:second',
    'management:overview:second',
    'ready:second',
  ])
  assert.equal(owner.published.server.name, 'second')
  await owner.stopAll()
})

test('concurrent cleanup of one local server calls stop exactly once', async () => {
  let release
  let stops = 0
  const owner = createHarnessLifecycleOwner()
  const generation = owner.begin()
  const server = {
    async stop() {
      stops += 1
      await new Promise(resolve => { release = resolve })
    },
  }
  owner.attach(generation, server)
  const first = owner.stopLocal(generation, server)
  const second = owner.stopLocal(generation, server)
  await new Promise(resolve => setImmediate(resolve))
  release()
  await Promise.all([first, second])
  assert.equal(stops, 1)
})

test('lifecycle cleanup rejection is latched and blocks every new generation', async () => {
  const failure = new Error('legacy Harness tree cleanup incomplete')
  const owner = createHarnessLifecycleOwner()
  const first = owner.begin()
  const server = { stop: async () => { throw failure } }
  assert.equal(owner.attach(first, server), true)

  await assert.rejects(owner.stopLocal(first, server), error => error === failure)
  assert.equal(owner.unsafe, true)
  assert.equal(owner.cleanupError, failure)
  assert.throws(() => owner.begin(), error => error === failure)
  assert.equal(owner.attach(first + 1, { stop: async () => {} }), false)
  assert.equal(owner.publish(first, server, 'http://127.0.0.1:4501'), false)
  await assert.rejects(owner.stopAll(), error => error === failure)
})

test('stopOlder surfaces rejected cleanup instead of reporting settled success', async () => {
  const failure = new Error('older tree cleanup failed')
  const owner = createHarnessLifecycleOwner()
  const first = owner.begin()
  const server = { stop: async () => { throw failure } }
  owner.attach(first, server)
  const second = owner.begin()
  await assert.rejects(owner.stopOlder(second), error => error === failure)
  assert.equal(owner.unsafe, true)
  assert.equal(owner.cleanupError, failure)
})
