import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  MANAGED_DATA_EXCLUDED_ROOTS,
  MANAGED_DATA_JOURNAL_FILE,
  MANAGED_DATA_SCHEMA_VERSION,
  MANAGED_DATA_STAGING_PREFIX,
  migrateManagedDataHome,
  projectManagedProfile,
  readManagedDataHome,
} from '../src/storage/managed-data-home.js'

async function pathExists(pathValue) {
  try {
    await lstat(pathValue)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function readText(pathValue) {
  return readFile(pathValue, 'utf8')
}

async function makeCandidate(root, releaseId, { physicalName = 'stable-profile', marker = releaseId } = {}) {
  const candidateHome = join(root, 'candidates', releaseId)
  await mkdir(join(candidateHome, 'settings'), { recursive: true })
  await mkdir(join(candidateHome, '.credentials'), { recursive: true })
  await mkdir(join(candidateHome, 'sessions', 'nested'), { recursive: true })
  await mkdir(join(candidateHome, 'storages'), { recursive: true })
  await mkdir(join(candidateHome, 'attachments'), { recursive: true })
  await mkdir(join(candidateHome, 'plugins', 'unknown-cache'), { recursive: true })
  await writeFile(join(candidateHome, 'settings', 'state.json'), `settings-${marker}\n`)
  await writeFile(join(candidateHome, '.credentials', 'placeholder.bin'), `credential-fixture-${marker}\n`)
  await writeFile(join(candidateHome, 'sessions', 'nested', 'session.json'), `session-${marker}\n`)
  await writeFile(join(candidateHome, 'storages', 'store.db'), `storage-${marker}\n`)
  await writeFile(join(candidateHome, 'attachments', 'kept.txt'), `attachment-${marker}\n`)
  await writeFile(join(candidateHome, 'plugins', 'unknown-cache', 'state.json'), `plugin-state-${marker}\n`)

  await writeFile(join(candidateHome, 'manifest.json'), `excluded-manifest-${marker}\n`)
  await writeFile(join(candidateHome, 'profile'), `excluded-profile-${marker}\n`)
  await mkdir(join(candidateHome, 'profiles', physicalName), { recursive: true })
  await mkdir(join(candidateHome, 'profiles', 'node_modules', 'package-a'), { recursive: true })
  await writeFile(join(candidateHome, 'profiles', physicalName, 'profile-code.js'), `code-${marker}\n`)
  await writeFile(join(candidateHome, 'profiles', 'node_modules', 'package-a', 'index.js'), `module-${marker}\n`)
  await mkdir(join(candidateHome, 'runtime', 'versions'), { recursive: true })
  await writeFile(join(candidateHome, 'runtime', 'versions', 'runtime.txt'), `excluded-runtime-${marker}\n`)
  await mkdir(join(candidateHome, 'artifacts'), { recursive: true })
  await writeFile(join(candidateHome, 'artifacts', 'artifact.txt'), `excluded-artifact-${marker}\n`)
  return { candidateHome, physicalName }
}

async function makeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-data-home-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'candidates'), { recursive: true })
  return { root }
}

async function stopped() {
  return true
}

async function writeJournal(root, value) {
  await writeFile(join(root, MANAGED_DATA_JOURNAL_FILE), `${JSON.stringify(value, undefined, 2)}\n`)
}

function journalFor({ releaseId, manifest, phase, staging }) {
  const timestamp = new Date().toISOString()
  const sourceManifest = {
    ...manifest,
    directories: manifest.directories.filter(directory => directory !== 'profiles'),
  }
  return {
    schemaVersion: MANAGED_DATA_SCHEMA_VERSION,
    kind: 'managed-data-migration',
    phase,
    sourceReleaseId: releaseId,
    sourceHome: `candidates/${releaseId}`,
    staging,
    sourceManifest,
    manifest,
    startedAt: timestamp,
    updatedAt: timestamp,
  }
}

