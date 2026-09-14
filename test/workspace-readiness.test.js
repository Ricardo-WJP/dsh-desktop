import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkspaceReadinessOwner } from '../src/workspace-readiness.js'

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve))
}

test('workspace readiness stays private until delayed loadURL and overview both finish', async () => {
  let generation = 1
  const server = { name: 'first' }
  let published = server
  let windowOpen = true
  const owner = createWorkspaceReadinessOwner({
    isCurrent: token => token === generation,
    isPublished: (token, candidate) => token === generation && candidate === published,
    isWindowOpen: () => windowOpen,
  })
  let finishLoad
  let finishOverview
  const loadURL = new Promise(resolve => { finishLoad = resolve })
  const overview = new Promise(resolve => { finishOverview = resolve })
  const startup = (async () => {
    await loadURL
    await overview
    return owner.markReady(1, server)
  })()

  assert.equal(owner.isReady(), false)
  finishLoad()
  await nextTurn()
  assert.equal(owner.isReady(), false)
  finishOverview()
  assert.equal(await startup, true)
  assert.equal(owner.isReady(), true)

  windowOpen = false
  assert.equal(owner.isReady(), false)
})

test('a stale delayed generation cannot publish workspace readiness for a newer server', async () => {
  let generation = 1
  const first = { name: 'first' }
  const second = { name: 'second' }
  let published = first
  const owner = createWorkspaceReadinessOwner({
    isCurrent: token => token === generation,
    isPublished: (token, candidate) => token === generation && candidate === published,
  })
  let finishFirstOverview
  const firstOverview = new Promise(resolve => { finishFirstOverview = resolve })
  const staleStartup = (async () => {
    await firstOverview
    return owner.markReady(1, first)
  })()

  generation = 2
  published = second
  finishFirstOverview()
  assert.equal(await staleStartup, false)
  assert.equal(owner.isReady(), false)
  assert.equal(owner.markReady(2, second), true)
  assert.equal(owner.isReady(), true)

  owner.reset()
  assert.equal(owner.isReady(), false)
})
