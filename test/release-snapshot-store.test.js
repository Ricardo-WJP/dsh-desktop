import assert from 'node:assert/strict'
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  SnapshotIntegrityError,
  SnapshotStore,
  windowsRoamingVirtualizationEquivalent,
} from '../src/release/snapshot-store.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-snapshot-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, sourceRoot: join(root, 'data'), snapshotRoot: join(root, 'snapshots') }
}

test('Windows packaged-app Roaming virtualization is not mistaken for a junction', () => {
  const logical = 'C:\\Users\\tester\\AppData\\Roaming\\dsh-desktop\\DIPS'
  const physical = 'C:\\Users\\tester\\AppData\\Local\\Packages\\Example.App_123\\LocalCache\\Roaming\\dsh-desktop\\DIPS'
  assert.equal(windowsRoamingVirtualizationEquivalent(logical, physical), true)
  assert.equal(
    windowsRoamingVirtualizationEquivalent(
      logical,
      'C:\\Users\\tester\\AppData\\Local\\Packages\\Example.App_123\\LocalCache\\Roaming\\other-app\\DIPS',
    ),
    false,
  )
})

async function seed(sourceRoot) {
  await mkdir(join(sourceRoot, '目录'), { recursive: true })
  await writeFile(join(sourceRoot, 'empty.txt'), '')
  await writeFile(join(sourceRoot, 'binary.bin'), Buffer.from([0, 1, 2, 127, 255]))
  await writeFile(join(sourceRoot, 'inventory.json'), 'user-owned inventory\n')
  await writeFile(join(sourceRoot, '目录', '说明.txt'), '快照内容\n')
}

test('hidden source roots keep a single-dot sibling snapshot directory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hidden-snapshot-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sourceRoot = join(root, '.dsh')
  await seed(sourceRoot)

  const store = new SnapshotStore({ sourceRoot })
  await store.create({ snapshotId: 'hidden-root' })

  assert.equal(existsSync(join(root, '.dsh-snapshots', 'hidden-root')), true)
  assert.equal(existsSync(join(root, '..dsh-snapshots')), false)
})

test('snapshot round-trip preserves binary, empty, and Chinese-path files byte-for-byte', async t => {
  const paths = fixture(t)
  await seed(paths.sourceRoot)
  const store = new SnapshotStore(paths)
  const created = await store.create({ snapshotId: 'pre-switch-1', createdAt: '2026-08-22T00:00:00.000Z' })
  assert.equal(created.count, 4)
  assert.equal(created.kind, 'pre-switch')
  assert.equal((await store.list()).length, 1)
  assert.deepEqual(await store.sizeReport({ snapshotId: 'pre-switch-1' }), { count: created.count, bytes: created.bytes })

  await writeFile(join(paths.sourceRoot, 'binary.bin'), 'changed')
  await writeFile(join(paths.sourceRoot, 'new.txt'), 'new')
  const restored = await store.restore({ snapshotId: 'pre-switch-1' })

  assert.deepEqual([...await readFile(join(paths.sourceRoot, 'binary.bin'))], [0, 1, 2, 127, 255])
  assert.equal((await readFile(join(paths.sourceRoot, 'empty.txt'))).byteLength, 0)
  assert.equal(await readFile(join(paths.sourceRoot, '目录', '说明.txt'), 'utf8'), '快照内容\n')
  assert.equal(await readFile(join(paths.sourceRoot, 'inventory.json'), 'utf8'), 'user-owned inventory\n')
  assert.equal(existsSync(join(paths.sourceRoot, 'new.txt')), false)
  assert.equal(existsSync(restored.rescuePath), true)
})

test('restore is idempotent when the current source already matches the snapshot', async t => {
  const paths = fixture(t)
  await mkdir(paths.sourceRoot, { recursive: true })
  await writeFile(join(paths.sourceRoot, 'state.json'), '{"ready":true}\n')
  const store = new SnapshotStore(paths)
  await store.create({ snapshotId: 'already-restored' })

  const restored = await store.restore({ snapshotId: 'already-restored' })

  assert.equal(restored.alreadyRestored, true)
  assert.equal(restored.rescuePath, undefined)
  assert.equal(readdirSync(paths.root).some(name => name.startsWith('.snapshot-restore-')), false)
  assert.equal(await readFile(join(paths.sourceRoot, 'state.json'), 'utf8'), '{"ready":true}\n')
})