test('migrates complete candidate user state, excludes release material, and keeps the source', async t => {
  const { root } = await makeFixture(t)
  const { candidateHome } = await makeCandidate(root, 'release-one')
  const fakeDefaultAppAsar = Buffer.from([0, 1, 2, 65, 83, 65, 82, 255, 254])
  await mkdir(join(candidateHome, 'electron', 'resources'), { recursive: true })
  await writeFile(join(candidateHome, 'electron', 'resources', 'default_app.asar'), fakeDefaultAppAsar)

  const result = await migrateManagedDataHome({
    runtimeRoot: root,
    sourceHome: candidateHome,
    sourceReleaseId: 'release-one',
    assertStopped: stopped,
  })

  assert.equal(result.dataHome, join(root, 'user-data'))
  assert.equal(result.sourceReleaseId, 'release-one')
  assert.equal(readManagedDataHome(root).dataHome, join(root, 'user-data'))
  assert.equal(readManagedDataHome(root).sourceReleaseId, 'release-one')
  for (const relativePath of [
    'settings/state.json',
    '.credentials/placeholder.bin',
    'sessions/nested/session.json',
    'storages/store.db',
    'attachments/kept.txt',
    'plugins/unknown-cache/state.json',
  ]) {
    assert.equal((await readText(join(root, 'user-data', relativePath))).includes('release-one'), true, relativePath)
  }
  assert.deepEqual(await readFile(join(root, 'user-data', 'electron', 'resources', 'default_app.asar')), fakeDefaultAppAsar)
  for (const excluded of MANAGED_DATA_EXCLUDED_ROOTS) {
    if (excluded === 'profiles') {
      assert.equal((await lstat(join(root, 'user-data', excluded))).isDirectory(), true)
    } else {
      assert.equal(await pathExists(join(root, 'user-data', excluded)), false, excluded)
    }
  }
  assert.equal(await pathExists(join(root, 'user-data', 'profiles', 'stable-profile', 'profile-code.js')), false)
  assert.equal(await readText(join(candidateHome, 'settings', 'state.json')), 'settings-release-one\n')
  assert.equal(await pathExists(join(root, MANAGED_DATA_JOURNAL_FILE)), false)

  const pointer = JSON.parse(await readText(join(root, 'data-home.json')))
  assert.equal(pointer.dataHome, 'user-data')
  assert.equal(pointer.status, 'ready')
  assert.equal(pointer.sourceReleaseId, 'release-one')
  assert.equal(pointer.manifest.files.some(file => file.path === 'settings/state.json'), true)
  assert.equal(JSON.stringify(pointer).includes('settings-release-one'), false)
})

test('keeps an authoritative ready data home and does not let a later candidate overwrite it', async t => {
  const { root } = await makeFixture(t)
  const first = await makeCandidate(root, 'release-one', { marker: 'old' })
  const second = await makeCandidate(root, 'release-two', { marker: 'new' })

  await migrateManagedDataHome({ runtimeRoot: root, sourceHome: first.candidateHome, sourceReleaseId: 'release-one', assertStopped: stopped })
  await writeFile(join(root, 'user-data', 'later-session.json'), 'created-after-first-migration\n')
  const result = await migrateManagedDataHome({ runtimeRoot: root, sourceHome: second.candidateHome, sourceReleaseId: 'release-two', assertStopped: stopped })

  assert.equal(result.dataHome, join(root, 'user-data'))
  assert.equal(result.sourceReleaseId, 'release-one')
  assert.equal(await readText(join(root, 'user-data', 'settings', 'state.json')), 'settings-old\n')
  assert.equal(await readText(join(root, 'user-data', 'later-session.json')), 'created-after-first-migration\n')
  assert.equal(await readText(join(first.candidateHome, 'settings', 'state.json')), 'settings-old\n')
  assert.equal(await readText(join(second.candidateHome, 'settings', 'state.json')), 'settings-new\n')
  assert.equal(await pathExists(join(root, 'user-data-backups')), false)
  assert.equal(readManagedDataHome(root).sourceReleaseId, 'release-one')
})

