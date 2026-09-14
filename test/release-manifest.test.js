import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RELEASE_MANIFEST_SCHEMA_VERSION,
  createBootstrapReleaseManifest,
  createManagedReleaseManifest,
  rebaseManagedReleaseManifest,
  releaseManifestSha256,
  serializeReleaseManifest,
  validateReleaseManifest,
} from '../src/release/manifest.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const COMMIT = 'c'.repeat(40)
const CREATED_AT = '2026-08-21T00:00:00.000Z'

function fixture(overrides = {}) {
  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    releaseId: 'stable-2026-08-21-001',
    releaseType: 'managed',
    channel: 'stable',
    desktopVersion: '0.1.34',
    dsh: {
      version: '0.1.1-rc.1',
      source: 'npm',
      integrity: 'sha512-ZHNo',
    },
    profile: {
      logicalName: 'ricardo-stable',
      physicalName: 'ricardo-stable-2026-08-21-001',
      manifestSha256: HASH_A,
      lockSha256: HASH_B,
      patchSha256: HASH_A,
    },
    bundles: [
      {
        name: '@deepseek-ai/dsh-base',
        resolved: '0.1.1-rc.1',
        integrityOrCommit: 'sha512-YmFzZQ==',
      },
      {
        name: 'example-client-plugin',
        resolved: `github:example/example-client-plugin#${COMMIT}`,
        integrityOrCommit: COMMIT,
      },
    ],
    clientArtifacts: [
      { path: 'plugins/example-client-plugin/client.js', sha256: HASH_B },
    ],
    compatibility: {
      suiteVersion: 'compat-1',
      reportSha256: HASH_A,
      passed: true,
    },
    createdAt: CREATED_AT,
    ...overrides,
  }
}

function clone(value) {
  return structuredClone(value)
}

test('validates and deeply freezes a complete managed release manifest', () => {
  const manifest = validateReleaseManifest(fixture())

  assert.equal(manifest.releaseId, 'stable-2026-08-21-001')
  assert.equal(manifest.dsh.source, 'npm')
  assert.equal(manifest.bundles[1].integrityOrCommit, COMMIT)
  assert.equal(Object.isFrozen(manifest), true)
  assert.equal(Object.isFrozen(manifest.profile), true)
  assert.equal(Object.isFrozen(manifest.bundles), true)
  assert.equal(Object.isFrozen(manifest.bundles[0]), true)
})

test('rejects unknown schema versions, missing fields, and unknown fields', () => {
  assert.throws(() => validateReleaseManifest(fixture({ schemaVersion: 0 })), /schemaVersion/)

  const missing = clone(fixture())
  delete missing.dsh.integrity
  assert.throws(() => validateReleaseManifest(missing), /dsh\.integrity: missing field/)

  assert.throws(() => validateReleaseManifest(fixture({ surprise: true })), /root\.surprise: unknown field/)
})

test('rejects path escapes and duplicate client artifacts', () => {
  for (const path of ['../client.js', '/client.js', 'C:/client.js', 'plugins\\client.js', 'plugins/../client.js']) {
    const manifest = fixture({ clientArtifacts: [{ path, sha256: HASH_A }] })
    assert.throws(() => validateReleaseManifest(manifest), /clientArtifacts\[0\]\.path/)
  }

  const duplicate = fixture({
    clientArtifacts: [
      { path: 'plugins/client.js', sha256: HASH_A },
      { path: 'plugins/client.js', sha256: HASH_B },
    ],
  })
  assert.throws(() => validateReleaseManifest(duplicate), /duplicate client artifact/)
})

test('rejects duplicate bundles, floating GitHub refs, and mutable stable sources', () => {
  const duplicate = clone(fixture())
  duplicate.bundles.push({ ...duplicate.bundles[0] })
  assert.throws(() => validateReleaseManifest(duplicate), /duplicate bundle/)

  const floating = clone(fixture())
  floating.bundles[1].resolved = 'github:example/example-client-plugin#main'
  assert.throws(() => validateReleaseManifest(floating), /exact 40-character commit/)

  const traversal = clone(fixture())
  traversal.bundles[1].resolved = `github:example/example-client-plugin#${COMMIT}&path:/../secret`
  assert.throws(() => validateReleaseManifest(traversal), /cannot traverse/)

  for (const resolved of ['link:C:/plugins/example', 'file:../example.tgz']) {
    const mutable = clone(fixture())
    mutable.bundles[1].resolved = resolved
    assert.throws(() => validateReleaseManifest(mutable), /cannot contain link: or file:/)
  }
})

