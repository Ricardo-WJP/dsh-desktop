import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  RELEASE_POINTER_SCHEMA_VERSION,
  STAGED_PLUGIN_CANDIDATE_SCHEMA_VERSION,
  ReleaseStateError,
  ReleaseStateStore,
  validatePendingTransaction,
  validateReleasePointer,
  validateStagedPluginCandidate,
} from '../src/release/state-store.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const PENDING_PHASES = ['prepared', 'snapshot-published', 'active-published', 'observing', 'restoring']

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-release-state-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function pointer(overrides = {}) {
  return {
    schemaVersion: RELEASE_POINTER_SCHEMA_VERSION,
    releaseId: 'stable-2026-08-21-001',
    manifestSha256: HASH_A,
    activatedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  }
}

function pending(overrides = {}) {
  return {
    operation: 'switch',
    phase: 'prepared',
    previousActive: pointer(),
    targetActive: pointer({
      releaseId: 'stable-2026-08-21-002',
      manifestSha256: HASH_B,
      activatedAt: '2026-08-21T01:00:00.000Z',
    }),
    snapshotId: null,
    rescueSnapshotId: null,
    startedAt: '2026-08-21T02:00:00.000Z',
    ...overrides,
  }
}

function stagedPluginCandidate(overrides = {}) {
  return {
    schemaVersion: STAGED_PLUGIN_CANDIDATE_SCHEMA_VERSION,
    candidateId: 'plugin-2026-08-25-001',
    parentReleaseId: 'stable-2026-08-21-001',
    manifestSha256: HASH_B,
    stagedAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  }
}

test('writes, fsyncs, atomically replaces, and reads active and last-known-good pointers', (t) => {
  const root = temporaryDirectory(t)
  const store = new ReleaseStateStore(root)
  assert.equal(store.readActive(), undefined)
  assert.equal(store.readLastKnownGood(), undefined)

  const first = store.writeActive(pointer())
  const knownGood = store.writeLastKnownGood(pointer())
  assert.deepEqual(store.readActive(), first)
  assert.deepEqual(store.readLastKnownGood(), knownGood)

  const replacement = pointer({
    releaseId: 'stable-2026-08-21-002',
    manifestSha256: HASH_B,
    activatedAt: '2026-08-21T01:00:00.000Z',
  })
  store.writeActive(replacement)

  assert.deepEqual(store.readActive(), validateReleasePointer(replacement))
  assert.deepEqual(store.readLastKnownGood(), validateReleasePointer(pointer()))
  assert.deepEqual(readdirSync(root).sort(), ['active.json', 'last-known-good.json'])
  assert.match(readFileSync(join(root, 'active.json'), 'utf8'), /stable-2026-08-21-002/)
})

test('rejects invalid pointers before creating or replacing state', (t) => {
  const root = temporaryDirectory(t)
  const store = new ReleaseStateStore(root)
  store.writeActive(pointer())
  const original = readFileSync(join(root, 'active.json'), 'utf8')

  assert.throws(() => store.writeActive(pointer({ manifestSha256: 'short' })), /manifestSha256/)
  assert.throws(() => store.writeActive(pointer({ releaseId: '../outside' })), /releaseId/)
  assert.throws(() => store.writeActive(pointer({ activatedAt: 'yesterday' })), /activatedAt/)

  assert.equal(readFileSync(join(root, 'active.json'), 'utf8'), original)
  assert.equal(readdirSync(root).some(name => name.endsWith('.tmp')), false)
})

test('preserves corrupt, torn, and old-schema pointer files for diagnosis', async (t) => {
  for (const name of ['corrupt.json', 'torn.json', 'old-schema.json']) {
    await t.test(name, () => {
      const root = temporaryDirectory(t)
      const active = join(root, 'active.json')
      const fixture = new URL(`./fixtures/release-state/${name}`, import.meta.url)
      copyFileSync(fixture, active)
      const original = readFileSync(active, 'utf8')
      const store = new ReleaseStateStore(root)

      assert.throws(() => store.readActive(), ReleaseStateError)
      assert.equal(readFileSync(active, 'utf8'), original)
      assert.equal(existsSync(active), true)
    })
  }
})

