import assert from 'node:assert/strict'
import { copyFile as nodeCopyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseMigrationArguments } from '../src/migration/cli.js'
import { normalizeLegacyHostEvidence } from '../src/migration/legacy-host.js'
import { createMigrationReport } from '../src/migration/report.js'
import { prepareSideBySideMigration } from '../src/migration/side-by-side.js'
import {
  assertNoReparsePoint,
  assertNoSourceDestinationOverlap,
  assertWebProfileInsideDshHome,
} from '../src/migration/path-safety.js'
import { snapshotTree } from '../src/migration/tree.js'

const fixtureSourceRoot = process.platform === 'win32' ? 'C:\\source' : '/source'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-migration-test-'))
  const dshHome = join(root, 'source', '.dsh')
  const webProfile = join(dshHome, 'profiles', 'web')
  const outputRoot = join(root, 'side-by-side')
  await mkdir(join(dshHome, 'sessions'), { recursive: true })
  await mkdir(join(webProfile, 'sessions'), { recursive: true })
  await mkdir(join(webProfile, 'workspaces', 'demo'), { recursive: true })
  await writeFile(join(dshHome, 'settings.json'), JSON.stringify({ apiKey: 'sk-test-secret-value', theme: 'dark' }), 'utf8')
  await writeFile(join(dshHome, 'sessions', 'root-session.json'), JSON.stringify({ token: 'session-secret-value' }), 'utf8')
  await writeFile(join(webProfile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }), 'utf8')
  await writeFile(join(webProfile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
  await writeFile(join(webProfile, 'sessions', 'one.json'), JSON.stringify({ message: 'not included in report' }), 'utf8')
  await writeFile(join(webProfile, 'workspaces', 'demo', 'README.md'), 'workspace contents', 'utf8')
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, dshHome, webProfile, outputRoot }
}

async function reportText(path) {
  return readFile(path, 'utf8')
}