test('copy failure never publishes a snapshot record', async t => {
  const paths = fixture(t)
  await seed(paths.sourceRoot)
  let copies = 0
  const store = new SnapshotStore({
    ...paths,
    copyFileImpl: async (...args) => {
      copies += 1
      if (copies === 2) throw new Error('injected copy failure')
      return copyFile(...args)
    },
  })

  await assert.rejects(store.create({ snapshotId: 'copy-failure' }), /injected copy failure/)
  assert.equal(existsSync(join(paths.snapshotRoot, 'copy-failure')), false)
  assert.equal(readdirSync(paths.snapshotRoot).some(name => name.startsWith('.staging-')), false)
  assert.deepEqual(await store.list(), [])
})

test('snapshot creation reports cleanup failure without masking the copy error', async t => {
  const paths = fixture(t)
  await seed(paths.sourceRoot)
  let cleanupOptions
  const store = new SnapshotStore({
    ...paths,
    copyFileImpl: async () => { throw new Error('injected snapshot copy failure') },
    rmImpl: async (_path, options) => {
      cleanupOptions = options
      throw new Error('injected snapshot cleanup failure')
    },
  })

  await assert.rejects(
    store.create({ snapshotId: 'cleanup-failure' }),
    error => /injected snapshot copy failure/u.test(error.message)
      && /injected snapshot cleanup failure/u.test(error.cleanupError?.message ?? ''),
  )
  assert.deepEqual(cleanupOptions, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

test('tampering is detected by list, size report, and restore before source mutation', async t => {
  const paths = fixture(t)
  await seed(paths.sourceRoot)
  const store = new SnapshotStore(paths)
  await store.create({ snapshotId: 'tamper-test' })
  const sourceBefore = await readFile(join(paths.sourceRoot, 'binary.bin'))
  await writeFile(join(paths.snapshotRoot, 'tamper-test', 'payload', 'binary.bin'), 'tampered')

  await assert.rejects(store.list(), SnapshotIntegrityError)
  await assert.rejects(store.sizeReport({ snapshotId: 'tamper-test' }), SnapshotIntegrityError)
  await assert.rejects(store.restore({ snapshotId: 'tamper-test' }), SnapshotIntegrityError)
  assert.deepEqual(await readFile(join(paths.sourceRoot, 'binary.bin')), sourceBefore)
})

test('restore failure after moving the original rolls it back and preserves snapshot artifacts', async t => {
  const paths = fixture(t)
  await seed(paths.sourceRoot)
  const normal = new SnapshotStore(paths)
  await normal.create({ snapshotId: 'rollback-test' })
  await writeFile(join(paths.sourceRoot, 'binary.bin'), 'current-original')
  const store = new SnapshotStore({
    ...paths,
    faults: { 'restore:before-publish': () => { throw new Error('injected publish failure') } },
  })

  await assert.rejects(store.restore({ snapshotId: 'rollback-test' }), /injected publish failure/)
  assert.equal(await readFile(join(paths.sourceRoot, 'binary.bin'), 'utf8'), 'current-original')
  assert.equal(existsSync(join(paths.snapshotRoot, 'rollback-test', 'inventory.json')), true)
})

test('restore failure before the swap removes staging data without touching the source', async t => {
  const paths = fixture(t)
  await seed(paths.sourceRoot)
  const normal = new SnapshotStore(paths)
  await normal.create({ snapshotId: 'pre-swap-cleanup' })
  await writeFile(join(paths.sourceRoot, 'binary.bin'), 'current-original')
  const store = new SnapshotStore({
    ...paths,
    faults: { 'restore:before-swap': () => { throw new Error('injected pre-swap failure') } },
  })

  await assert.rejects(store.restore({ snapshotId: 'pre-swap-cleanup' }), /injected pre-swap failure/u)
  assert.equal(await readFile(join(paths.sourceRoot, 'binary.bin'), 'utf8'), 'current-original')
  assert.equal(readdirSync(paths.root).some(name => name.startsWith('.snapshot-restore-staging-')), false)
  assert.equal(readdirSync(paths.root).some(name => name.startsWith('.snapshot-restore-backup-')), false)
  assert.equal(readdirSync(paths.root).some(name => name.startsWith('.snapshot-restore-failed-')), false)
})

test('pre-aborted create and unsafe source links fail closed', async t => {
  const paths = fixture(t)
  await seed(paths.sourceRoot)
  const action = new AbortController()
  action.abort(new Error('cancel snapshot'))
  await assert.rejects(new SnapshotStore(paths).create({ snapshotId: 'cancelled', signal: action.signal }), /cancel snapshot/)
  assert.equal(existsSync(join(paths.snapshotRoot, 'cancelled')), false)

  const linkPath = join(paths.sourceRoot, 'unsafe-link')
  try {
    const fs = await import('node:fs/promises')
    await fs.symlink(join(paths.sourceRoot, 'binary.bin'), linkPath, 'file')
  } catch {
    return
  }
  await assert.rejects(new SnapshotStore(paths).create({ snapshotId: 'link-test' }), /symlink|reparse|junction/i)
  assert.equal(readdirSync(paths.snapshotRoot).includes('link-test'), false)
})

test('release snapshot excludes derived profile dependencies without following links', async t => {
  const paths = fixture(t)
  await seed(paths.sourceRoot)
  await mkdir(join(paths.sourceRoot, 'profiles', 'node_modules'), { recursive: true })
  const linkPath = join(paths.sourceRoot, 'profiles', 'node_modules', 'sdk')
  await writeFile(linkPath, 'derived dependency link\n')
  const markingLstat = async path => {
    const stats = await lstat(path)
    if (path === linkPath) return { ...stats, isSymbolicLink: () => true }
    return stats
  }

  const store = new SnapshotStore({ ...paths, lstatImpl: markingLstat, excludedRelativePaths: ['profiles/node_modules'] })
  const created = await store.create({ snapshotId: 'derived-links-excluded' })
  assert.equal(created.count, 4)
  assert.equal(existsSync(join(paths.snapshotRoot, 'derived-links-excluded', 'payload', 'profiles', 'node_modules')), false)
  const listed = await store.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].snapshotId, created.snapshotId)
  await assert.rejects(new SnapshotStore({ ...paths, lstatImpl: markingLstat }).create({ snapshotId: 'derived-links-rejected' }), /symlink|reparse|junction/i)
})

test('operation-level undefined exclusions preserve constructor exclusions', async t => {
  const paths = fixture(t)
  await seed(paths.sourceRoot)
  await mkdir(join(paths.sourceRoot, 'Cache'), { recursive: true })
  await writeFile(join(paths.sourceRoot, 'Cache', 'derived.bin'), 'derived cache\n')
  const store = new SnapshotStore({ ...paths, excludedRelativePaths: ['Cache'] })
  await store.create({ snapshotId: 'base-exclusions', excludedRelativePaths: undefined })
  assert.equal(existsSync(join(paths.snapshotRoot, 'base-exclusions', 'payload', 'Cache')), false)
})

test('restore preserves excluded derived dependency trees', async t => {
  const paths = fixture(t)
  await seed(paths.sourceRoot)
  const derived = join(paths.sourceRoot, 'profiles', 'node_modules', 'desktop-bridge.txt')
  await mkdir(join(paths.sourceRoot, 'profiles', 'node_modules'), { recursive: true })
  await writeFile(derived, 'derived dependency\n')
  const store = new SnapshotStore({ ...paths, excludedRelativePaths: ['profiles/node_modules'] })
  await store.create({ snapshotId: 'derived-restore' })
  await writeFile(join(paths.sourceRoot, 'empty.txt'), 'changed\n')
  await store.restore({ snapshotId: 'derived-restore' })
  assert.equal(await readFile(derived, 'utf8'), 'derived dependency\n')
  assert.equal(await readFile(join(paths.sourceRoot, 'empty.txt'), 'utf8'), '')
})
