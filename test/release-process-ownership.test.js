import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  acquireReleaseOwnership,
  ReleaseOwnershipError,
  releaseOwnershipEndpoint,
} from '../src/release/process-ownership.js'

function temporaryStateRoot(t, label = 'dsh-release-owner-') {
  const root = mkdtempSync(join(tmpdir(), label))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return join(root, 'release-state')
}

test('release ownership serializes independent processes for one state root', async t => {
  const stateRoot = temporaryStateRoot(t)
  const first = await acquireReleaseOwnership({ stateRoot, role: 'desktop', pid: process.pid })
  t.after(() => first.release())

  await assert.rejects(
    acquireReleaseOwnership({ stateRoot, role: 'maintenance', pid: process.pid + 1 }),
    error => error instanceof ReleaseOwnershipError
      && error.code === 'DSH_RELEASE_OWNER_BUSY'
      && error.owner?.role === 'desktop'
      && error.owner?.pid === process.pid,
  )

  await first.release()
  assert.equal(first.released, true)
  const second = await acquireReleaseOwnership({ stateRoot, role: 'maintenance', pid: process.pid })
  await second.release()
})

test('release ownership release is idempotent', async t => {
  const owner = await acquireReleaseOwnership({ stateRoot: temporaryStateRoot(t), role: 'desktop' })
  const first = owner.release()
  const second = owner.release()
  assert.equal(first, second)
  await first
})

test('different release roots use different ownership endpoints and may coexist', async t => {
  const firstRoot = temporaryStateRoot(t, 'dsh-release-owner-a-')
  const secondRoot = temporaryStateRoot(t, 'dsh-release-owner-b-')
  assert.notEqual(releaseOwnershipEndpoint(firstRoot), releaseOwnershipEndpoint(secondRoot))
  const [first, second] = await Promise.all([
    acquireReleaseOwnership({ stateRoot: firstRoot, role: 'desktop' }),
    acquireReleaseOwnership({ stateRoot: secondRoot, role: 'maintenance' }),
  ])
  await Promise.all([first.release(), second.release()])
})

test('release ownership fails closed when a Windows endpoint never binds', async t => {
  const stateRoot = temporaryStateRoot(t)
  const keepAlive = setTimeout(() => {}, 250)
  t.after(() => clearTimeout(keepAlive))
  const server = new EventEmitter()
  server.listen = () => server
  server.close = callback => {
    callback?.()
    return server
  }

  const startedAt = Date.now()
  await assert.rejects(
    acquireReleaseOwnership({
      stateRoot,
      platform: 'win32',
      bindTimeoutMs: 10,
      createServerImpl: () => server,
      connectImpl: () => { throw new Error('owner probe unavailable') },
    }),
    error => error instanceof ReleaseOwnershipError
      && error.code === 'DSH_RELEASE_OWNER_BUSY'
      && error.cause?.code === 'ETIMEDOUT',
  )
  assert.ok(Date.now() - startedAt < 1_000)
})
