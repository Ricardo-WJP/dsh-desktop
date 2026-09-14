import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DSH_RC2_COMPATIBILITY_RECIPE } from '../compatibility/recipes/dsh-0.1.1-rc.2.js'
import {
  prepareReleaseCandidate,
  verifyReadyCandidate,
} from '../src/release/candidate-builder.js'
import { applyCompatibilityRecipe } from '../src/release/compatibility-recipe.js'

const RUNTIME_VERSION = '1.2.3'
const RUNTIME_INTEGRITY = 'sha512-c2FtcGxl'
const HASH = 'a'.repeat(64)
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url))

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-candidate-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function profileInputs(root) {
  const evidenceDir = join(root, 'evidence')
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(join(evidenceDir, 'cordis.yml'), 'profile: web\n')
  writeFileSync(join(evidenceDir, 'cordis.patch.yml'), 'patch: candidate\n')
  writeFileSync(join(evidenceDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  return {
    evidenceDir,
    sourcePackage: {
      name: 'candidate-source',
      dependencies: { 'example-client': '1.2.3' },
    },
    sourceLock: {
      lockfileVersion: '9.0',
      importers: { '.': { dependencies: { 'example-client': '1.2.3' } } },
      packages: { 'example-client@1.2.3': { resolution: { integrity: 'sha512-Y2xp' } } },
    },
    compatibility: {
      schemaVersion: 1,
      order: ['example-client'],
    },
  }
}

function options(root, overrides = {}) {
  const inputs = profileInputs(root)
  return {
    candidateRoot: root,
    channel: 'stable',
    releaseId: 'candidate-001',
    desktopVersion: '0.1.34',
    runtimeRelease: { version: RUNTIME_VERSION, integrity: RUNTIME_INTEGRITY },
    profileInputs: inputs,
    compatibilityReceipt: { suiteVersion: 'compat-1', reportSha256: HASH, passed: true },
    installRuntimeImpl: async ({ runtimeRoot, version, integrity }) => {
      const directory = join(runtimeRoot, 'versions', version)
      const packageDirectory = join(directory, 'node_modules', '@deepseek-ai', 'dsh')
      mkdirSync(join(packageDirectory, 'lib'), { recursive: true })
      writeFileSync(join(packageDirectory, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version })}\n`)
      writeFileSync(join(packageDirectory, 'lib', 'bin.js'), '// candidate runtime\n')
      return { source: 'managed', version, integrity, directory }
    },
    buildArtifactsImpl: async ({ outputDir }) => {
      mkdirSync(outputDir, { recursive: true })
      writeFileSync(join(outputDir, 'client.js'), 'export default "candidate"\n')
    },
    ...overrides,
  }
}

test('prepares an isolated ready candidate with exact runtime, physical profile, and artifact hashes', async t => {
  const root = temporaryDirectory(t)
  const activeBefore = 'active-before\n'
  const lkgBefore = 'lkg-before\n'
  writeFileSync(join(root, 'active.json'), activeBefore)
  writeFileSync(join(root, 'last-known-good.json'), lkgBefore)

  const result = await prepareReleaseCandidate(options(root))

  assert.equal(result.status, 'ready')
  assert.equal(result.manifest.dsh.version, RUNTIME_VERSION)
  assert.equal(result.manifest.dsh.integrity, RUNTIME_INTEGRITY)
  assert.equal(result.manifest.profile.physicalName, 'ricardo-stable-candidate-001')
  assert.deepEqual(result.manifest.clientArtifacts.map(artifact => artifact.path), ['runtime/inventory.json', 'artifacts/client.js'])
  assert.equal(existsSync(join(result.candidateDir, 'manifest.json')), true)
  assert.equal(readFileSync(join(root, 'active.json'), 'utf8'), activeBefore)
  assert.equal(readFileSync(join(root, 'last-known-good.json'), 'utf8'), lkgBefore)
  assert.equal((await verifyReadyCandidate(result.candidateDir)).manifestSha256, result.manifestSha256)
  assert.equal((await readdir(root)).some(name => name.startsWith('.staging-')), false)
})

test('resolves profile options after the exact target runtime is known', async t => {
  const root = temporaryDirectory(t)
  let request
  const result = await prepareReleaseCandidate(options(root, {
    releaseId: 'candidate-profile-resolver',
    resolveProfileOptionsImpl: async value => {
      request = value
      return {}
    },
  }))

  assert.equal(request.channel, 'stable')
  assert.equal(request.releaseId, 'candidate-profile-resolver')
  assert.equal(request.runtime.version, RUNTIME_VERSION)
  assert.equal(result.status, 'ready')
})

test('runs state seeding returned by the runtime-aware profile resolver', async t => {
  const root = temporaryDirectory(t)
  let runtimeVersionAtSeed
  const result = await prepareReleaseCandidate(options(root, {
    releaseId: 'candidate-runtime-aware-state',
    resolveProfileOptionsImpl: async ({ runtime }) => ({
      seedCandidateStateImpl: async ({ stageDir }) => {
        runtimeVersionAtSeed = runtime.version
        mkdirSync(join(stageDir, 'storages'), { recursive: true })
        writeFileSync(join(stageDir, 'storages', 'workspace.json'), '{"workspaceIds":[] }\n', { flag: 'w' })
      },
    }),
  }))

  assert.equal(runtimeVersionAtSeed, RUNTIME_VERSION)
  assert.equal(readFileSync(join(result.candidateDir, 'storages', 'workspace.json'), 'utf8'), '{"workspaceIds":[] }\n')
})

test('large runtime inventories report bounded percent progress while retaining full verification', async t => {
  const root = temporaryDirectory(t)
  const buildProgress = []
  const result = await prepareReleaseCandidate(options(root, {
    releaseId: 'candidate-progress',
    onProgress: update => buildProgress.push(update),
    installRuntimeImpl: async ({ runtimeRoot, version, integrity }) => {
      const directory = join(runtimeRoot, 'versions', version)
      const packageDirectory = join(directory, 'node_modules', '@deepseek-ai', 'dsh')
      mkdirSync(join(packageDirectory, 'lib', 'generated'), { recursive: true })
      writeFileSync(join(packageDirectory, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version })}\n`)
      writeFileSync(join(packageDirectory, 'lib', 'bin.js'), '// candidate runtime\n')
      for (let index = 0; index < 240; index += 1) {
        writeFileSync(join(packageDirectory, 'lib', 'generated', `${String(index).padStart(3, '0')}.js`), `export default ${index}\n`)
      }
      return { source: 'managed', version, integrity, directory }
    },
  }))

  const inventoryProgress = buildProgress.filter(update => update.phase === 'runtime-inventory')
  assert.ok(inventoryProgress.length <= 102)
  assert.equal(inventoryProgress[0].completed, 0)
  assert.equal(inventoryProgress.at(-1).completed, inventoryProgress.at(-1).total)

  const verifyProgress = []
  await verifyReadyCandidate(result.candidateDir, { onProgress: update => verifyProgress.push(update) })
  const runtimeProgress = verifyProgress.filter(update => update.phase === 'runtime-verify')
  assert.ok(runtimeProgress.length <= 102)
  assert.equal(runtimeProgress[0].completed, 0)
  assert.equal(runtimeProgress.at(-1).completed, runtimeProgress.at(-1).total)
})