test('projection switches only verified directory links, preserves new data, and is idempotent', async t => {
  const { root } = await makeFixture(t)
  const first = await makeCandidate(root, 'release-one', { physicalName: 'stable-profile', marker: 'first' })
  const second = await makeCandidate(root, 'release-two', { physicalName: 'stable-profile', marker: 'second' })
  await migrateManagedDataHome({ runtimeRoot: root, sourceHome: first.candidateHome, sourceReleaseId: 'release-one', assertStopped: stopped })
  const dataProfiles = join(root, 'user-data', 'profiles')
  await writeFile(join(root, 'user-data', 'new-session.json'), 'created-after-migration\n')

  const firstProjection = projectManagedProfile({ runtimeRoot: root, candidateHome: first.candidateHome, physicalName: 'stable-profile' })
  assert.equal(firstProjection.dataHome, join(root, 'user-data'))
  assert.equal(firstProjection.changed, true)
  assert.equal((await lstat(join(dataProfiles, 'stable-profile'))).isSymbolicLink(), true)
  assert.equal((await lstat(join(dataProfiles, 'node_modules'))).isSymbolicLink(), true)
  assert.equal((await lstat(join(root, 'user-data'))).isSymbolicLink(), false)
  assert.equal(await readText(join(root, 'user-data', 'new-session.json')), 'created-after-migration\n')

  const secondProjection = projectManagedProfile({ runtimeRoot: root, candidateHome: second.candidateHome, physicalName: 'stable-profile' })
  assert.equal(secondProjection.dataHome, join(root, 'user-data'))
  assert.equal(secondProjection.changed, true)
  assert.equal(await readText(join(dataProfiles, 'stable-profile', 'profile-code.js')), 'code-second\n')
  assert.equal(await readText(join(dataProfiles, 'node_modules', 'package-a', 'index.js')), 'module-second\n')
  assert.equal(await readText(join(root, 'user-data', 'new-session.json')), 'created-after-migration\n')
  const backupsAfterSwitch = await readdir(join(root, 'projection-backups'))
  assert.equal(backupsAfterSwitch.length, 2)

  const idempotent = projectManagedProfile({ runtimeRoot: root, candidateHome: second.candidateHome, physicalName: 'stable-profile' })
  assert.equal(idempotent.changed, false)
  assert.equal((await readdir(join(root, 'projection-backups'))).length, 2)
})

test('recovers rename-before-pointer publication from the journal', async t => {
  const { root } = await makeFixture(t)
  const candidate = await makeCandidate(root, 'release-recover')
  const first = await migrateManagedDataHome({ runtimeRoot: root, sourceHome: candidate.candidateHome, sourceReleaseId: 'release-recover', assertStopped: stopped })
  await unlink(join(root, 'data-home.json'))
  const staging = `${MANAGED_DATA_STAGING_PREFIX}${randomUUID()}`
  await writeJournal(root, journalFor({
    releaseId: 'release-recover',
    manifest: first.manifest,
    phase: 'renamed',
    staging,
  }))

  assert.throws(() => readManagedDataHome(root), error => error?.code === 'MANAGED_DATA_TRANSACTION_PENDING')
  const recovered = await migrateManagedDataHome({ runtimeRoot: root, sourceHome: candidate.candidateHome, sourceReleaseId: 'release-recover', assertStopped: stopped })
  assert.equal(recovered.dataHome, join(root, 'user-data'))
  assert.equal(recovered.sourceReleaseId, 'release-recover')
  assert.equal(await pathExists(join(root, MANAGED_DATA_JOURNAL_FILE)), false)
  assert.equal(readManagedDataHome(root).sourceReleaseId, 'release-recover')
})

test('accepts a matching ready pointer during the renamed-before-journal-clear window', async t => {
  const { root } = await makeFixture(t)
  const candidate = await makeCandidate(root, 'release-ready-window')
  const ready = await migrateManagedDataHome({
    runtimeRoot: root,
    sourceHome: candidate.candidateHome,
    sourceReleaseId: 'release-ready-window',
    assertStopped: stopped,
  })
  const staging = `${MANAGED_DATA_STAGING_PREFIX}${randomUUID()}`
  await writeJournal(root, journalFor({
    releaseId: 'release-ready-window',
    manifest: ready.manifest,
    phase: 'renamed',
    staging,
  }))

  const observed = readManagedDataHome(root)
  assert.equal(observed.dataHome, join(root, 'user-data'))
  assert.equal(observed.sourceReleaseId, 'release-ready-window')
  assert.equal(await pathExists(join(root, MANAGED_DATA_JOURNAL_FILE)), true)
})

