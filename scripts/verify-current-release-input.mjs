import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { serializeReleaseManifest, validateReleaseManifest } from '../src/release/manifest.js'

const REQUIRED_OPTIONS = ['package-json', 'release-manifest', 'release-validation']
const ACCEPTANCE_PROVENANCE = 'reviewer-acceptance'
const ACCEPTANCE_LIMITATION = 'This reviewer acceptance report is not cryptographic proof that performance suites or tests ran.'

function fail(message) {
  throw new Error(`Current release input rejected: ${message}`)
}

function parseOptions(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value === undefined) fail('expected explicit --name path arguments')
    const name = flag.slice(2)
    if (!REQUIRED_OPTIONS.includes(name)) fail(`unknown option --${name}`)
    if (options.has(name)) fail(`duplicate option --${name}`)
    options.set(name, value)
  }
  for (const name of REQUIRED_OPTIONS) {
    if (!options.has(name) || options.get(name).trim() === '') fail(`missing explicit --${name} path`)
  }
  return {
    packageJson: options.get('package-json'),
    releaseManifest: options.get('release-manifest'),
    releaseValidation: options.get('release-validation'),
  }
}

function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(', ')}`)
  }
}

function text(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`)
  return value
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function validateReport(value, { desktopVersion, manifestSha256 }) {
  const report = object(value, 'release-validation')
  exactKeys(report, ['schemaVersion', 'releaseEligible', 'reason', 'desktopVersion', 'manifestSha256', 'provenance'], 'release-validation')
  if (report.schemaVersion !== 1) fail('release-validation.schemaVersion must be 1')
  if (typeof report.releaseEligible !== 'boolean') fail('release-validation.releaseEligible must be boolean')
  const reason = text(report.reason, 'release-validation.reason')
  const provenance = object(report.provenance, 'release-validation.provenance')
  exactKeys(provenance, ['type', 'limitation'], 'release-validation.provenance')
  if (provenance.type !== ACCEPTANCE_PROVENANCE || provenance.limitation !== ACCEPTANCE_LIMITATION) {
    fail('release-validation provenance must honestly identify reviewer acceptance and its limitation')
  }
  if (report.releaseEligible !== true) fail(`release-validation.releaseEligible must be true; reason: ${reason}`)
  if (report.desktopVersion !== desktopVersion) fail('release-validation.desktopVersion does not match package.json and release manifest')
  if (report.manifestSha256 !== manifestSha256) fail('release-validation.manifestSha256 does not match the exact canonical release manifest')
}

async function readJson(path, label) {
  let textValue
  try {
    textValue = await readFile(path, 'utf8')
  } catch (error) {
    fail(`${label} cannot be read at ${path}: ${error.message}`)
  }
  try {
    return { text: textValue, value: JSON.parse(textValue) }
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`)
  }
}

export async function verifyCurrentReleaseInput(options) {
  const packageInput = await readJson(options.packageJson, 'package.json')
  const packageJson = object(packageInput.value, 'package.json')
  const packageVersion = text(packageJson.version, 'package.json.version')
  const manifestInput = await readJson(options.releaseManifest, 'release-manifest.json')
  const manifest = validateReleaseManifest(manifestInput.value)
  const canonicalManifest = serializeReleaseManifest(manifest)
  if (manifestInput.text !== canonicalManifest) fail('release-manifest.json must use the exact canonical serialization')
  if (manifest.releaseType !== 'managed' || manifest.channel !== 'stable') fail('release manifest must be managed and stable')
  if (manifest.desktopVersion !== packageVersion) fail('release manifest desktopVersion does not match package.json.version')
  const manifestSha256 = sha256(canonicalManifest)
  const reportInput = await readJson(options.releaseValidation, 'compatibility/release-validation.json')
  validateReport(reportInput.value, { desktopVersion: packageVersion, manifestSha256 })
  return { releaseId: manifest.releaseId, manifestSha256 }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const result = await verifyCurrentReleaseInput(options)
  process.stdout.write(result.releaseId)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