test('applies the versioned runtime compatibility recipe before inventory publication', async t => {
  const root = temporaryDirectory(t)
  const calls = []
  const recipe = { schemaVersion: 1, id: 'runtime-fixture', dsh: { version: RUNTIME_VERSION }, targets: [] }
  const result = await prepareReleaseCandidate(options(root, {
    releaseId: 'candidate-compatibility',
    compatibilityRecipe: recipe,
    applyCompatibilityRecipeImpl: async request => {
      calls.push(request)
      assert.equal(request.dshVersion, RUNTIME_VERSION)
      assert.equal(request.recipe, recipe)
      assert.equal(request.write, true)
      writeFileSync(join(request.root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// compatibility-applied\n')
      return { recipeId: recipe.id, targets: [{ id: 'runtime', state: 'patched' }] }
    },
  }))

  assert.equal(calls.length, 1)
  assert.equal(result.compatibilityRecipe.recipeId, 'runtime-fixture')
  const runtimeEntry = join(result.candidateDir, 'runtime', 'versions', RUNTIME_VERSION, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  assert.equal(readFileSync(runtimeEntry, 'utf8'), '// compatibility-applied\n')
  assert.equal((await verifyReadyCandidate(result.candidateDir)).status, 'ready')
})

test('skips a versioned compatibility recipe when the resolved DSH version is different', async t => {
  const root = temporaryDirectory(t)
  let applied = false
  const result = await prepareReleaseCandidate(options(root, {
    releaseId: 'candidate-compatibility-skip',
    compatibilityRecipeForVersion: version => version === RUNTIME_VERSION
      ? { schemaVersion: 1, id: 'should-not-run', dsh: { version }, targets: [] }
      : undefined,
    applyCompatibilityRecipeImpl: async () => {
      applied = true
      throw new Error('unexpected compatibility recipe')
    },
    installRuntimeImpl: async ({ runtimeRoot, version, integrity }) => {
      const directory = join(runtimeRoot, 'versions', version)
      const packageDirectory = join(directory, 'node_modules', '@deepseek-ai', 'dsh')
      mkdirSync(join(packageDirectory, 'lib'), { recursive: true })
      writeFileSync(join(packageDirectory, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version })}\n`)
      writeFileSync(join(packageDirectory, 'lib', 'bin.js'), '// candidate runtime\n')
      return { source: 'managed', version, integrity, directory }
    },
    runtimeRelease: { source: 'managed', version: '9.9.9', integrity: 'sha512-test' },
  }))

  assert.equal(applied, false)
  assert.equal(result.manifest.dsh.version, '9.9.9')
  assert.equal((await verifyReadyCandidate(result.candidateDir)).status, 'ready')
})

test('publishes the fixed Windows directory picker inside the immutable candidate runtime', async t => {
  const root = temporaryDirectory(t)
  const pickerTargets = DSH_RC2_COMPATIBILITY_RECIPE.targets.filter(target => target.id.startsWith('windows-directory-picker-'))
  const recipe = {
    schemaVersion: 1,
    id: 'directory-picker-runtime-fixture',
    dsh: { version: RUNTIME_VERSION },
    targets: pickerTargets,
  }
  const result = await prepareReleaseCandidate(options(root, {
    releaseId: 'candidate-directory-picker',
    compatibilityRecipe: recipe,
    applyCompatibilityRecipeImpl: applyCompatibilityRecipe,
    installRuntimeImpl: async ({ runtimeRoot, version, integrity }) => {
      const directory = join(runtimeRoot, 'versions', version)
      const dshPackage = join(directory, 'node_modules', '@deepseek-ai', 'dsh')
      mkdirSync(join(dshPackage, 'lib'), { recursive: true })
      writeFileSync(join(dshPackage, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version })}\n`)
      writeFileSync(join(dshPackage, 'lib', 'bin.js'), '// candidate runtime\n')
      for (const target of pickerTargets) {
        let source = readFileSync(join(REPOSITORY_ROOT, ...target.path.split('/')), 'utf8')
        for (const patch of [...target.operations].reverse()) source = source.replace(patch.replace, patch.find)
        assert.equal(createHash('sha256').update(source).digest('hex'), target.sourceSha256)
        const destination = join(directory, ...target.path.split('/'))
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, source)
      }
      return { source: 'managed', version, integrity, directory }
    },
  }))

  for (const target of pickerTargets) {
    const published = join(result.candidateDir, 'runtime', 'versions', RUNTIME_VERSION, ...target.path.split('/'))
    assert.equal(createHash('sha256').update(readFileSync(published)).digest('hex'), target.appliedSha256)
  }
  assert.equal((await verifyReadyCandidate(result.candidateDir)).status, 'ready')
})

