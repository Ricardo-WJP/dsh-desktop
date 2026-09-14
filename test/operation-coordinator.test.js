import assert from 'node:assert/strict'
import test from 'node:test'
import { createOperationCoordinator } from '../src/operation-coordinator.js'

test('serializes operations and keeps later work behind an active operation', async () => {
  const order = []
  const coordinator = createOperationCoordinator()
  let release
  const active = coordinator.enqueue('active', async () => {
    order.push('active-start')
    await new Promise(resolve => { release = resolve })
    order.push('active-end')
  })
  const queued = coordinator.enqueue('queued', async () => { order.push('queued') })
  assert.equal(coordinator.busy, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['active-start'])
  release()
  await Promise.all([active, queued])
  assert.deepEqual(order, ['active-start', 'active-end', 'queued'])
  assert.equal(coordinator.busy, false)
})

test('aborted queued operation cannot release a later operation before the active one', async () => {
  const order = []
  const coordinator = createOperationCoordinator()
  let release
  const active = coordinator.enqueue('active', async () => {
    order.push('active-start')
    await new Promise(resolve => { release = resolve })
    order.push('active-end')
  })
  const abortedController = new AbortController()
  const aborted = coordinator.enqueue('aborted', async () => { order.push('aborted-ran') }, { signal: abortedController.signal })
  abortedController.abort(new Error('cancel queued'))
  const later = coordinator.enqueue('later', async () => { order.push('later') })
  await assert.rejects(aborted, /cancel queued/)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['active-start'])
  release()
  await Promise.all([active, later])
  assert.deepEqual(order, ['active-start', 'active-end', 'later'])
})

test('shutdown aborts queued work without allowing a fresh enqueue', async () => {
  const coordinator = createOperationCoordinator()
  let release
  const active = coordinator.enqueue('active', async () => new Promise(resolve => { release = resolve }))
  const queued = coordinator.enqueue('queued', async () => {})
  await new Promise(resolve => setImmediate(resolve))
  coordinator.close()
  release()
  await active
  await assert.rejects(queued, /Desktop operation aborted|shutdown|coordinator is closed/)
  await assert.rejects(coordinator.enqueue('new', async () => {}), /closed/)
})

test('close returns a drain that waits for active release and queued gate release', async () => {
  const coordinator = createOperationCoordinator()
  let release
  const active = coordinator.enqueue('active', async () => new Promise(resolve => { release = resolve }))
  const queued = coordinator.enqueue('queued', async () => {})
  await new Promise(resolve => setImmediate(resolve))

  const queuedRejection = assert.rejects(queued, /Desktop operation aborted|shutdown|coordinator is closed/)
  let drained = false
  const drain = coordinator.close()
  drain.then(() => { drained = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(drained, false)

  release()
  await active
  await queuedRejection
  await drain
  assert.equal(drained, true)
  assert.equal(coordinator.busy, false)
})

test('plugin mutation, Harness restart, and DSH update turns share one serialized owner', async () => {
  const order = []
  const coordinator = createOperationCoordinator()
  let releaseMutation
  const mutation = coordinator.enqueue('plugin-mutation', async () => {
    order.push('plugin-start')
    await new Promise(resolve => { releaseMutation = resolve })
    order.push('plugin-end')
  })
  const restart = coordinator.enqueue('harness-restart', async () => { order.push('restart') })
  const update = coordinator.enqueue('dsh-update', async () => { order.push('dsh-update') })

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(coordinator.active.label, 'plugin-mutation')
  releaseMutation()
  await Promise.all([mutation, restart, update])
  assert.deepEqual(order, ['plugin-start', 'plugin-end', 'restart', 'dsh-update'])
})
