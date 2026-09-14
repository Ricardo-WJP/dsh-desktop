import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectCandidateProfile } from '../src/profile/compatibility-gate.js'

async function profileFixture(t, { duplicateLoaderKey = false, packageManifest, clientText, bundleName = 'example-plugin' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compatibility-gate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'node_modules', bundleName)
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: [bundleName] } },
  }))
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(packageManifest ?? {
    name: 'example-plugin',
    main: 'lib/index.js',
    dsh: { client: { entry: 'client.js' } },
  }))
  await writeFile(join(packageRoot, 'lib/index.js'), 'export default {}\n')
  await writeFile(join(packageRoot, 'client.js'), clientText ?? (duplicateLoaderKey
    ? 'ModuleLoader.load("same-key")\nModuleLoader.load("same-key")\n'
    : 'ModuleLoader.load("example-plugin")\n'))
  return root
}

test('static compatibility gate accepts a complete candidate', async t => {
  const root = await profileFixture(t)
  const receipt = await inspectCandidateProfile({ profilePath: root, platform: 'win32' })
  assert.equal(receipt.ok, true)
  assert.deepEqual(receipt.bundles, ['example-plugin'])
})

test('static compatibility gate accepts a plugin whose DSH engine includes the candidate prerelease', async t => {
  const root = await profileFixture(t, {
    packageManifest: {
      name: 'example-plugin',
      version: '1.2.3',
      main: 'lib/index.js',
      dsh: {
        engines: { dsh: '>=0.1.1-rc.1' },
        client: { entry: 'client.js' },
      },
    },
  })
  const receipt = await inspectCandidateProfile({ profilePath: root, dshVersion: '0.1.1-rc.2' })
  assert.deepEqual(receipt.engineChecks, [{
    name: 'example-plugin',
    pluginVersion: '1.2.3',
    requiredRange: '>=0.1.1-rc.1',
    dshVersion: '0.1.1-rc.2',
    status: 'compatible',
  }])
})

test('static compatibility gate rejects an incompatible or malformed DSH engine', async t => {
  for (const [label, requiredRange, expected] of [
    ['newer host', '>=0.1.2-alpha.1', /requires DSH >=0\.1\.2-alpha\.1 but candidate runtime is 0\.1\.1-rc\.2/u],
    ['malformed range', 'definitely-not-semver', /invalid dsh\.engines\.dsh range/u],
  ]) {
    await t.test(label, async t => {
      const root = await profileFixture(t, {
        packageManifest: {
          name: 'example-plugin',
          version: '1.2.3',
          main: 'lib/index.js',
          dsh: { engines: { dsh: requiredRange } },
        },
      })
      await assert.rejects(
        inspectCandidateProfile({ profilePath: root, dshVersion: '0.1.1-rc.2' }),
        error => error?.code === 'CANDIDATE_COMPATIBILITY_FAILED' && expected.test(error.message),
      )
    })
  }
})

test('static compatibility gate accepts only an exact audited engine override', async t => {
  const root = await profileFixture(t, {
    packageManifest: {
      name: 'example-plugin',
      version: '1.2.3',
      main: 'lib/index.js',
      dsh: { engines: { dsh: '>=0.1.2-alpha.1' } },
    },
  })
  const exactOverride = {
    name: 'example-plugin',
    pluginVersion: '1.2.3',
    dshVersion: '0.1.1-rc.2',
    requiredRange: '>=0.1.2-alpha.1',
    reason: 'fixture-audit',
  }
  const receipt = await inspectCandidateProfile({
    profilePath: root,
    dshVersion: '0.1.1-rc.2',
    engineCompatibilityOverrides: [exactOverride],
  })
  assert.equal(receipt.engineChecks[0].status, 'audited-override')
  assert.equal(receipt.engineChecks[0].reason, 'fixture-audit')
  await assert.rejects(
    inspectCandidateProfile({
      profilePath: root,
      dshVersion: '0.1.1-rc.2',
      engineCompatibilityOverrides: [{ ...exactOverride, pluginVersion: '1.2.4' }],
    }),
    error => error?.code === 'CANDIDATE_COMPATIBILITY_FAILED' && /requires DSH/u.test(error.message),
  )
})

test('static compatibility gate defers unverified duplicate loader text to the runtime gate', async t => {
  const root = await profileFixture(t, { duplicateLoaderKey: true })
  const receipt = await inspectCandidateProfile({ profilePath: root })
  assert.equal(receipt.ok, true)
  assert.deepEqual(receipt.duplicateLoaderKeys, ['same-key'])
  assert.equal(receipt.warnings[0].code, 'UNVERIFIED_DUPLICATE_LOADER_KEYS')
  assert.equal(receipt.warnings[0].requiresRuntimeGate, true)
  assert.deepEqual(receipt.warnings[0].keys, ['same-key'])
})