test('recovers when user-data was renamed but the journal is still verified', async t => {
  const { root } = await makeFixture(t)
  const candidate = await makeCandidate(root, 'release-verified-rename')
  const ready = await migrateManagedDataHome({
    runtimeRoot: root,
    sourceHome: candidate.candidateHome,
    sourceReleaseId: 'release-verified-rename',
    assertStopped: stopped,
  })
  await unlink(join(root, 'data-home.json'))
  const staging = `${MANAGED_DATA_STAGING_PREFIX}${randomUUID()}`
  await writeJournal(root, journalFor({
    releaseId: 'release-verified-rename',
    manifest: ready.manifest,
    phase: 'verified',
    staging,
  }))

  const recovered = await migrateManagedDataHome({
    runtimeRoot: root,
    sourceHome: candidate.candidateHome,
    sourceReleaseId: 'release-verified-rename',
    assertStopped: stopped,
  })
  assert.equal(recovered.dataHome, join(root, 'user-data'))
  assert.equal(recovered.sourceReleaseId, 'release-verified-rename')
  assert.equal(await pathExists(join(root, MANAGED_DATA_JOURNAL_FILE)), false)
  assert.equal(await readText(join(root, 'user-data', 'settings', 'state.json')), 'settings-release-verified-rename\n')
})

test('rejects source changes recorded by a verified journal and keeps staging recoverable', async t => {
  const { root } = await makeFixture(t)
  const candidate = await makeCandidate(root, 'release-changing')
  const first = await migrateManagedDataHome({ runtimeRoot: root, sourceHome: candidate.candidateHome, sourceReleaseId: 'release-changing', assertStopped: stopped })
  await rm(join(root, 'user-data'), { recursive: true, force: true })
  await unlink(join(root, 'data-home.json'))
  const staging = `${MANAGED_DATA_STAGING_PREFIX}${randomUUID()}`
  await mkdir(join(root, staging), { recursive: true })
  for (const directory of first.manifest.directories) await mkdir(join(root, staging, ...directory.split('/')), { recursive: true })
  for (const file of first.manifest.files) {
    const destination = join(root, staging, ...file.path.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(candidate.candidateHome, ...file.path.split('/')), destination)
  }
  await writeFile(join(candidate.candidateHome, 'settings', 'state.json'), 'changed-after-journal\n')
  await writeJournal(root, journalFor({
    releaseId: 'release-changing',
    manifest: first.manifest,
    phase: 'verified',
    staging,
  }))

  await assert.rejects(
    migrateManagedDataHome({ runtimeRoot: root, sourceHome: candidate.candidateHome, sourceReleaseId: 'release-changing', assertStopped: stopped }),
    error => error?.code === 'MANAGED_DATA_SOURCE_CHANGED',
  )
  assert.equal(await pathExists(join(root, staging)), true)
  assert.equal(await pathExists(join(root, 'user-data')), false)
  assert.equal(await pathExists(join(root, MANAGED_DATA_JOURNAL_FILE)), true)
})

