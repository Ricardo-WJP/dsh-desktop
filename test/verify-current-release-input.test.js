import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createManagedReleaseManifest, serializeReleaseManifest } from '../src/release/manifest.js'
import { verifyCurrentReleaseInput } from '../scripts/verify-current-release-input.mjs'

const ACCEPTANCE_LIMITATION = 'This reviewer acceptance report is not cryptographic proof that performance suites or tests ran.'
const CLI_PATH = fileURLToPath(new URL('../scripts/verify-current-release-input.mjs', import.meta.url))

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function manifest(version = '1.2.3') {
  return createManagedReleaseManifest({
    releaseId: 'stable-2026-09-14-001',
    channel: 'stable',
    desktopVersion: version,
    dshVersion: '0.1.1-rc.2',
    dshIntegrity: 'sha512-dGVzdA==',
    profile: {
      logicalName: 'ricardo-stable',
      physicalName: 'ricardo-stable-2026-09-14-001',
      manifestSha256: 'a'.repeat(64),
      lockSha256: 'b'.repeat(64),
      patchSha256: 'c'.repeat(64),
    },
    bundles: [],
    clientArtifacts: [],
    compatibility: { suiteVersion: 'test-suite', reportSha256: 'd'.repeat(64), passed: true },
    createdAt: '2026-09-14T00:00:00.000Z',
  })
}

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-current-release-input-'))
  const packageJson = join(root, 'package.json')
  const releaseManifest = join(root, 'release-manifest.json')
  const releaseValidation = join(root, 'release-validation.json')
  const release = manifest()
  const manifestText = serializeReleaseManifest(release)
  const report = {
    schemaVersion: 1,
    releaseEligible: true,
    reason: 'Performance and final candidate acceptance accepted',
    desktopVersion: release.desktopVersion,
    manifestSha256: sha256(manifestText),
    provenance: { type: 'reviewer-acceptance', limitation: ACCEPTANCE_LIMITATION },
    ...overrides.report,
  }
  await writeFile(packageJson, JSON.stringify({ name: 'fixture', version: overrides.packageVersion ?? release.desktopVersion }))
  await writeFile(releaseManifest, overrides.manifestText ?? manifestText)
  await writeFile(releaseValidation, JSON.stringify(report))
  return { packageJson, releaseManifest, releaseValidation, release }
}

async function invokeCli(input) {
  const child = spawn(process.execPath, [
    CLI_PATH,
    '--package-json', input.packageJson,
    '--release-manifest', input.releaseManifest,
    '--release-validation', input.releaseValidation,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', value => { stdout += value })
  child.stderr.on('data', value => { stderr += value })
  const [code] = await once(child, 'close')
  return { code, stdout, stderr }
}

test('accepts an explicit current managed stable release input with matching canonical hash', async () => {
  const input = await fixture()
  const result = await verifyCurrentReleaseInput(input)
  assert.equal(result.releaseId, input.release.releaseId)
})

test('CLI maps explicit kebab-case paths to the current release input validator', async () => {
  const input = await fixture()
  const result = await invokeCli(input)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, input.release.releaseId)
  // Node may emit host-environment warnings before this CLI starts. Its
  // contract is the exit status and exact releaseId, not silent Node startup.
  assert.doesNotMatch(result.stderr, /Current release input rejected:/)
})

test('rejects pending reviewer acceptance, version mismatches, and noncanonical manifests', async () => {
  const pending = await fixture({ report: { releaseEligible: false, reason: 'Performance and final candidate acceptance pending', manifestSha256: null } })
  await assert.rejects(() => verifyCurrentReleaseInput(pending), /releaseEligible must be true/)

  const wrongVersion = await fixture({ packageVersion: '9.9.9' })
  await assert.rejects(() => verifyCurrentReleaseInput(wrongVersion), /desktopVersion does not match package\.json\.version/)

  const noncanonical = await fixture({ manifestText: `${serializeReleaseManifest(manifest())}\n` })
  await assert.rejects(() => verifyCurrentReleaseInput(noncanonical), /exact canonical serialization/)
})