test('static compatibility gate accepts nested conditional package and client exports', async t => {
  const root = await profileFixture(t, {
    packageManifest: {
      name: 'example-plugin',
      exports: {
        '.': { node: { import: './lib/index.js' } },
        './client': { browser: { default: './client.js' } },
      },
    },
  })
  const receipt = await inspectCandidateProfile({ profilePath: root })
  assert.equal(receipt.ok, true)
})

test('comments and quoted loader examples produce warnings rather than hard rejection', async t => {
  for (const clientText of [
    '// ModuleLoader.load("example-plugin")\nModuleLoader.load("example-plugin")\n',
    'const example = `ModuleLoader.load("example-plugin")`;\nModuleLoader.load("example-plugin")\n',
  ]) {
    const root = await profileFixture(t, { clientText })
    const receipt = await inspectCandidateProfile({ profilePath: root })
    assert.equal(receipt.ok, true)
    assert.equal(receipt.warnings.length, 1)
    assert.equal(receipt.warnings[0].requiresRuntimeGate, true)
  }
})

test('client declarations are deduplicated by physical path after validation', async t => {
  const root = await profileFixture(t, {
    packageManifest: {
      name: 'example-plugin',
      exports: { '.': './lib/index.js', './client': './client.js' },
      dsh: { client: { entry: 'client.js', script: './client.js', path: 'lib/../client.js' } },
    },
  })
  const receipt = await inspectCandidateProfile({ profilePath: root })
  assert.equal(receipt.ok, true)
  assert.deepEqual(receipt.duplicateLoaderKeys, [])
  assert.deepEqual(receipt.warnings, [])
})

test('in-package client symlink aliases are scanned once', async t => {
  const root = await profileFixture(t, {
    packageManifest: {
      name: 'example-plugin',
      main: 'lib/index.js',
      dsh: { client: { entry: 'client.js', script: 'alias/client.js' } },
    },
  })
  const packageRoot = join(root, 'node_modules', 'example-plugin')
  try {
    await symlink(packageRoot, join(packageRoot, 'alias'), 'junction')
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error?.code)) {
      t.skip('directory links are unavailable on this host')
      return
    }
    throw error
  }
  const receipt = await inspectCandidateProfile({ profilePath: root })
  assert.equal(receipt.ok, true)
  assert.deepEqual(receipt.duplicateLoaderKeys, [])
})

test('host exports take precedence over main and follow import condition order', async t => {
  for (const [label, exports] of [
    ['string root', './lib/index.js'],
    ['node before default', { '.': { node: { import: './lib/index.js' }, default: './missing.js' } }],
    ['import rather than require', { '.': { require: './missing.cjs', import: './lib/index.js' } }],
    ['host rather than browser', { '.': { browser: './missing-browser.js', node: './lib/index.js' } }],
    ['array fallback', { '.': [null, './lib/index.js'] }],
  ]) {
    await t.test(label, async t => {
      const root = await profileFixture(t, {
        packageManifest: { name: 'example-plugin', main: 'removed-legacy.js', exports },
      })
      const receipt = await inspectCandidateProfile({ profilePath: root })
      assert.equal(receipt.ok, true)
    })
  }
})

test('selected invalid or blocked exports cannot fall back to an existing main', async t => {
  for (const [label, exports, expected] of [
    ['missing target', './missing.js', /package entry does not exist/u],
    ['escaping target', '../../outside.js', /package entry escapes package root/u],
    ['subpath is not a root', { './feature': './lib/index.js' }, /package entry is not declared/u],
    ['explicitly blocked root', { '.': null }, /package entry is not declared/u],
    ['blocked node before default', { '.': { node: null, default: './lib/index.js' } }, /package entry is not declared/u],
    ['default wins when declared first', { '.': { default: './missing.js', node: './lib/index.js' } }, /package entry does not exist/u],
  ]) {
    await t.test(label, async t => {
      const root = await profileFixture(t, {
        packageManifest: { name: 'example-plugin', main: 'lib/index.js', exports },
      })
      await assert.rejects(
        inspectCandidateProfile({ profilePath: root }),
        error => error?.code === 'CANDIDATE_COMPATIBILITY_FAILED' && expected.test(error.message),
      )
    })
  }
})

test('Windows inspector accepts a valid exports-only entry without a name-specific main rule', async t => {
  const root = await profileFixture(t, {
    bundleName: 'dsh-win-terminal-inspector',
    packageManifest: { name: 'dsh-win-terminal-inspector', exports: { '.': './lib/index.js' } },
  })
  const receipt = await inspectCandidateProfile({ profilePath: root, platform: 'win32' })
  assert.equal(receipt.ok, true)
})

test('client exports select browser conditions rather than node or require', async t => {
  const root = await profileFixture(t, {
    packageManifest: {
      name: 'example-plugin',
      exports: {
        '.': './lib/index.js',
        './client': { node: './missing-node.js', require: './missing.cjs', browser: './client.js' },
      },
    },
  })
  const receipt = await inspectCandidateProfile({ profilePath: root })
  assert.equal(receipt.ok, true)
})

