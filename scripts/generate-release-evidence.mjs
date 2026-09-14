import process from 'node:process'
import {
  ReleaseEvidenceError,
  serializeCanonicalJson,
  sha256Bytes,
  writeReleaseEvidence,
} from '../src/release/artifact-manifest.js'

const USAGE = `Usage:
  node scripts/generate-release-evidence.mjs \
    --staging-root <directory> \
    --output-dir <directory> \
    --package-lock <file> \
    --package-json <file> \
    --release-manifest <file> \
    --setup <relative-artifact-path> \
    --portable <relative-artifact-path> \
    [--exclude <relative-glob>]... \
    [--required-artifact <relative-artifact-path>]... \
    [--release-id <id>]

All paths are explicit. The script does not scan a default directory, start a
shell, install packages, build installers, or sign releases.`

function usageError(message) {
  throw new ReleaseEvidenceError(`${message}\n\n${USAGE}`)
}

function parseArgs(argv) {
  const values = new Map()
  const repeated = new Map([
    ['--exclude', []],
    ['--required-artifact', []],
  ])
  const aliases = new Map([
    ['--setup-artifact', '--setup'],
    ['--portable-artifact', '--portable'],
  ])
  const takesValue = new Set([
    '--staging-root',
    '--output-dir',
    '--package-lock',
    '--package-json',
    '--release-manifest',
    '--setup',
    '--portable',
    '--release-id',
    '--exclude',
    '--required-artifact',
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const originalFlag = argv[index]
    if (originalFlag === '--help' || originalFlag === '-h') {
      process.stdout.write(`${USAGE}\n`)
      return null
    }
    const flag = aliases.get(originalFlag) ?? originalFlag
    if (!takesValue.has(flag)) usageError(`Unknown argument: ${originalFlag}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) usageError(`${originalFlag} requires an explicit value`)
    index += 1
    if (repeated.has(flag)) repeated.get(flag).push(value)
    else if (values.has(flag)) usageError(`${originalFlag} was supplied more than once`)
    else values.set(flag, value)
  }

  for (const flag of ['--staging-root', '--output-dir', '--package-lock', '--package-json', '--release-manifest', '--setup', '--portable']) {
    if (!values.has(flag)) usageError(`${flag} is required; refusing implicit paths`)
  }
  return {
    stagingRoot: values.get('--staging-root'),
    outputDir: values.get('--output-dir'),
    packageLockPath: values.get('--package-lock'),
    packageJsonPath: values.get('--package-json'),
    releaseManifestPath: values.get('--release-manifest'),
    setupPath: values.get('--setup'),
    portablePath: values.get('--portable'),
    releaseId: values.get('--release-id'),
    exclude: repeated.get('--exclude'),
    requiredArtifacts: repeated.get('--required-artifact'),
  }
}

const options = parseArgs(process.argv.slice(2))
if (options) {
  try {
    const result = await writeReleaseEvidence(options)
    process.stdout.write(serializeCanonicalJson({
      artifactManifest: result.paths.artifactManifestPath,
      sbom: result.paths.sbomPath,
      notices: result.paths.noticesPath,
      evidence: result.paths.evidencePath,
      evidenceSha256: sha256Bytes(serializeCanonicalJson(result.evidence)),
      signingStatus: result.evidence.signing.status,
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Release evidence generation failed closed: ${message}`)
    process.exitCode = 1
  }
}