test('rejects data links without following them', async t => {
  const { root } = await makeFixture(t)
  const candidate = await makeCandidate(root, 'release-linked')
  const outside = join(root, 'outside-secret-fixture')
  await mkdir(outside)
  await writeFile(join(outside, 'outside.txt'), 'outside-fixture-content\n')
  await symlink(outside, join(candidate.candidateHome, 'settings', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')

  await assert.rejects(
    migrateManagedDataHome({ runtimeRoot: root, sourceHome: candidate.candidateHome, sourceReleaseId: 'release-linked', assertStopped: stopped }),
    error => error?.code === 'MANAGED_DATA_LINK_REJECTED',
  )
  assert.equal(await readText(join(outside, 'outside.txt')), 'outside-fixture-content\n')
  assert.equal(await pathExists(join(root, 'user-data')), false)
  assert.equal(await pathExists(join(root, MANAGED_DATA_JOURNAL_FILE)), false)
})

test('abort and stopped-state failures publish nothing and do not remove source data', async t => {
  const { root } = await makeFixture(t)
  const candidate = await makeCandidate(root, 'release-abort')
  const controller = new AbortController()
  controller.abort(new Error('cancelled by fixture'))
  let stoppedCalls = 0
  await assert.rejects(
    migrateManagedDataHome({
      runtimeRoot: root,
      sourceHome: candidate.candidateHome,
      sourceReleaseId: 'release-abort',
      assertStopped: async () => { stoppedCalls += 1; return true },
      signal: controller.signal,
    }),
    error => error?.code === 'ABORT_ERR',
  )
  assert.equal(stoppedCalls, 0)
  assert.equal(await pathExists(join(root, 'user-data')), false)
  assert.equal(await readText(join(candidate.candidateHome, 'settings', 'state.json')), 'settings-release-abort\n')

  await assert.rejects(
    migrateManagedDataHome({ runtimeRoot: root, sourceHome: candidate.candidateHome, sourceReleaseId: 'release-abort', assertStopped: () => false }),
    error => error?.code === 'MANAGED_DATA_NOT_STOPPED',
  )
})

test('never overwrites a foreign user-data directory', async t => {
  const { root } = await makeFixture(t)
  const candidate = await makeCandidate(root, 'release-foreign')
  await mkdir(join(root, 'user-data'))
  await writeFile(join(root, 'user-data', 'do-not-touch.txt'), 'foreign-data\n')

  await assert.rejects(
    migrateManagedDataHome({ runtimeRoot: root, sourceHome: candidate.candidateHome, sourceReleaseId: 'release-foreign', assertStopped: stopped }),
    error => error?.code === 'MANAGED_DATA_FOREIGN_DESTINATION',
  )
  assert.equal(await readText(join(root, 'user-data', 'do-not-touch.txt')), 'foreign-data\n')
  assert.equal(await pathExists(join(root, MANAGED_DATA_JOURNAL_FILE)), false)
})

test('rejects damaged pointers and ordinary projection directories', async t => {
  const { root } = await makeFixture(t)
  await writeFile(join(root, 'data-home.json'), JSON.stringify({
    schemaVersion: 1,
    status: 'ready',
    dataHome: '../outside',
    sourceReleaseId: 'release-damaged',
  }))
  assert.throws(() => readManagedDataHome(root), error => error?.code === 'MANAGED_DATA_PATH_INVALID')

  const clean = await makeFixture(t)
  const candidate = await makeCandidate(clean.root, 'release-projection')
  await migrateManagedDataHome({ runtimeRoot: clean.root, sourceHome: candidate.candidateHome, sourceReleaseId: 'release-projection', assertStopped: stopped })
  await mkdir(join(clean.root, 'user-data', 'profiles', 'stable-profile'))
  await writeFile(join(clean.root, 'user-data', 'profiles', 'stable-profile', 'foreign.txt'), 'foreign-projection\n')
  assert.throws(
    () => projectManagedProfile({ runtimeRoot: clean.root, candidateHome: candidate.candidateHome, physicalName: 'stable-profile' }),
    error => error?.code === 'MANAGED_DATA_PROJECTION_FOREIGN',
  )
  assert.equal(await readText(join(clean.root, 'user-data', 'profiles', 'stable-profile', 'foreign.txt')), 'foreign-projection\n')
  assert.equal(await pathExists(join(clean.root, 'user-data', 'profiles', 'node_modules')), false)
})

test('rejects a non-canonical sourceHome outside its release candidate slot', async t => {
  const { root } = await makeFixture(t)
  const candidate = await makeCandidate(root, 'release-canonical')
  const outside = await makeCandidate(root, 'release-other')
  await assert.rejects(
    migrateManagedDataHome({ runtimeRoot: root, sourceHome: outside.candidateHome, sourceReleaseId: 'release-canonical', assertStopped: stopped }),
    error => error?.code === 'MANAGED_DATA_SOURCE_INVALID',
  )
  assert.equal(await pathExists(join(root, 'user-data')), false)
  assert.equal(await readText(join(candidate.candidateHome, 'settings', 'state.json')), 'settings-release-canonical\n')
})