test('loader warnings never downgrade engine or package identity failures', async t => {
  for (const [label, manifest, expected] of [
    ['engine', { name: 'example-plugin', version: '1.2.3', dsh: { engines: { dsh: '>=9' }, client: { entry: 'client.js' } } }, /requires DSH/u],
    ['identity', { name: 'different-plugin', dsh: { client: { entry: 'client.js' } } }, /package manifest identity/u],
  ]) {
    await t.test(label, async t => {
      const root = await profileFixture(t, {
        duplicateLoaderKey: true,
        packageManifest: { main: 'lib/index.js', ...manifest },
      })
      await assert.rejects(
        inspectCandidateProfile({ profilePath: root, dshVersion: '0.1.1-rc.2' }),
        error => error?.code === 'CANDIDATE_COMPATIBILITY_FAILED'
          && expected.test(error.message) && error.details.warnings[0].requiresRuntimeGate === true,
      )
    })
  }
})

test('duplicate bundle declarations remain a hard failure', async t => {
  const root = await profileFixture(t)
  await writeFile(join(root, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['example-plugin', 'example-plugin'] } },
  }))
  await assert.rejects(
    inspectCandidateProfile({ profilePath: root }),
    error => error?.code === 'CANDIDATE_COMPATIBILITY_FAILED' && /duplicate bundles/u.test(error.message),
  )
})

test('static compatibility gate rejects package-owned paths that escape the plugin root', async t => {
  const cases = [
    {
      label: 'main entry',
      manifest: { name: 'example-plugin', main: '../../outside.js' },
      expected: /package entry escapes package root/u,
    },
    {
      label: 'Cordis patch',
      manifest: { name: 'example-plugin', main: './lib/index.js', dsh: { bundle: { patch: '../../outside.js' } } },
      expected: /Cordis patch escapes package root/u,
    },
    {
      label: 'exported client entry',
      manifest: { name: 'example-plugin', exports: { '.': './lib/index.js', './client': '../../outside.js' } },
      expected: /client entry escapes package root/u,
    },
    {
      label: 'client entry',
      manifest: { name: 'example-plugin', main: './lib/index.js', dsh: { client: { entry: '../../outside.js' } } },
      expected: /client entry escapes package root/u,
    },
  ]

  for (const fixture of cases) {
    await t.test(fixture.label, async t => {
      const root = await profileFixture(t, { packageManifest: fixture.manifest })
      await writeFile(join(root, 'outside.js'), 'export default {}\n')
      await assert.rejects(
        inspectCandidateProfile({ profilePath: root }),
        error => error?.code === 'CANDIDATE_COMPATIBILITY_FAILED' && fixture.expected.test(error.message),
      )
    })
  }
})

test('static compatibility gate rejects a client link that resolves outside the plugin root', async t => {
  const root = await profileFixture(t, {
    packageManifest: {
      name: 'example-plugin',
      main: './lib/index.js',
      dsh: { client: { entry: './linked-client.js' } },
    },
  })
  const outside = join(root, 'outside-client.js')
  const linked = join(root, 'node_modules', 'example-plugin', 'linked-client.js')
  await writeFile(outside, 'ModuleLoader.load("outside")\n')
  try {
    await symlink(outside, linked, 'file')
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error?.code)) {
      t.skip('file symlinks are unavailable on this Windows host')
      return
    }
    throw error
  }

  await assert.rejects(
    inspectCandidateProfile({ profilePath: root }),
    error => error?.code === 'CANDIDATE_COMPATIBILITY_FAILED' && /client entry resolves outside package root/u.test(error.message),
  )
})

test('directory junctions cannot bypass entry client or patch ownership checks', async t => {
  for (const [label, manifest, expected] of [
    ['exports', { exports: { '.': './linked/fixture.js' } }, /package entry resolves outside package root/u],
    ['client', { dsh: { client: { entry: './linked/fixture.js' } } }, /client entry resolves outside package root/u],
    ['patch', { dsh: { bundle: { patch: './linked/fixture.js' } } }, /Cordis patch resolves outside package root/u],
  ]) {
    await t.test(label, async t => {
      const root = await profileFixture(t, {
        packageManifest: { name: 'example-plugin', main: 'lib/index.js', ...manifest },
      })
      const outside = join(root, 'outside-package')
      await mkdir(outside)
      await writeFile(join(outside, 'fixture.js'), 'throw new Error("must not be loaded")\n')
      await symlink(outside, join(root, 'node_modules', 'example-plugin', 'linked'), 'junction')
      await assert.rejects(
        inspectCandidateProfile({ profilePath: root }),
        error => error?.code === 'CANDIDATE_COMPATIBILITY_FAILED' && expected.test(error.message),
      )
    })
  }
})