test('requires a passed compatibility receipt and exact runtime source semantics', () => {
  const failed = clone(fixture())
  failed.compatibility.passed = false
  assert.throws(() => validateReleaseManifest(failed), /compatibility\.passed/)

  const wrongManagedSource = clone(fixture())
  wrongManagedSource.dsh.source = 'bundled'
  assert.throws(() => validateReleaseManifest(wrongManagedSource), /managed releases must use an npm runtime/)

  const commitAsPackageIntegrity = clone(fixture())
  commitAsPackageIntegrity.dsh.integrity = COMMIT
  assert.throws(() => validateReleaseManifest(commitAsPackageIntegrity), /expected npm SRI or sha256/)
})

test('represents the bundled DSH runtime as an immutable bootstrap release', () => {
  const base = fixture()
  const manifest = createBootstrapReleaseManifest({
    releaseId: 'bootstrap-0.1.34',
    desktopVersion: base.desktopVersion,
    dshVersion: base.dsh.version,
    dshIntegrity: `sha256:${HASH_A}`,
    profile: base.profile,
    bundles: base.bundles,
    clientArtifacts: base.clientArtifacts,
    compatibility: base.compatibility,
    createdAt: base.createdAt,
  })

  assert.equal(manifest.releaseType, 'bootstrap')
  assert.equal(manifest.channel, 'local')
  assert.equal(manifest.dsh.source, 'bundled')
  assert.equal(Object.isFrozen(manifest), true)
})

test('serializes canonically and hashes the validated manifest', () => {
  const manifest = fixture()
  const first = serializeReleaseManifest(manifest)
  const second = serializeReleaseManifest(clone(manifest))
  assert.equal(first, second)
  assert.match(releaseManifestSha256(manifest), /^[a-f0-9]{64}$/)
  assert.equal(releaseManifestSha256(manifest), releaseManifestSha256(clone(manifest)))

  const changed = fixture({ releaseId: 'stable-2026-08-21-002' })
  assert.notEqual(releaseManifestSha256(manifest), releaseManifestSha256(changed))
})

test('rebases a managed release through the canonical validator', () => {
  const rebased = rebaseManagedReleaseManifest(fixture(), {
    releaseId: 'plugin-candidate-001',
    createdAt: '2026-08-25T00:00:00.000Z',
  })
  assert.equal(rebased.releaseId, 'plugin-candidate-001')
  assert.equal(rebased.createdAt, '2026-08-25T00:00:00.000Z')
  assert.equal(rebased.profile.physicalName, fixture().profile.physicalName)
  assert.equal(Object.isFrozen(rebased), true)

  const bootstrap = createBootstrapReleaseManifest({
    releaseId: 'bootstrap-0.1.34',
    desktopVersion: '0.1.34',
    dshVersion: '0.1.1-rc.1',
    dshIntegrity: `sha256:${HASH_A}`,
    profile: fixture().profile,
    bundles: fixture().bundles,
    clientArtifacts: fixture().clientArtifacts,
    compatibility: fixture().compatibility,
    createdAt: CREATED_AT,
  })
  assert.throws(
    () => rebaseManagedReleaseManifest(bootstrap, { releaseId: 'plugin-invalid', createdAt: CREATED_AT }),
    /only managed releases/i,
  )
})

test('accepts only packaged local profile bundles and provides the managed factory', () => {
  const base = fixture()
  const local = clone(base)
  local.bundles[0] = {
    name: 'dsh-health-tool',
    resolved: 'file:./packages/dsh-health-tool-1.2.3.tgz',
    integrityOrCommit: 'local-package:1.2.3',
  }
  assert.equal(validateReleaseManifest(local).bundles[0].resolved, 'file:./packages/dsh-health-tool-1.2.3.tgz')

  const mutable = clone(local)
  mutable.bundles[0].resolved = 'file:./packages/dsh-health-tool'
  assert.throws(() => validateReleaseManifest(mutable), /cannot contain link: or file:/)

  const created = createManagedReleaseManifest({
    releaseId: base.releaseId,
    channel: base.channel,
    desktopVersion: base.desktopVersion,
    dshVersion: base.dsh.version,
    dshIntegrity: base.dsh.integrity,
    profile: base.profile,
    bundles: base.bundles,
    clientArtifacts: base.clientArtifacts,
    compatibility: base.compatibility,
    createdAt: base.createdAt,
  })
  assert.equal(created.releaseType, 'managed')
  assert.equal(created.dsh.source, 'npm')
})
