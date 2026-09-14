import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import semver from 'semver'

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1
export const RELEASE_TYPES = Object.freeze(['bootstrap', 'managed'])
export const RELEASE_CHANNELS = Object.freeze(['stable', 'next', 'local'])

const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const HEX_SHA256 = /^[a-f0-9]{64}$/i
const GIT_COMMIT = /^[a-f0-9]{40}$/i
const SRI = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/
const COLON_SHA256 = /^sha256:[a-f0-9]{64}$/i
const LOCAL_PACKAGE = /^local-package:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function fail(path, message) {
  throw new Error(`Invalid release manifest ${path}: ${message}`)
}

function plainObject(value, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'expected an object')
  return value
}

function exactKeys(value, keys, path) {
  const expected = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${path}.${key}`, 'unknown field')
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'missing field')
  }
}

function nonEmptyString(value, path, maximum = 512) {
  if (typeof value !== 'string' || value === '' || value.length > maximum || value.trim() !== value) {
    fail(path, `expected a trimmed non-empty string up to ${String(maximum)} characters`)
  }
  return value
}

function exactSemver(value, path) {
  const normalized = nonEmptyString(value, path, 128)
  if (semver.valid(normalized) !== normalized) fail(path, 'expected an exact semantic version')
  return normalized
}

function sha256(value, path) {
  const normalized = nonEmptyString(value, path, 64)
  if (!HEX_SHA256.test(normalized)) fail(path, 'expected a 64-character SHA-256 hex digest')
  return normalized.toLowerCase()
}

function packageIntegrity(value, path) {
  const normalized = nonEmptyString(value, path, 256)
  if (!SRI.test(normalized) && !COLON_SHA256.test(normalized)) {
    fail(path, 'expected npm SRI or sha256:<hex>')
  }
  return COLON_SHA256.test(normalized) ? normalized.toLowerCase() : normalized
}

function bundleIntegrity(value, path) {
  const normalized = nonEmptyString(value, path, 256)
  if (!SRI.test(normalized) && !COLON_SHA256.test(normalized) && !GIT_COMMIT.test(normalized) && !LOCAL_PACKAGE.test(normalized)) {
    fail(path, 'expected npm SRI, sha256:<hex>, an exact Git commit, or an exact local package')
  }
  return GIT_COMMIT.test(normalized) || COLON_SHA256.test(normalized)
    ? normalized.toLowerCase()
    : normalized
}

function identifier(value, path) {
  const normalized = nonEmptyString(value, path, 128)
  if (!RELEASE_ID.test(normalized)) fail(path, 'contains unsupported characters')
  return normalized
}

function packageName(value, path) {
  const normalized = nonEmptyString(value, path, 214)
  if (!PACKAGE_NAME.test(normalized)) fail(path, 'expected an npm package name')
  return normalized
}

function canonicalTimestamp(value, path) {
  const normalized = nonEmptyString(value, path, 64)
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime()) || date.toISOString() !== normalized) {
    fail(path, 'expected a canonical ISO-8601 UTC timestamp')
  }
  return normalized
}

function relativeArtifactPath(value, path) {
  const normalized = nonEmptyString(value, path, 512)
  if (
    normalized.includes('\\')
    || normalized.includes('\0')
    || normalized.includes(':')
    || posix.isAbsolute(normalized)
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || posix.normalize(normalized) !== normalized
  ) {
    fail(path, 'expected a normalized relative POSIX path without traversal')
  }
  return normalized
}

function validateDsh(value, releaseType) {
  const dsh = plainObject(value, 'dsh')
  exactKeys(dsh, ['version', 'source', 'integrity'], 'dsh')
  const source = nonEmptyString(dsh.source, 'dsh.source', 32)
  if (!['bundled', 'npm'].includes(source)) fail('dsh.source', 'expected bundled or npm')
  if (releaseType === 'bootstrap' && source !== 'bundled') fail('dsh.source', 'bootstrap releases must use the bundled runtime')
  if (releaseType === 'managed' && source !== 'npm') fail('dsh.source', 'managed releases must use an npm runtime')
  return {
    version: exactSemver(dsh.version, 'dsh.version'),
    source,
    integrity: packageIntegrity(dsh.integrity, 'dsh.integrity'),
  }
}

function validateProfile(value) {
  const profile = plainObject(value, 'profile')
  exactKeys(profile, ['logicalName', 'physicalName', 'manifestSha256', 'lockSha256', 'patchSha256'], 'profile')
  return {
    logicalName: identifier(profile.logicalName, 'profile.logicalName'),
    physicalName: identifier(profile.physicalName, 'profile.physicalName'),
    manifestSha256: sha256(profile.manifestSha256, 'profile.manifestSha256'),
    lockSha256: sha256(profile.lockSha256, 'profile.lockSha256'),
    patchSha256: sha256(profile.patchSha256, 'profile.patchSha256'),
  }
}

function exactGitHubRevision(resolved, path) {
  if (!resolved.startsWith('github:')) return
  const hash = resolved.indexOf('#')
  if (hash === -1 || !GIT_COMMIT.test(resolved.slice(hash + 1, hash + 41))) {
    fail(path, 'GitHub sources must resolve to an exact 40-character commit')
  }
  const suffix = resolved.slice(hash + 41)
  if (suffix === '') return
  if (!suffix.startsWith('&path:')) fail(path, 'GitHub commit may only be followed by a package path')
  const packagePath = suffix.slice('&path:'.length)
  if (
    !/^\/[A-Za-z0-9._\/-]+$/.test(packagePath)
    || packagePath.includes('/../')
    || packagePath.endsWith('/..')
    || posix.normalize(packagePath) !== packagePath
  ) {
    fail(path, 'GitHub package path must be normalized and cannot traverse')
  }
}

function validateBundles(value, channel) {
  if (!Array.isArray(value)) fail('bundles', 'expected an array')
  const seen = new Set()
  return value.map((entry, index) => {
    const path = `bundles[${String(index)}]`
    const bundle = plainObject(entry, path)
    exactKeys(bundle, ['name', 'resolved', 'integrityOrCommit'], path)
    const name = packageName(bundle.name, `${path}.name`)
    if (seen.has(name)) fail(`${path}.name`, `duplicate bundle ${name}`)
    seen.add(name)
    const resolved = nonEmptyString(bundle.resolved, `${path}.resolved`, 512)
    if (['stable', 'next'].includes(channel) && /^link:/i.test(resolved)) {
      fail(`${path}.resolved`, `${channel} releases cannot contain link: or file: dependencies`)
    }
    if (['stable', 'next'].includes(channel) && /^file:/i.test(resolved) && !/^file:\.\/packages\/[^/]+\.tgz$/i.test(resolved)) {
      fail(`${path}.resolved`, `${channel} releases cannot contain link: or file: dependencies outside packaged local .tgz artifacts`)
    }
    exactGitHubRevision(resolved, `${path}.resolved`)
    return {
      name,
      resolved,
      integrityOrCommit: bundleIntegrity(bundle.integrityOrCommit, `${path}.integrityOrCommit`),
    }
  })
}

function validateClientArtifacts(value) {
  if (!Array.isArray(value)) fail('clientArtifacts', 'expected an array')
  const seen = new Set()
  return value.map((entry, index) => {
    const itemPath = `clientArtifacts[${String(index)}]`
    const artifact = plainObject(entry, itemPath)
    exactKeys(artifact, ['path', 'sha256'], itemPath)
    const path = relativeArtifactPath(artifact.path, `${itemPath}.path`)
    if (seen.has(path)) fail(`${itemPath}.path`, `duplicate client artifact ${path}`)
    seen.add(path)
    return { path, sha256: sha256(artifact.sha256, `${itemPath}.sha256`) }
  })
}

function validateCompatibility(value) {
  const compatibility = plainObject(value, 'compatibility')
  exactKeys(compatibility, ['suiteVersion', 'reportSha256', 'passed'], 'compatibility')
  if (compatibility.passed !== true) fail('compatibility.passed', 'only a passed compatibility suite can describe a release')
  return {
    suiteVersion: identifier(compatibility.suiteVersion, 'compatibility.suiteVersion'),
    reportSha256: sha256(compatibility.reportSha256, 'compatibility.reportSha256'),
    passed: true,
  }
}

function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

export function validateReleaseManifest(value) {
  const manifest = plainObject(value, 'root')
  exactKeys(manifest, [
    'schemaVersion',
    'releaseId',
    'releaseType',
    'channel',
    'desktopVersion',
    'dsh',
    'profile',
    'bundles',
    'clientArtifacts',
    'compatibility',
    'createdAt',
  ], 'root')
  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) fail('schemaVersion', `expected ${String(RELEASE_MANIFEST_SCHEMA_VERSION)}`)
  const releaseType = nonEmptyString(manifest.releaseType, 'releaseType', 32)
  if (!RELEASE_TYPES.includes(releaseType)) fail('releaseType', 'expected bootstrap or managed')
  const channel = nonEmptyString(manifest.channel, 'channel', 32)
  if (!RELEASE_CHANNELS.includes(channel)) fail('channel', 'expected stable, next, or local')
  if (releaseType === 'bootstrap' && channel !== 'local') fail('channel', 'bootstrap releases must use the local channel')

  return deepFreeze({
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    releaseId: identifier(manifest.releaseId, 'releaseId'),
    releaseType,
    channel,
    desktopVersion: exactSemver(manifest.desktopVersion, 'desktopVersion'),
    dsh: validateDsh(manifest.dsh, releaseType),
    profile: validateProfile(manifest.profile),
    bundles: validateBundles(manifest.bundles, channel),
    clientArtifacts: validateClientArtifacts(manifest.clientArtifacts),
    compatibility: validateCompatibility(manifest.compatibility),
    createdAt: canonicalTimestamp(manifest.createdAt, 'createdAt'),
  })
}

export function serializeReleaseManifest(value) {
  return `${JSON.stringify(validateReleaseManifest(value), undefined, 2)}\n`
}

export function releaseManifestSha256(value) {
  return createHash('sha256').update(serializeReleaseManifest(value)).digest('hex')
}

/**
 * Give an already verified managed release a new immutable identity.
 *
 * Plugin transactions clone an active release before mutating its profile.
 * Keeping this operation beside the manifest validator makes the identity
 * rewrite canonical and prevents individual callers from accidentally
 * preserving the parent release id in a child directory.
 */
export function rebaseManagedReleaseManifest(value, { releaseId, createdAt } = {}) {
  const manifest = validateReleaseManifest(value)
  if (manifest.releaseType !== 'managed') fail('releaseType', 'only managed releases can be rebased')
  return validateReleaseManifest({
    ...manifest,
    releaseId,
    createdAt,
  })
}

export function createBootstrapReleaseManifest(options) {
  return validateReleaseManifest({
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    releaseId: options.releaseId,
    releaseType: 'bootstrap',
    channel: 'local',
    desktopVersion: options.desktopVersion,
    dsh: {
      version: options.dshVersion,
      source: 'bundled',
      integrity: options.dshIntegrity,
    },
    profile: options.profile,
    bundles: options.bundles,
    clientArtifacts: options.clientArtifacts,
    compatibility: options.compatibility,
    createdAt: options.createdAt,
  })
}

export function createManagedReleaseManifest(options) {
  const dsh = options.dsh ?? {
    version: options.dshVersion,
    source: 'npm',
    integrity: options.dshIntegrity,
  }
  return validateReleaseManifest({
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    releaseId: options.releaseId,
    releaseType: 'managed',
    channel: options.channel,
    desktopVersion: options.desktopVersion,
    dsh,
    profile: options.profile,
    bundles: options.bundles,
    clientArtifacts: options.clientArtifacts,
    compatibility: options.compatibility,
    createdAt: options.createdAt,
  })
}

export const createCandidateReleaseManifest = createManagedReleaseManifest