test('ignores unrelated temporary files but never treats them as active state', (t) => {
  const root = temporaryDirectory(t)
  writeFileSync(join(root, '.active.json.interrupted.tmp'), '{')
  const store = new ReleaseStateStore(root)

  assert.equal(store.readActive(), undefined)
  store.writeActive(pointer())
  assert.deepEqual(store.readActive(), validateReleasePointer(pointer()))
  assert.equal(existsSync(join(root, '.active.json.interrupted.tmp')), true)
})

test('writes and reads a strict pending journal for every transaction phase without changing active or LKG', (t) => {
  const root = temporaryDirectory(t)
  const store = new ReleaseStateStore(root)
  const active = store.writeActive(pointer())
  const lastKnownGood = store.writeLastKnownGood(pointer({
    releaseId: 'stable-2026-08-20-001',
    activatedAt: '2026-08-20T00:00:00.000Z',
  }))
  const activeText = readFileSync(join(root, 'active.json'), 'utf8')
  const lastKnownGoodText = readFileSync(join(root, 'last-known-good.json'), 'utf8')

  for (const [index, phase] of PENDING_PHASES.entries()) {
    const transaction = pending({
      operation: phase === 'restoring' ? 'rollback' : 'switch',
      phase,
      previousActive: index === 0 ? null : pointer(),
      targetActive: phase === 'restoring' ? null : pending().targetActive,
      snapshotId: phase === 'prepared' ? null : `snapshot-${String(index + 1)}`,
      rescueSnapshotId: phase === 'restoring' ? 'rescue-snapshot-1' : null,
    })

    assert.deepEqual(store.writePending(transaction), validatePendingTransaction(transaction))
    assert.deepEqual(store.readPending(), validatePendingTransaction(transaction))
  }

  assert.deepEqual(store.readActive(), active)
  assert.deepEqual(store.readLastKnownGood(), lastKnownGood)
  assert.equal(readFileSync(join(root, 'active.json'), 'utf8'), activeText)
  assert.equal(readFileSync(join(root, 'last-known-good.json'), 'utf8'), lastKnownGoodText)
  assert.deepEqual(readdirSync(root).sort(), ['active.json', 'last-known-good.json', 'pending.json'])
})

test('rejects pending journals with unknown, missing, or invalid fields before replacing valid state', (t) => {
  const root = temporaryDirectory(t)
  const store = new ReleaseStateStore(root)
  store.writeActive(pointer())
  store.writeLastKnownGood(pointer({ releaseId: 'stable-2026-08-20-001' }))
  store.writePending(pending())
  const pendingPath = join(root, 'pending.json')
  const original = readFileSync(pendingPath, 'utf8')
  const cases = [
    ['unknown field', { unexpected: true }, /unexpected.*unknown field/],
    ['missing field', { phase: undefined }, /phase.*missing field/],
    ['operation', { operation: 'deploy' }, /operation/],
    ['phase', { phase: 'committing' }, /phase/],
    ['previousActive', { previousActive: { releaseId: 'bad' } }, /previousActive/],
    ['targetActive', { targetActive: 42 }, /targetActive/],
    ['snapshotId', { snapshotId: '' }, /snapshotId/],
    ['snapshotId traversal', { snapshotId: '../snapshot' }, /snapshotId/],
    ['rescueSnapshotId', { rescueSnapshotId: 42 }, /rescueSnapshotId/],
    ['startedAt', { startedAt: '2026-08-21T02:00:00Z' }, /startedAt/],
  ]

  for (const [label, overrides, errorPattern] of cases) {
    const candidate = pending(overrides)
    if (label === 'missing field') delete candidate.phase
    assert.throws(() => store.writePending(candidate), errorPattern, label)
  }

  assert.equal(readFileSync(pendingPath, 'utf8'), original)
  assert.equal(readdirSync(root).some(name => name.includes('.tmp')), false)
  assert.deepEqual(store.readActive(), validateReleasePointer(pointer()))
  assert.deepEqual(store.readLastKnownGood(), validateReleasePointer(pointer({ releaseId: 'stable-2026-08-20-001' })))
})