test('default profile build packs immutable local bundles and generates the candidate lockfile', async t => {
  const root = temporaryDirectory(t)
  const inputs = profileInputs(root)
  const localName = 'dsh-local-tool'
  const localDirectory = join(root, 'profiles', 'packages', localName)
  mkdirSync(localDirectory, { recursive: true })
  writeFileSync(join(localDirectory, 'package.json'), `${JSON.stringify({ name: localName, version: '1.4.2' })}\n`)
  inputs.sourcePackage.dependencies = { [localName]: 'file:./node_modules/dsh-local-tool' }
  inputs.sourceLock = { lockfileVersion: '9.0', importers: { '.': { dependencies: {} } }, packages: {} }
  inputs.compatibility = { schemaVersion: 1, order: [localName], localPackages: { [localName]: 'profiles/packages/dsh-local-tool' } }
  const calls = []

  const result = await prepareReleaseCandidate(options(root, {
    releaseId: 'candidate-local',
    repositoryRoot: root,
    profileInputs: inputs,
    runPnpmImpl: async invocation => {
      calls.push(invocation)
      if (invocation.args[0] === 'pack') {
        writeFileSync(join(invocation.args[2], 'dsh-local-tool-1.4.2.tgz'), 'packed-local-tool')
      } else if (invocation.args[0] === 'install') {
        writeFileSync(join(invocation.profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\nimporters:\n  .: {}\npackages: {}\n')
      }
      return { output: '' }
    },
  }))

  assert.deepEqual(calls.map(call => call.args[0]), ['pack', 'install'])
  assert.equal(result.manifest.bundles[0].resolved, 'file:./packages/dsh-local-tool-1.4.2.tgz')
  assert.equal(result.manifest.bundles[0].integrityOrCommit, 'local-package:1.4.2')
  assert.equal(existsSync(join(result.candidateDir, 'profile', 'packages', 'dsh-local-tool-1.4.2.tgz')), true)
})

test('download, install, and profile build failures leave no ready candidate or release pointers', async t => {
  const cases = [
    ['download failure', { runtimeRelease: undefined, resolveRuntimeImpl: async () => { throw new Error('download failed') } }, /download failed/],
    ['install failure', { installRuntimeImpl: async () => { throw new Error('install failed') } }, /install failed/],
    ['build failure', { buildArtifactsImpl: async () => { throw new Error('build failed') } }, /build failed/],
  ]
  for (const [label, override, expected] of cases) {
    await t.test(label, async t2 => {
      const root = temporaryDirectory(t2)
      writeFileSync(join(root, 'active.json'), 'active-before\n')
      writeFileSync(join(root, 'last-known-good.json'), 'lkg-before\n')
      await assert.rejects(prepareReleaseCandidate(options(root, override)), expected)
      assert.equal(existsSync(join(root, 'candidate-001')), false)
      assert.equal(readFileSync(join(root, 'active.json'), 'utf8'), 'active-before\n')
      assert.equal(readFileSync(join(root, 'last-known-good.json'), 'utf8'), 'lkg-before\n')
      assert.equal((await readdir(root)).some(name => name.startsWith('.staging-')), false)
    })
  }
})

test('candidate preparation preserves the primary error and reports cleanup failure', async t => {
  const root = temporaryDirectory(t)
  let cleanupOptions
  await assert.rejects(
    prepareReleaseCandidate(options(root, {
      installRuntimeImpl: async () => { throw new Error('injected install failure') },
      removeImpl: async (_target, options) => {
        cleanupOptions = options
        throw new Error('injected cleanup failure')
      },
    })),
    error => /injected install failure/u.test(error.message)
      && /injected cleanup failure/u.test(error.cleanupError?.message ?? ''),
  )
  assert.deepEqual(cleanupOptions, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  assert.equal((await readdir(root)).some(name => name.startsWith('.staging-')), true)
})

test('cancellation after download/install never publishes the ready manifest', async t => {
  const root = temporaryDirectory(t)
  const action = new AbortController()
  const setup = options(root, {
    signal: action.signal,
    installRuntimeImpl: async context => {
      const directory = join(context.runtimeRoot, 'versions', context.version)
      mkdirSync(join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
      writeFileSync(join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: context.version }))
      action.abort(new Error('candidate cancelled'))
      return { version: context.version, integrity: context.integrity, directory }
    },
  })

  await assert.rejects(prepareReleaseCandidate(setup), /candidate cancelled/)
  assert.equal(existsSync(join(root, 'candidate-001', 'manifest.json')), false)
  assert.equal(existsSync(join(root, 'active.json')), false)
  assert.equal(existsSync(join(root, 'last-known-good.json')), false)
})

test('ready candidate verification is offline and detects artifact tampering', async t => {
  const root = temporaryDirectory(t)
  const result = await prepareReleaseCandidate(options(root))
  const artifact = join(result.candidateDir, 'artifacts', 'client.js')
  writeFileSync(artifact, `${readFileSync(artifact, 'utf8')}tampered\n`)
  await assert.rejects(verifyReadyCandidate(result.candidateDir), /artifact .* hash does not match/i)
  assert.match(createHash('sha256').update(readFileSync(artifact)).digest('hex'), /^[a-f0-9]{64}$/)

  const fresh = await prepareReleaseCandidate(options(root, { releaseId: 'candidate-runtime-tamper' }))
  const runtimeEntry = join(fresh.candidateDir, 'runtime', 'versions', RUNTIME_VERSION, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  writeFileSync(runtimeEntry, '// tampered runtime\n')
  await assert.rejects(verifyReadyCandidate(fresh.candidateDir), /runtime file .* inventory/i)
})
