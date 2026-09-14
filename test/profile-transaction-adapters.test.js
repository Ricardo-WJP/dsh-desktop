import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createDesktopPluginTransactionAdapters, renameWithTransientRetry } from '../src/profile/transaction-adapters.js'

test('candidate publish retries transient Windows rename denial without weakening atomicity', async () => {
  const attempts = []
  const delays = []
  await renameWithTransientRetry('stage', 'target', {
    attempts: 4,
    baseDelayMs: 10,
    renameImpl: async (source, target) => {
      attempts.push([source, target])
      if (attempts.length < 3) throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' })
    },
    delayImpl: async milliseconds => { delays.push(milliseconds) },
  })
  assert.equal(attempts.length, 3)
  assert.deepEqual(delays, [10, 20])
})

test('candidate publish never retries structural rename failures', async () => {
  let attempts = 0
  await assert.rejects(renameWithTransientRetry('stage', 'target', {
    renameImpl: async () => {
      attempts += 1
      throw Object.assign(new Error('target exists'), { code: 'EEXIST' })
    },
    delayImpl: async () => assert.fail('structural failures must not be delayed'),
  }), /target exists/)
  assert.equal(attempts, 1)
})

test('candidate clone preserves its primary failure and reports cleanup failure', async t => {
  const action = new AbortController()
  let cleanupOptions
  const { root, adapters } = await fixture(t, {
    removeImpl: async (_path, options) => {
      cleanupOptions = options
      throw new Error('injected clone cleanup failure')
    },
  })
  action.abort(new Error('injected clone cancellation'))

  await assert.rejects(
    adapters.cloneActiveProfile({
      candidateId: 'candidate-cancelled',
      candidatePath: join(root, 'candidate-cancelled'),
      signal: action.signal,
    }),
    error => /injected clone cancellation/u.test(error.message)
      && /injected clone cleanup failure/u.test(error.cleanupError?.message ?? ''),
  )
  assert.deepEqual(cleanupOptions, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-adapter-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  })
  const activeRoot = join(root, 'active-release')
  const profilePath = join(activeRoot, 'profile')
  const physicalProfilePath = join(activeRoot, 'profiles', 'active-profile')
  const entry = join(activeRoot, 'runtime', 'dsh.js')
  const releaseId = 'active-release'
  await mkdir(profilePath, { recursive: true })
  await mkdir(physicalProfilePath, { recursive: true })
  await mkdir(dirname(entry), { recursive: true })
  await mkdir(join(activeRoot, 'profiles', 'node_modules', 'generated-host-dependency'), { recursive: true })
  await mkdir(join(physicalProfilePath, 'node_modules', '.pnpm'), { recursive: true })
  for (const directory of [profilePath, physicalProfilePath]) {
    await writeFile(join(directory, 'package.json'), '{"name":"active-profile","dependencies":{"dshmarket":"dshmarket@1.26.0","github-plugin":"github:owner/repo#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}\n')
  }
  await writeFile(entry, 'export {}\n')
  await writeFile(join(activeRoot, 'profiles', 'node_modules', 'generated-host-dependency', 'index.js'), 'generated\n')
  await writeFile(join(physicalProfilePath, 'node_modules', '.modules.yaml'), `virtualStoreDir: ${join(physicalProfilePath, 'node_modules', '.pnpm')}\n`)
  await writeFile(join(physicalProfilePath, 'node_modules', '.pnpm', 'parent-only.txt'), 'parent candidate dependency\n')
  await writeFile(join(activeRoot, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    releaseId,
    releaseType: 'managed',
    channel: 'stable',
    desktopVersion: '0.1.34',
    dsh: { version: '0.1.1-rc.2', source: 'npm', integrity: `sha512-${'a'.repeat(24)}` },
    profile: {
      logicalName: 'active-profile',
      physicalName: 'active-profile',
      manifestSha256: 'b'.repeat(64),
      lockSha256: 'c'.repeat(64),
      patchSha256: 'd'.repeat(64),
    },
    bundles: [],
    clientArtifacts: [],
    compatibility: { suiteVersion: 'compat-1', reportSha256: 'e'.repeat(64), passed: true },
    createdAt: '2026-08-24T00:00:00.000Z',
  }, undefined, 2)}\n`)
  const recipe = { mode: 'stable', releaseId, profileHome: activeRoot, profilePath, entry }
  const adapters = createDesktopPluginTransactionAdapters({
    candidateRoot: root,
    resolveActiveRelease: async () => ({ pointer: { releaseId }, recipe }),
    pnpmEntry: 'pnpm.cjs',
    ...overrides,
  })
  return { root, activeRoot, profilePath, physicalProfilePath, entry, adapters }
}

test('plugin candidate clones preserve credential refs and records without exposing or replacing them', async t => {
  const f = await fixture(t)
  const document = 'version: 1\nrefs:\n  OPENCODE_GO_API_KEY: fixture-only-key\nrecords:\n  test/session:\n    type: json\n    value: {}\n'
  await writeFile(join(f.activeRoot, '.credentials.yaml'), document)
  const target = join(f.root, 'credential-clone')
  await f.adapters.cloneActiveProfile({ candidateId: 'credential-clone', candidatePath: target })
  assert.equal(await readFile(join(target, '.credentials.yaml'), 'utf8'), document)
  assert.equal(await readFile(join(f.activeRoot, '.credentials.yaml'), 'utf8'), document)
})

test('candidate clone rebases release identity and profile writes never modify the active release', async t => {
  const { root, profilePath, entry, adapters } = await fixture(t)
  const before = await readFile(join(profilePath, 'package.json'), 'utf8')
  const clone = await adapters.cloneActiveProfile({
    candidateId: 'candidate-one',
    candidatePath: join(root, 'candidate-one'),
  })

  const migratedLogical = JSON.parse(await readFile(join(clone.candidatePath, 'profile', 'package.json'), 'utf8'))
  const migratedPhysical = JSON.parse(await readFile(join(clone.candidatePath, 'profiles', 'active-profile', 'package.json'), 'utf8'))
  assert.equal(migratedLogical.dependencies.dshmarket, '1.26.0')
  assert.equal(migratedPhysical.dependencies.dshmarket, '1.26.0')
  assert.equal(migratedLogical.dependencies['github-plugin'], 'github:owner/repo#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')

  await adapters.writeCandidateProfile({
    candidatePath: clone.candidatePath,
    profile: { name: 'active-profile', dependencies: { '@example/plugin': '1.2.3' } },
  })

  assert.equal(await readFile(join(profilePath, 'package.json'), 'utf8'), before)
  await writeFile(join(clone.candidatePath, 'runtime', 'dsh.js'), 'candidate only\n')
  assert.equal(await readFile(entry, 'utf8'), 'export {}\n')
  assert.equal((await adapters.readCandidateProfile(clone)).dependencies['@example/plugin'], '1.2.3')
  assert.equal(clone.candidatePath, join(root, 'candidate-one'))
  assert.equal(clone.candidateId, 'candidate-one')
  assert.equal(clone.parentReleaseId, 'active-release')
  assert.equal(JSON.parse(await readFile(join(root, 'candidate-one', 'manifest.json'), 'utf8')).releaseId, 'candidate-one')
  assert.equal(JSON.parse(await readFile(join(root, 'active-release', 'manifest.json'), 'utf8')).releaseId, 'active-release')
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.clone-')), [])
  await assert.rejects(
    readFile(join(root, 'candidate-one', 'profiles', 'node_modules', 'generated-host-dependency', 'index.js')),
    error => error?.code === 'ENOENT',
  )
  await assert.rejects(
    readFile(join(root, 'candidate-one', 'profiles', 'active-profile', 'node_modules', '.modules.yaml')),
    error => error?.code === 'ENOENT',
  )
  assert.match(await readFile(join(root, 'active-release', 'profiles', 'active-profile', 'node_modules', '.modules.yaml'), 'utf8'), /active-release/)
})

test('candidate clone preserves the complete Helper Electron runtime while protecting the active tree', async t => {
  const { root, activeRoot, adapters } = await fixture(t)
  const electronExecutable = join(activeRoot, 'electron', 'electron.exe')
  const electronResource = join(activeRoot, 'electron', 'resources', 'default_app.asar')
  await mkdir(dirname(electronExecutable), { recursive: true })
  await mkdir(dirname(electronResource), { recursive: true })
  await writeFile(electronExecutable, 'derived electron executable\n')
  await writeFile(electronResource, 'derived electron runtime\n')

  const clone = await adapters.cloneActiveProfile({
    candidateId: 'candidate-without-derived-electron',
    candidatePath: join(root, 'candidate-without-derived-electron'),
  })

  assert.equal(await readFile(join(clone.candidatePath, 'electron', 'electron.exe'), 'utf8'), 'derived electron executable\n')
  assert.equal(await readFile(join(clone.candidatePath, 'electron', 'resources', 'default_app.asar'), 'utf8'), 'derived electron runtime\n')
  assert.equal(await readFile(electronResource, 'utf8'), 'derived electron runtime\n')
})

test('candidate clone retries a transient Electron runtime file failure', async t => {
  let attempts = 0
  const setup = await fixture(t, {
    copyFileImpl: async (source, target, flags) => {
      if (source.endsWith('electron.exe') && attempts++ < 2) {
        throw Object.assign(new Error('runtime file is temporarily busy'), { code: 'ENOENT' })
      }
      return copyFile(source, target, flags)
    },
  })
  const electronResource = join(setup.activeRoot, 'electron', 'electron.exe')
  await mkdir(dirname(electronResource), { recursive: true })
  await writeFile(electronResource, 'retryable derived electron executable\n')

  const clone = await setup.adapters.cloneActiveProfile({
    candidateId: 'candidate-retries-electron',
    candidatePath: join(setup.root, 'candidate-retries-electron'),
  })

  assert.equal(attempts, 3)
  assert.equal(await readFile(join(clone.candidatePath, 'electron', 'electron.exe'), 'utf8'), 'retryable derived electron executable\n')
})

test('candidate clone omits the derived DSH module fallback farm', async t => {
  const setup = await fixture(t)
  const fallbackModule = join(setup.activeRoot, 'profiles', 'active-profile', '.dsh-module-fallback', 'node_modules', 'schemastery', 'index.js')
  await mkdir(dirname(fallbackModule), { recursive: true })
  await writeFile(fallbackModule, 'derived fallback module\n')

  const clone = await setup.adapters.cloneActiveProfile({
    candidateId: 'candidate-without-derived-fallback',
    candidatePath: join(setup.root, 'candidate-without-derived-fallback'),
  })

  await assert.rejects(
    readFile(join(clone.candidatePath, 'profiles', 'active-profile', '.dsh-module-fallback', 'node_modules', 'schemastery', 'index.js')),
    error => error?.code === 'ENOENT',
  )
  assert.equal(await readFile(fallbackModule, 'utf8'), 'derived fallback module\n')
})

test('candidate clone rebases absolute local tarball specifiers for frozen-lockfile hydration', async t => {
  const { root, profilePath, adapters } = await fixture(t)
  const packageDirectory = join(profilePath, 'packages')
  await mkdir(packageDirectory, { recursive: true })
  const absoluteSpecifier = join(packageDirectory, 'dsh-signal-0.5.44.tgz').replaceAll('\\', '/')
  const lockfile = `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      dsh-signal:\n        specifier: file:${absoluteSpecifier}\n        version: file:packages/dsh-signal-0.5.44.tgz\n`
  await writeFile(join(profilePath, 'pnpm-lock.yaml'), lockfile)
  await writeFile(join(root, 'active-release', 'profiles', 'active-profile', 'pnpm-lock.yaml'), lockfile)

  const clone = await adapters.cloneActiveProfile({
    candidateId: 'candidate-rebased-local-tarball',
    candidatePath: join(root, 'candidate-rebased-local-tarball'),
  })
  const logicalLockfile = await readFile(join(clone.candidatePath, 'profile', 'pnpm-lock.yaml'), 'utf8')
  const physicalLockfile = await readFile(join(clone.candidatePath, 'profiles', 'active-profile', 'pnpm-lock.yaml'), 'utf8')
  assert.match(logicalLockfile, /specifier: file:\.\/packages\/dsh-signal-0\.5\.44\.tgz/)
  assert.match(physicalLockfile, /specifier: file:\.\/packages\/dsh-signal-0\.5\.44\.tgz/)
  assert.doesNotMatch(logicalLockfile, /active-release/u)
})

test('failed candidate cleanup removes only the canonical inactive candidate', async t => {
  const { root, activeRoot, adapters } = await fixture(t)
  const candidatePath = join(root, 'candidate-cleanup')
  await adapters.cloneActiveProfile({ candidateId: 'candidate-cleanup', candidatePath })

  const discarded = await adapters.discardCandidate({ candidateId: 'candidate-cleanup', candidatePath })
  assert.equal(discarded.ok, true)
  await assert.rejects(readFile(join(candidatePath, 'manifest.json')), error => error?.code === 'ENOENT')
  assert.equal(JSON.parse(await readFile(join(activeRoot, 'manifest.json'), 'utf8')).releaseId, 'active-release')

  await assert.rejects(
    adapters.discardCandidate({ candidateId: 'active-release', candidatePath: activeRoot }),
    /active candidate release/i,
  )
})

test('candidate cleanup rejects a junction target without deleting its destination', async t => {
  const { root, adapters } = await fixture(t)
  const outsideRoot = await mkdtemp(join(tmpdir(), 'dsh-plugin-cleanup-outside-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(outsideRoot, { recursive: true, force: true })
  })
  await writeFile(join(outsideRoot, 'keep.txt'), 'preserve me\n')
  const candidatePath = join(root, 'candidate-junction')
  try {
    await symlink(outsideRoot, candidatePath, 'junction')
  } catch (error) {
    if (error?.code === 'EPERM') return t.skip('Windows symlink privilege is unavailable')
    throw error
  }

  await assert.rejects(
    adapters.discardCandidate({ candidateId: 'candidate-junction', candidatePath }),
    /not a regular directory/i,
  )
  assert.equal(await readFile(join(outsideRoot, 'keep.txt'), 'utf8'), 'preserve me\n')
})

test('profile synchronization removes stale optional files and package entries', async t => {
  const { root, adapters } = await fixture(t)
  const clone = await adapters.cloneActiveProfile({
    candidateId: 'candidate-mirror',
    candidatePath: join(root, 'candidate-mirror'),
  })
  const physicalRoot = join(clone.candidatePath, 'profiles', 'active-profile')
  await writeFile(join(physicalRoot, 'cordis.yml'), 'stale: true\n')
  await mkdir(join(physicalRoot, 'packages', 'stale-package'), { recursive: true })
  await writeFile(join(physicalRoot, 'packages', 'stale-package', 'index.js'), 'stale\n')

  await adapters.writeCandidateProfile({
    candidatePath: clone.candidatePath,
    profile: { name: 'active-profile', dependencies: { dshmarket: '1.26.0' } },
  })

  await assert.rejects(readFile(join(physicalRoot, 'cordis.yml')), error => error?.code === 'ENOENT')
  await assert.rejects(readFile(join(physicalRoot, 'packages', 'stale-package', 'index.js')), error => error?.code === 'ENOENT')
})

test('active candidate manifest identity must match the release pointer', async t => {
  const setup = await fixture(t)
  const adapters = createDesktopPluginTransactionAdapters({
    candidateRoot: setup.root,
    resolveActiveRelease: async () => ({
      pointer: { releaseId: 'different-release' },
      recipe: {
        mode: 'stable',
        releaseId: 'different-release',
        profileHome: setup.activeRoot,
        profilePath: setup.profilePath,
        entry: setup.entry,
      },
    }),
    pnpmEntry: 'pnpm.cjs',
  })
  await assert.rejects(
    adapters.cloneActiveProfile({ candidateId: 'candidate-mismatch', candidatePath: join(setup.root, 'candidate-mismatch') }),
    /release id does not match its manifest/i,
  )
})

test('candidate paths outside candidateRoot and overlapping active release fail closed', async t => {
  const { root, activeRoot, adapters } = await fixture(t)
  await assert.rejects(
    adapters.cloneActiveProfile({ candidateId: 'escape', candidatePath: join(dirname(root), 'escape') }),
    /candidateRoot/i,
  )
  await assert.rejects(
    adapters.cloneActiveProfile({ candidateId: 'overlap', candidatePath: join(activeRoot, 'nested') }),
    /overlaps the active candidate/i,
  )
  await assert.rejects(
    adapters.cloneActiveProfile({ candidateId: 'candidate-one', candidatePath: join(root, 'candidate-two') }),
    /does not match its id/i,
  )
})

test('active release links must stay inside the immutable release', async t => {
  const setup = await fixture(t)
  const link = join(setup.activeRoot, 'profile-link')
  try {
    await symlink(setup.profilePath, link, 'junction')
  } catch (error) {
    if (error?.code === 'EPERM') return t.skip('Windows symlink privilege is unavailable')
    throw error
  }
  assert.equal((await setup.adapters.readActiveProfile({})).name, 'active-profile')
  const internalClone = await setup.adapters.cloneActiveProfile({
    candidateId: 'linked-internal',
    candidatePath: join(setup.root, 'linked-internal'),
  })
  assert.equal((await setup.adapters.readCandidateProfile(internalClone)).name, 'active-profile')

  const outsideRoot = join(dirname(setup.root), 'dsh-plugin-adapter-outside')
  await mkdir(outsideRoot, { recursive: true })
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(outsideRoot, { recursive: true, force: true })
  })
  const externalLink = join(setup.activeRoot, 'external-link')
  try {
    await symlink(outsideRoot, externalLink, 'junction')
  } catch (error) {
    if (error?.code === 'EPERM') return t.skip('Windows symlink privilege is unavailable')
    throw error
  }
  await assert.rejects(
    setup.adapters.readActiveProfile({}),
    /symbolic link outside/i,
  )
})

test('DSH plugin invocation uses structured argv, shell false, and candidate cwd', async t => {
  let command
  const setup = await fixture(t, {
    execPath: 'C:\\runtime\\node.exe',
    hiddenChildProcess: 'C:\\runtime\\windows-hidden-child-process.cjs',
    runCommandImpl: async request => {
      command = request
      return { output: 'ok' }
    },
  })
  const clone = await setup.adapters.cloneActiveProfile({
    candidateId: 'candidate-command',
    candidatePath: join(setup.root, 'candidate-command'),
  })
  await setup.adapters.invokeDshPlugin({
    candidatePath: clone.candidatePath,
    argv: ['plugin', '--profile', clone.candidatePath, 'add', '@example/plugin@1.2.3'],
  })

  assert.equal(command.command, 'C:\\runtime\\node.exe')
  assert.deepEqual(command.args, [
    '--require',
    'C:\\runtime\\windows-hidden-child-process.cjs',
    join(clone.candidatePath, 'runtime', 'dsh.js'),
    'plugin',
    '--profile',
    'active-profile',
    'add',
    '@example/plugin@1.2.3',
  ])
  assert.equal(command.cwd, join(clone.candidatePath, 'profiles', 'active-profile'))
  assert.equal(command.shell, false)
  assert.equal(command.env.DSH_HOME, clone.candidatePath)
  assert.equal(Object.hasOwn(command, 'dshHome'), false)
})

test('static candidate gate rejects an incomplete profile before activation', async t => {
  const { adapters, root } = await fixture(t)
  const clone = await adapters.cloneActiveProfile({
    candidateId: 'candidate-gate',
    candidatePath: join(root, 'candidate-gate'),
  })
  await assert.rejects(
    Promise.resolve().then(() => adapters.runCandidateGate(clone)),
    error => error?.code === 'CANDIDATE_COMPATIBILITY_FAILED',
  )
})

test('static candidate gate reads the immutable candidate DSH version for plugin engine checks', async t => {
  const { adapters, root } = await fixture(t)
  const clone = await adapters.cloneActiveProfile({
    candidateId: 'candidate-engine-gate',
    candidatePath: join(root, 'candidate-engine-gate'),
  })
  await adapters.writeCandidateProfile({
    candidatePath: clone.candidatePath,
    profile: {
      name: 'active-profile',
      private: true,
      dependencies: { 'engine-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['engine-plugin'] } },
    },
  })
  const packageRoot = join(clone.candidatePath, 'profiles', 'active-profile', 'node_modules', 'engine-plugin')
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: 'engine-plugin',
    version: '1.0.0',
    main: 'lib/index.js',
    dsh: { engines: { dsh: '>=0.1.2-alpha.1' } },
  }))
  await writeFile(join(packageRoot, 'lib', 'index.js'), 'export default {}\n')
  await assert.rejects(
    adapters.runCandidateGate(clone),
    error => error?.code === 'CANDIDATE_COMPATIBILITY_FAILED'
      && /candidate runtime is 0\.1\.1-rc\.2/u.test(error.message),
  )
})

test('GitHub plugin inventory inspects the pinned package manifest without checkout or lifecycle execution', async t => {
  const calls = []
  const setup = await fixture(t, {
    runGitImpl: async request => {
      calls.push(request.args)
      if (request.args.includes('show')) {
        return { output: JSON.stringify({
          name: '@example/plugin',
          scripts: { prepare: 'node build.js', test: 'node test.js' },
        }) }
      }
      return { output: '' }
    },
  })
  const result = await setup.adapters.inventoryScripts({
    source: { type: 'github', repository: 'example/plugin-repo', commit: 'a'.repeat(40) },
    packageName: '@example/plugin',
  })

  assert.deepEqual(result, {
    packages: [{ package: '@example/plugin', scripts: { prepare: 'node build.js', test: 'node test.js' } }],
  })
  assert.equal(calls.some(args => args.includes('checkout')), false)
  assert.equal(calls.some(args => args.includes('show')), true)
  assert.equal(calls.some(args => args.includes('fetch')), true)
})

test('GitHub package identity mismatches fail closed before install', async t => {
  const setup = await fixture(t, {
    runGitImpl: async request => request.args.includes('show')
      ? { output: JSON.stringify({ name: 'wrong-package', scripts: {} }) }
      : { output: '' },
  })
  await assert.rejects(
    setup.adapters.inventoryScripts({
      source: { type: 'github', repository: 'example/plugin-repo', commit: 'b'.repeat(40) },
      packageName: '@example/plugin',
    }),
    error => error?.code === 'GITHUB_PACKAGE_IDENTITY_MISMATCH',
  )
})