test('preserves torn and corrupt pending journals for diagnosis', (t) => {
  for (const content of [
    '{"operation":"switch",',
    '{"operation":"switch","phase":"prepared"}',
    '{"operation":"switch","phase":"prepared","previousActive":null,"targetActive":null,"snapshotId":null,"rescueSnapshotId":null,"startedAt":"not-a-timestamp"}',
  ]) {
    const root = temporaryDirectory(t)
    const pendingPath = join(root, 'pending.json')
    writeFileSync(pendingPath, content)
    const store = new ReleaseStateStore(root)

    assert.throws(() => store.readPending(), ReleaseStateError)
    assert.equal(readFileSync(pendingPath, 'utf8'), content)
    assert.equal(existsSync(pendingPath), true)
  }
})

test('clears pending state idempotently without changing active or last-known-good', (t) => {
  const root = temporaryDirectory(t)
  const store = new ReleaseStateStore(root)
  const active = store.writeActive(pointer())
  const lastKnownGood = store.writeLastKnownGood(pointer({ releaseId: 'stable-2026-08-20-001' }))
  store.writePending(pending())

  store.clearPending()
  assert.equal(store.readPending(), undefined)
  assert.equal(existsSync(join(root, 'pending.json')), false)
  assert.doesNotThrow(() => store.clearPending())
  assert.deepEqual(store.readActive(), active)
  assert.deepEqual(store.readLastKnownGood(), lastKnownGood)
})

test('persists and clears the exact staged plugin candidate independently of the release switch journal', (t) => {
  const root = temporaryDirectory(t)
  const store = new ReleaseStateStore(root)
  const active = store.writeActive(pointer())
  const staged = store.writeStagedPluginCandidate(stagedPluginCandidate())

  assert.deepEqual(staged, validateStagedPluginCandidate(stagedPluginCandidate()))
  assert.deepEqual(store.readStagedPluginCandidate(), staged)
  assert.equal(store.readPending(), undefined)
  assert.deepEqual(store.readActive(), active)
  assert.deepEqual(readdirSync(root).sort(), ['active.json', 'plugin-candidate.json'])

  store.clearStagedPluginCandidate()
  assert.equal(store.readStagedPluginCandidate(), undefined)
  assert.equal(existsSync(join(root, 'plugin-candidate.json')), false)
  assert.doesNotThrow(() => store.clearStagedPluginCandidate())
})

test('rejects stale plugin candidate identity before replacing a valid staged record', (t) => {
  const root = temporaryDirectory(t)
  const store = new ReleaseStateStore(root)
  store.writeStagedPluginCandidate(stagedPluginCandidate())
  const path = join(root, 'plugin-candidate.json')
  const original = readFileSync(path, 'utf8')

  assert.throws(() => store.writeStagedPluginCandidate(stagedPluginCandidate({ candidateId: '../outside' })), /candidateId/)
  assert.throws(() => store.writeStagedPluginCandidate(stagedPluginCandidate({ parentReleaseId: 'plugin-2026-08-25-001' })), /must differ/)
  assert.throws(() => store.writeStagedPluginCandidate(stagedPluginCandidate({ manifestSha256: 'short' })), /manifestSha256/)
  assert.throws(() => store.writeStagedPluginCandidate(stagedPluginCandidate({ stagedAt: 'today' })), /stagedAt/)
  assert.equal(readFileSync(path, 'utf8'), original)
})

test('accepts only absolute roots and known pointer kinds', (t) => {
  assert.throws(() => new ReleaseStateStore('relative/state'), /absolute path/)
  const store = new ReleaseStateStore(temporaryDirectory(t))
  assert.throws(() => store.path('other'), /Unknown release pointer kind/)
})