test('execute creates a distinct physical profile and leaves source/web byte-identical', async t => {
  const paths = await fixture(t)
  const sourceBefore = await snapshotTree(paths.dshHome)
  const webBefore = await snapshotTree(paths.webProfile)
  const result = await prepareSideBySideMigration({
    mode: 'execute',
    ...paths,
    id: '001',
    legacyProcessEntries: [],
    legacyPortEntries: [],
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.metadata.productId, 'io.github.dshdesktop.ricardo-stable')
  assert.equal(result.metadata.dataId, 'ricardo-stable-001')
  assert.equal(result.metadata.profileName, 'ricardo-stable-001')
  assert.equal(result.report.migration.cutover.switched, false)
  assert.equal(result.report.migration.source.unchanged, true)
  assert.equal(result.report.migration.source.webProfileUnchanged, true)
  assert.equal((await snapshotTree(paths.dshHome)).rootSha256, sourceBefore.rootSha256)
  assert.equal((await snapshotTree(paths.webProfile)).rootSha256, webBefore.rootSha256)
  assert.equal((await snapshotTree(result.metadata.physicalProfilePath)).rootSha256, webBefore.rootSha256)
  assert.equal((await snapshotTree(join(result.metadata.dshHome, 'profiles', 'web'))).rootSha256, webBefore.rootSha256)
  assert.match(await readFile(result.reportPath, 'utf8'), /"secretValuesIncluded": false/)
})

test('dry-run is explicit, writes only a report, and never creates a candidate profile', async t => {
  const paths = await fixture(t)
  const result = await prepareSideBySideMigration({
    mode: 'dry-run',
    ...paths,
    id: 'dry-001',
    legacyProcessEntries: [],
    legacyPortEntries: [],
  })
  assert.equal(result.status, 'planned')
  assert.equal(result.report.migration.destination.profileName, 'ricardo-stable-dry-001')
  assert.equal(result.report.migration.copiedDshHome.available, false)
  assert.equal(result.report.migration.importedProfile.available, false)
  assert.equal(result.report.migration.cutover.switched, false)
  assert.equal(await readFile(result.reportPath, 'utf8') !== '', true)
  assert.equal(await readFile(join(paths.outputRoot, 'migration-report.json'), 'utf8') !== '', true)
})

test('migration excludes only the generated profiles/node_modules link farm from DSH_HOME evidence', async t => {
  const paths = await fixture(t)
  await mkdir(join(paths.dshHome, 'profiles', 'node_modules', 'generated-package'), { recursive: true })
  await writeFile(join(paths.dshHome, 'profiles', 'node_modules', 'generated-package', 'index.js'), 'generated dependency', 'utf8')
  const result = await prepareSideBySideMigration({
    mode: 'execute',
    ...paths,
    id: 'derived-exclusion',
    legacyProcessEntries: [],
    legacyPortEntries: [],
  })

  assert.equal(result.status, 'ready')
  assert.deepEqual(result.report.migration.source.before.excludedDerivedPaths, ['profiles/node_modules'])
  assert.equal(result.report.migration.source.before.files.some(file => file.relativePath.includes('profiles/node_modules')), false)
  await assert.rejects(readFile(join(result.metadata.dshHome, 'profiles', 'node_modules', 'generated-package', 'index.js')), error => error.code === 'ENOENT')
  assert.equal((await readFile(join(result.metadata.physicalProfilePath, 'package.json'), 'utf8')).includes('dsh-profile-web'), true)
})

test('source/destination overlap and profile path escapes fail closed before output is touched', async t => {
  const paths = await fixture(t)
  await assert.rejects(
    assertNoSourceDestinationOverlap({ sourceRoot: paths.dshHome, destinationRoot: paths.dshHome }),
    error => error.code === 'MIGRATION_SOURCE_DESTINATION_OVERLAP',
  )
  await assert.rejects(
    assertNoSourceDestinationOverlap({ sourceRoot: paths.dshHome, destinationRoot: paths.root }),
    error => error.code === 'MIGRATION_SOURCE_DESTINATION_OVERLAP',
  )
  await assert.rejects(
    prepareSideBySideMigration({ mode: 'dry-run', ...paths, webProfile: join(paths.root, 'outside', 'web'), id: 'escape' }),
    error => error.code === 'MIGRATION_PATH_UNREADABLE' || error.code === 'MIGRATION_PROFILE_OUTSIDE_HOME',
  )
  assert.equal(await readFile(join(paths.dshHome, 'settings.json'), 'utf8').then(value => value.includes('sk-test-secret-value')), true)
})

test('symbolic links and junction-like reparse entries are rejected without following them', async t => {
  const paths = await fixture(t)
  const outside = join(paths.root, 'outside.txt')
  await writeFile(outside, 'outside', 'utf8')
  try {
    await symlink(outside, join(paths.dshHome, 'escape.txt'), 'file')
  } catch (error) {
    if (['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`symbolic link creation is unavailable: ${error.code}`)
      return
    }
    throw error
  }
  await assert.rejects(
    prepareSideBySideMigration({ mode: 'dry-run', ...paths, id: 'symlink' }),
    error => error.code === 'MIGRATION_REPARSE_POINT',
  )
  assert.equal(await readFile(outside, 'utf8'), 'outside')
})

test('reparse-point guard rejects a symbolic-link stat without touching the target', () => {
  assert.throws(
    () => assertNoReparsePoint('C:\\source\\link', { isSymbolicLink: () => true }),
    error => error.code === 'MIGRATION_REPARSE_POINT',
  )
})

test('volatile source files fail closed after bounded read-hash-copy-read-hash retries', async t => {
  const paths = await fixture(t)
  const volatile = join(paths.dshHome, 'volatile.txt')
  await writeFile(volatile, 'version-0', 'utf8')
  let mutation = 0
  const result = await prepareSideBySideMigration({
    mode: 'execute',
    ...paths,
    id: 'drift',
    retryLimit: 2,
    copyFileImpl: async (source, target) => {
      await nodeCopyFile(source, target)
      if (source === volatile) {
        mutation += 1
        await writeFile(volatile, `version-${mutation}`, 'utf8')
      }
    },
  })
  assert.equal(result.status, 'failed')
  assert.match(result.report.migration.failure.code, /MIGRATION_SOURCE_SNAPSHOT_UNSTABLE|MIGRATION_SOURCE_CHANGED/)
  assert.equal(result.report.migration.cutover.switched, false)
  assert.equal(mutation >= 2, true)
})

test('copy failures produce a failed report and do not claim readiness', async t => {
  const paths = await fixture(t)
  const result = await prepareSideBySideMigration({
    mode: 'execute',
    ...paths,
    id: 'copy-failure',
    copyFileImpl: async () => { throw Object.assign(new Error('injected copy failure'), { code: 'INJECTED_COPY_FAILURE' }) },
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.report.status, 'failed')
  assert.equal(result.report.migration.failure.code, 'INJECTED_COPY_FAILURE')
  assert.equal(result.report.migration.cutover.switched, false)
  assert.equal(result.report.migration.source.unchanged, true)
})

test('existing legacy Host evidence is read-only and requests controlled ownership', async t => {
  const paths = await fixture(t)
  const result = await prepareSideBySideMigration({
    mode: 'dry-run',
    ...paths,
    id: 'host',
    legacyProcessEntries: [{
      pid: 4242,
      name: 'node.exe',
      commandLine: `node dsh-host --dsh-home "${paths.dshHome}" --port 3088`,
      isHost: true,
    }],
    legacyPortEntries: [{ owningProcess: 4242, localAddress: '127.0.0.1', localPort: 3088 }],
  })
  const host = result.report.migration.legacyHost
  assert.equal(host.takeOwnershipRequired, true)
  assert.deepEqual(host.hosts, [{
    pid: 4242,
    processName: 'node.exe',
    ports: [3088],
    evidence: [
      'process command line or explicit DSH_HOME field references the source DSH_HOME',
      'a listening port is associated with the process PID',
    ],
  }])
  assert.equal(result.report.migration.cutover.switched, false)
  assert.equal(result.report.migration.cutover.ownershipTransferred, false)
  assert.doesNotMatch(JSON.stringify(host), /dsh-host|--dsh-home|apiKey|token/i)
})

test('migration report contains hashes and presence evidence but never secret values', async t => {
  const paths = await fixture(t)
  const result = await prepareSideBySideMigration({
    mode: 'execute',
    ...paths,
    id: 'redaction',
    legacyProcessEntries: [],
    legacyPortEntries: [],
  })
  const text = await reportText(result.reportPath)
  assert.match(text, /"sha256": "[0-9a-f]{64}"/)
  assert.match(text, /"sessions": \{/)
  assert.match(text, /"settings": \{/)
  assert.match(text, /"workspaces": \{/)
  assert.doesNotMatch(text, /sk-test-secret-value|session-secret-value/)
  assert.match(text, /"secretValuesIncluded": false/)
  assert.match(text, /未停止任何 legacy Host 进程/)
})

test('CLI rejects implicit mode and non-absolute paths', () => {
  assert.throws(() => parseMigrationArguments([
    '--dsh-home', fixtureSourceRoot, '--web-profile', join(fixtureSourceRoot, 'profiles', 'web'), '--output-root', join(fixtureSourceRoot, '..', 'out'),
  ]), /explicitly dry-run or execute/)
  assert.throws(() => parseMigrationArguments([
    '--mode', 'execute', '--dsh-home', join('.', 'source'), '--web-profile', join(fixtureSourceRoot, 'profiles', 'web'), '--output-root', join(fixtureSourceRoot, '..', 'out'),
  ]), /absolute path/)
  const parsed = parseMigrationArguments([
    '--mode=execute', `--dsh-home=${fixtureSourceRoot}`, `--web-profile=${join(fixtureSourceRoot, 'profiles', 'web')}`, `--output-root=${join(fixtureSourceRoot, '..', 'out')}`, '--id=abc',
  ])
  assert.deepEqual(parsed, {
    mode: 'execute',
    dshHome: fixtureSourceRoot,
    webProfile: join(fixtureSourceRoot, 'profiles', 'web'),
    outputRoot: join(fixtureSourceRoot, '..', 'out'),
    id: 'abc',
    retryLimit: 3,
  })
})

test('host normalizer only emits PID/port evidence, never command-line values', () => {
  const defaultDshHome = join(homedir(), '.dsh')
  const result = normalizeLegacyHostEvidence({
    dshHome: defaultDshHome,
    processEntries: [{ pid: 7, name: 'dsh.exe', commandLine: `dsh --dsh-home ${defaultDshHome} --api-key SECRET`, isHost: true }],
    portEntries: [{ pid: 7, localPort: 3088 }],
  })
  assert.equal(result.takeOwnershipRequired, true)
  assert.deepEqual(result.hosts[0].ports, [3088])
  assert.doesNotMatch(JSON.stringify(result), /SECRET|api-key|C:\\Users\\1\\.dsh.*api/i)
})

test('host normalizer detects a listening DSH web process using the implicit default home', () => {
  const result = normalizeLegacyHostEvidence({
    dshHome: join(homedir(), '.dsh'),
    processEntries: [{
      pid: 94368,
      name: 'node.exe',
      commandLine: 'node C:\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --port 3088 --no-open',
    }],
    portEntries: [{ owningProcess: 94368, localPort: 3088 }],
  })
  assert.equal(result.takeOwnershipRequired, true)
  assert.deepEqual(result.hosts[0].ports, [3088])
  assert.match(result.hosts[0].evidence[0], /implicit default DSH_HOME/)
})

test('host normalizer accepts the PascalCase fields returned by the Windows probe', () => {
  const result = normalizeLegacyHostEvidence({
    dshHome: join(homedir(), '.dsh'),
    processEntries: [{
      ProcessId: 94368,
      Name: 'node.exe',
      CommandLine: 'node C:\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --port 3088 --no-open',
    }, {
      ProcessId: 12345,
      Name: 'pwsh.exe',
      CommandLine: `pwsh -Command inspect ${join(homedir(), '.dsh')}`,
    }],
    portEntries: [{ OwningProcess: 94368, LocalPort: 3088 }],
  })
  assert.equal(result.takeOwnershipRequired, true)
  assert.equal(result.hosts.length, 1)
  assert.equal(result.hosts[0].pid, 94368)
  assert.deepEqual(result.hosts[0].ports, [3088])
})

test('report builder keeps cutover explicitly unperformed even when host evidence is present', () => {
  const report = createMigrationReport({
    mode: 'dry-run',
    status: 'planned',
    id: 'report',
    productId: 'io.github.dshdesktop.ricardo-stable',
    dataId: 'ricardo-stable-report',
    profileName: 'ricardo-stable-report',
    source: { dshHome: 'C:\\source', webProfile: 'C:\\source\\profiles\\web' },
    destination: { sideBySideRoot: 'C:\\out', dshHome: 'C:\\out\\data\\ricardo-stable-report\\dsh-home', physicalProfilePath: 'C:\\out\\data\\ricardo-stable-report\\dsh-home\\profiles\\ricardo-stable-report' },
    legacyHost: { takeOwnershipRequired: true, hosts: [{ pid: 1, processName: 'dsh.exe', ports: [3088], evidence: ['PID/port'] }] },
  })
  assert.equal(report.migration.legacyHost.takeOwnershipRequired, true)
  assert.equal(report.migration.cutover.switched, false)
  assert.equal(report.migration.cutover.ownershipTransferred, false)
  assert.equal(report.redaction.secretValuesIncluded, false)
})
