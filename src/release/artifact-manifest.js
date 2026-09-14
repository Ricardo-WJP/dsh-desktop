import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  posix,
} from 'node:path'

export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1
export const RELEASE_EVIDENCE_SCHEMA_VERSION = 1
export const CYCLONEDX_SPEC_VERSION = '1.5'

const SHA256 = /^[a-f0-9]{64}$/i
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SRI = /^sha(1|256|384|512)-([A-Za-z0-9+/]+={0,2})$/i
const PRIVATE_KEY_MARKER = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i
const SECRET_FIELD_TEXT = /(?:private|secret|token|password|passwd|credential|authorization|api[_-]?key|access[_-]?key)\s*[:=]/i
const SECRET_FIELD = /private|secret|token|password|passwd|credential|authorization|api[_-]?key|access[_-]?key/i
const PRIVATE_JWK_FIELD = /^(?:d|p|q|dp|dq|qi|oth)$/i

function compareStrings(left, right) {
  const a = String(left)
  const b = String(right)
  return a < b ? -1 : a > b ? 1 : 0
}

export class ReleaseEvidenceError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'ReleaseEvidenceError'
  }
}

function fail(message) {
  throw new ReleaseEvidenceError(message)
}

function assertString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.includes('\0')) {
    fail(`${label} must be a non-empty string without NUL`)
  }
  return value
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  return value
}

function assertSha256(value, label) {
  const normalized = assertString(value, label)
  if (!SHA256.test(normalized)) fail(`${label} must be a SHA-256 hex digest`)
  return normalized.toLowerCase()
}

function canonicalize(value, path = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number`)
    return value
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
    fail(`${path} contains a value that cannot be represented in canonical JSON`)
  }
  if (Array.isArray(value)) return value.map((child, index) => canonicalize(child, `${path}[${String(index)}]`))
  if (typeof value === 'object') {
    const result = {}
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key], `${path}.${key}`)
    return result
  }
  fail(`${path} contains an unsupported value`)
}

/** Serialize JSON with sorted object keys and a stable trailing newline. */
export function serializeCanonicalJson(value) {
  return `${JSON.stringify(canonicalize(value))}\n`
}

export function sha256Bytes(value) {
  if (!(typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    fail('sha256Bytes input must be text or bytes')
  }
  return createHash('sha256').update(value).digest('hex')
}

function normalizeRelativePath(value, label, { allowGlob = false } = {}) {
  const raw = assertString(value, label)
  if (
    raw.includes('\\')
    || raw.includes(':')
    || raw.includes('\0')
    || isAbsolute(raw)
    || posix.isAbsolute(raw)
    || raw === '.'
    || raw === '..'
    || raw.startsWith('../')
    || raw.includes('/../')
    || posix.normalize(raw) !== raw
  ) {
    fail(`${label} must be a normalized relative POSIX path`)
  }
  if (!allowGlob && /[*?]/.test(raw)) fail(`${label} cannot contain glob metacharacters`)
  return raw
}

function normalizeExclusions(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('exclusions must be an array')
  return [...new Set(value.map((item, index) => normalizeRelativePath(item, `exclusions[${String(index)}]`, { allowGlob: true })))].sort()
}

function normalizeRequiredArtifacts(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('requiredArtifacts must be an array')
  return [...new Set(value.map((item, index) => normalizeRelativePath(item, `requiredArtifacts[${String(index)}]`)))].sort()
}

function globRegExp(pattern) {
  let expression = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      expression += '.*'
      index += 1
    } else if (character === '*') {
      expression += '[^/]*'
    } else if (character === '?') {
      expression += '[^/]'
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${expression}$`)
}

function isExcluded(relativePath, exclusions) {
  return exclusions.some(pattern => {
    if (!pattern.includes('*') && !pattern.includes('?')) {
      return relativePath === pattern || relativePath.startsWith(`${pattern}/`)
    }
    if (relativePath === pattern) return true
    if (pattern.endsWith('/**') && relativePath === pattern.slice(0, -3)) return true
    return globRegExp(pattern).test(relativePath)
  })
}

function unsafeEntryReason(stats) {
  if (typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) return 'symbolic link'
  if (typeof stats.isReparsePoint === 'function' && stats.isReparsePoint()) return 'reparse point'
  if (stats.reparsePoint === true) return 'reparse point'
  return null
}

function ensureWithin(root, target, label) {
  const relativePath = relative(root, target)
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    fail(`${label} escapes the explicit staging root`)
  }
  return relativePath.split(sep).join('/')
}

async function checkedLstat(filePath, label) {
  let stats
  try {
    stats = await lstat(filePath)
  } catch (error) {
    throw new ReleaseEvidenceError(`Cannot inspect ${label}`, { cause: error })
  }
  const unsafe = unsafeEntryReason(stats)
  if (unsafe) fail(`${label} is an unsupported ${unsafe}`)
  return stats
}

async function checkedStagingRoot(stagingRoot) {
  const input = resolve(assertString(stagingRoot, 'stagingRoot'))
  const stats = await checkedLstat(input, 'stagingRoot')
  if (!stats.isDirectory()) fail('stagingRoot must be a directory')
  const canonical = await realpath(input)
  const canonicalStats = await checkedLstat(canonical, 'stagingRoot')
  if (!canonicalStats.isDirectory()) fail('stagingRoot must resolve to a directory')
  return { input, canonical }
}

function sameFileIdentity(before, after) {
  for (const key of ['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev']) {
    if (before[key] !== undefined && after[key] !== undefined && before[key] !== after[key]) return false
  }
  return true
}

async function hashRegularFile(filePath, label) {
  const before = await checkedLstat(filePath, label)
  if (!before.isFile()) fail(`${label} must be a regular file`)

  const hash = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of createReadStream(filePath, { flags: 'r' })) {
      bytes += chunk.length
      hash.update(chunk)
    }
  } catch (error) {
    throw new ReleaseEvidenceError(`Cannot read ${label}`, { cause: error })
  }

  const after = await checkedLstat(filePath, label)
  if (!after.isFile() || !sameFileIdentity(before, after) || bytes !== before.size) {
    fail(`${label} changed while it was being hashed`)
  }
  return { bytes, sha256: hash.digest('hex') }
}

async function collectStagedArtifacts(stagingRoot, options = {}) {
  const { canonical } = await checkedStagingRoot(stagingRoot)
  const exclusions = normalizeExclusions(options.exclude ?? options.exclusions)
  const requiredArtifacts = normalizeRequiredArtifacts(options.requiredArtifacts)
  const artifacts = []

  async function walk(directory, relativeDirectory) {
    let names
    try {
      names = await readdir(directory)
    } catch (error) {
      throw new ReleaseEvidenceError(`Cannot enumerate staging directory ${relativeDirectory || '.'}`, { cause: error })
    }
    names.sort()

    for (const name of names) {
      const candidate = join(directory, name)
      const stats = await checkedLstat(candidate, `staging entry ${name}`)
      const candidateCanonical = await realpath(candidate)
      const relativeCandidate = ensureWithin(canonical, candidateCanonical, `staging entry ${name}`)
      if (relativeCandidate === '') fail(`staging entry ${name} resolves to the staging root`)

      // Inspect excluded directories too. This keeps the unsafe-entry policy
      // fail-closed while the explicit exclusion still removes their files.
      if (stats.isDirectory()) {
        await walk(candidate, relativeCandidate)
        continue
      }
      if (!stats.isFile()) fail(`staging entry ${relativeCandidate} is not a regular file or directory`)
      if (isExcluded(relativeCandidate, exclusions)) continue

      const digest = await hashRegularFile(candidate, `staging file ${relativeCandidate}`)
      artifacts.push({ path: relativeCandidate, bytes: digest.bytes, sha256: digest.sha256 })
    }
  }

  await walk(canonical, '')
  artifacts.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  for (const required of requiredArtifacts) {
    if (!artifacts.some(artifact => artifact.path === required)) fail(`required artifact is missing: ${required}`)
  }

  return {
    schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    kind: 'artifact-manifest',
    hashAlgorithm: 'sha256',
    exclusions,
    requiredArtifacts,
    artifacts,
    fileCount: artifacts.length,
    totalBytes: artifacts.reduce((total, artifact) => total + artifact.bytes, 0),
  }
}

export async function createArtifactManifest(options = {}) {
  if (options.stagingRoot === undefined) fail('stagingRoot is required; refusing implicit runtime scanning')
  return collectStagedArtifacts(options.stagingRoot, options)
}

export const buildArtifactManifest = createArtifactManifest

export function serializeArtifactManifest(manifest) {
  assertPlainObject(manifest, 'artifact manifest')
  if (manifest.schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION) fail('artifact manifest has an unsupported schemaVersion')
  return serializeCanonicalJson(manifest)
}

export function artifactManifestSha256(manifest) {
  return sha256Bytes(serializeArtifactManifest(manifest))
}

async function readRegularFile(filePath, label) {
  const digest = await hashRegularFile(resolve(assertString(filePath, label)), label)
  let bytes
  try {
    bytes = await readFile(resolve(filePath))
  } catch (error) {
    throw new ReleaseEvidenceError(`Cannot read ${label}`, { cause: error })
  }
  if (bytes.length !== digest.bytes || sha256Bytes(bytes) !== digest.sha256) fail(`${label} changed while it was being read`)
  return { ...digest, bytes }
}

async function readJsonInput(filePath, label) {
  const file = await readRegularFile(filePath, label)
  let value
  try {
    value = JSON.parse(file.bytes.toString('utf8'))
  } catch (error) {
    throw new ReleaseEvidenceError(`${label} is not valid JSON`, { cause: error })
  }
  return { value, file }
}

function packageNameFromPath(packagePath) {
  const parts = packagePath.split('/')
  const nodeModulesIndex = parts.lastIndexOf('node_modules')
  if (nodeModulesIndex === -1) return null
  const first = parts[nodeModulesIndex + 1]
  if (!first) return null
  if (first.startsWith('@')) {
    const second = parts[nodeModulesIndex + 2]
    return second ? `${first}/${second}` : null
  }
  return first
}

function exactPackageVersion(value, label) {
  const version = assertString(value, label)
  if (!EXACT_VERSION.test(version)) fail(`${label} must be an exact resolved version`)
  return version
}

function assertPackageName(value, label) {
  const name = assertString(value, label)
  if (!NPM_PACKAGE_NAME.test(name)) fail(`${label} must be a valid npm package name`)
  return name
}

function addLockRecord(records, name, entry, label) {
  assertPlainObject(entry, label)
  if (entry.link === true) fail(`${label} is a link and has no immutable exact package version`)
  if (entry.version === undefined) fail(`${label} has no exact package version`)
  const normalizedName = assertPackageName(name, `${label}.name`)
  const version = exactPackageVersion(entry.version, `${label}.version`)
  records.push({ name: normalizedName, version, entry, label })
}

function lockRecords(lock) {
  assertPlainObject(lock, 'package-lock.json')
  if (![1, 2, 3].includes(lock.lockfileVersion)) fail('package-lock.json has an unsupported lockfileVersion')
  const records = []

  if (lock.packages !== undefined) {
    assertPlainObject(lock.packages, 'package-lock.json.packages')
    for (const packagePath of Object.keys(lock.packages).sort()) {
      if (packagePath === '') continue
      const entry = lock.packages[packagePath]
      const name = entry?.name ?? packageNameFromPath(packagePath)
      if (!name) {
        // Workspace metadata outside node_modules is not a third-party
        // component unless it explicitly identifies itself as a package.
        if (entry?.version !== undefined) fail(`package-lock.json.packages.${packagePath} has no package name`)
        continue
      }
      addLockRecord(records, name, entry, `package-lock.json.packages.${packagePath}`)
    }
  } else if (lock.dependencies !== undefined) {
    function visit(dependencies, prefix) {
      assertPlainObject(dependencies, `${prefix}.dependencies`)
      for (const name of Object.keys(dependencies).sort()) {
        const entry = dependencies[name]
        addLockRecord(records, name, entry, `${prefix}.dependencies.${name}`)
        if (entry.dependencies !== undefined) visit(entry.dependencies, `${prefix}.dependencies.${name}`)
      }
    }
    visit(lock.dependencies, 'package-lock.json')
  } else {
    fail('package-lock.json has neither packages nor dependencies')
  }
  return records
}

function evidenceString(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) return null
  return value.trim()
}

function licenseEvidence(source) {
  const values = []
  const append = value => {
    if (typeof value === 'string') {
      const name = evidenceString(value, 'license')
      if (name) values.push({ license: { name } })
      return
    }
    if (value === null || typeof value !== 'object') return
    const id = evidenceString(value.id, 'license.id')
    const name = evidenceString(value.name ?? value.type, 'license.name')
    const url = evidenceString(value.url, 'license.url')
    if (id) values.push({ license: { id } })
    else if (name) values.push({ license: { name } })
    else if (url) values.push({ license: { url } })
  }
  append(source.license)
  if (Array.isArray(source.licenses)) for (const value of source.licenses) append(value)
  const seen = new Set()
  return values.filter(value => {
    const key = serializeCanonicalJson(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((left, right) => compareStrings(serializeCanonicalJson(left), serializeCanonicalJson(right)))
}

function evidenceUrl(value) {
  const text = evidenceString(value, 'external reference')
  if (!text || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return null
  return text
}

function repositoryUrl(value) {
  if (typeof value === 'string') return evidenceUrl(value)
  if (value && typeof value === 'object') return evidenceUrl(value.url ?? value.directory)
  return null
}

function externalReferences(source) {
  const references = []
  const resolved = evidenceUrl(source.resolved)
  if (resolved) references.push({ type: 'distribution', url: resolved })
  const repository = repositoryUrl(source.repository)
  if (repository) references.push({ type: 'vcs', url: repository })
  const homepage = evidenceUrl(source.homepage)
  if (homepage) references.push({ type: 'website', url: homepage })
  const seen = new Set()
  return references.filter(reference => {
    const key = `${reference.type}\0${reference.url}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((left, right) => compareStrings(left.type, right.type) || compareStrings(left.url, right.url))
}

function integrityHashes(value, label) {
  if (value === undefined) return []
  const integrity = assertString(value, label)
  const tokens = integrity.trim().split(/\s+/)
  if (tokens.length === 0 || tokens.some(token => !SRI.test(token))) fail(`${label} is not a supported npm integrity value`)
  return tokens.map(token => {
    const match = token.match(SRI)
    return {
      alg: `SHA-${match[1] === '1' ? '1' : match[1]}`,
      content: match[2],
    }
  }).sort((left, right) => compareStrings(left.alg, right.alg) || compareStrings(left.content, right.content))
}

function npmPurl(name, version) {
  const encodedName = name.startsWith('@') ? `%40${name.slice(1)}` : name
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`
}

function enrichComponent(component, source) {
  const licenses = licenseEvidence(source)
  if (licenses.length > 0) component.licenses = licenses
  const hashes = integrityHashes(source.integrity, 'package integrity')
  if (hashes.length > 0) component.hashes = hashes
  const references = externalReferences(source)
  if (references.length > 0) component.externalReferences = references
  return component
}

function componentFromRecord(record) {
  return enrichComponent({
    'bom-ref': npmPurl(record.name, record.version),
    type: 'library',
    name: record.name,
    version: record.version,
  }, record.entry)
}

function rootComponent(packageJson, rootLockEntry) {
  const component = {
    type: 'application',
    name: assertPackageName(packageJson.name, 'package.json.name'),
    version: exactPackageVersion(packageJson.version, 'package.json.version'),
  }
  const source = {
    ...(rootLockEntry ?? {}),
    ...packageJson,
  }
  return enrichComponent(component, source)
}

function deduplicateComponents(components) {
  const byRef = new Map()
  for (const component of components) {
    const ref = component['bom-ref']
    const existing = byRef.get(ref)
    if (!existing) {
      byRef.set(ref, component)
      continue
    }
    // A lock can repeat the same exact package at multiple paths. Merge only
    // evidence that was explicitly present; never synthesize metadata.
    for (const field of ['licenses', 'hashes', 'externalReferences']) {
      const values = [...(existing[field] ?? []), ...(component[field] ?? [])]
      if (values.length === 0) continue
      const unique = new Map(values.map(value => [serializeCanonicalJson(value), value]))
      existing[field] = [...unique.values()].sort((left, right) => compareStrings(serializeCanonicalJson(left), serializeCanonicalJson(right)))
    }
  }
  return [...byRef.values()].sort((left, right) => {
    return compareStrings(left.name, right.name) || compareStrings(left.version, right.version) || compareStrings(left['bom-ref'], right['bom-ref'])
  })
}

export async function createCycloneDxSbom(options = {}) {
  if (options.packageLockPath === undefined || options.packageJsonPath === undefined) {
    fail('packageLockPath and packageJsonPath are required; package metadata must be explicit')
  }
  const [lockInput, packageInput] = await Promise.all([
    readJsonInput(options.packageLockPath, 'package-lock.json'),
    readJsonInput(options.packageJsonPath, 'package.json'),
  ])
  const lock = lockInput.value
  const packageJson = packageInput.value
  assertPlainObject(packageJson, 'package.json')
  const rootLockEntry = lock?.packages?.['']
  if (rootLockEntry?.name !== undefined && rootLockEntry.name !== packageJson.name) fail('package-lock.json root name does not match package.json')
  if (rootLockEntry?.version !== undefined && rootLockEntry.version !== packageJson.version) fail('package-lock.json root version does not match package.json')

  const records = lockRecords(lock)
  const components = deduplicateComponents(records.map(componentFromRecord))
  const dependencyGroups = [packageJson.dependencies, packageJson.devDependencies, packageJson.optionalDependencies]
  const directDependencies = new Set()
  for (const group of dependencyGroups) {
    if (group === undefined) continue
    assertPlainObject(group, 'package.json dependency group')
    for (const name of Object.keys(group)) directDependencies.add(assertPackageName(name, 'package.json dependency name'))
  }
  for (const name of directDependencies) {
    if (!components.some(component => component.name === name)) fail(`package-lock.json has no exact entry for package.json dependency ${name}`)
  }

  return {
    bomFormat: 'CycloneDX',
    specVersion: CYCLONEDX_SPEC_VERSION,
    version: 1,
    metadata: {
      component: rootComponent(packageJson, rootLockEntry),
    },
    components,
  }
}

export const generateCycloneDxSbom = createCycloneDxSbom

function markdownValue(value) {
  return String(value).replaceAll('`', '\\`').replaceAll('\r', ' ').replaceAll('\n', ' ')
}

export function createThirdPartyNotices(sbom) {
  assertPlainObject(sbom, 'sbom')
  if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components)) fail('sbom is not a CycloneDX component list')
  const components = [...sbom.components].sort((left, right) => {
    return compareStrings(left.name, right.name) || compareStrings(left.version, right.version)
  })
  const lines = [
    '# Third-party notices',
    '',
    'Generated only from the explicitly supplied package-lock.json and package.json evidence. License and source values are not inferred.',
    '',
  ]
  for (const component of components) {
    lines.push(`## ${markdownValue(component.name)}@${markdownValue(component.version)}`)
    const licenses = (component.licenses ?? []).map(entry => entry.license ?? {}).map(license => license.id ?? license.name ?? license.url).filter(Boolean)
    if (licenses.length > 0) lines.push(`- License: ${licenses.map(markdownValue).join(', ')}`)
    else lines.push('- License: no license evidence was supplied.')
    const sources = (component.externalReferences ?? []).filter(reference => ['vcs', 'website'].includes(reference.type)).map(reference => reference.url)
    if (sources.length > 0) lines.push(`- Source: ${sources.map(markdownValue).join(', ')}`)
    const distributions = (component.externalReferences ?? []).filter(reference => reference.type === 'distribution').map(reference => reference.url)
    if (distributions.length > 0) lines.push(`- Distribution evidence: ${distributions.map(markdownValue).join(', ')}`)
    lines.push('')
  }
  return `${lines.join('\n')}`
}

export const generateThirdPartyNotices = createThirdPartyNotices

function assertNoSecretLikeFields(value, path = 'value') {
  if (typeof value === 'string') {
    if (PRIVATE_KEY_MARKER.test(value) || /private(?:[ _-]?key|[ _-]?material)/i.test(value) || SECRET_FIELD_TEXT.test(value)) {
      fail(`${path} contains private key or secret material`)
    }
    return
  }
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoSecretLikeFields(child, `${path}[${String(index)}]`))
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key) || PRIVATE_JWK_FIELD.test(key)) fail(`${path}.${key} is a private or secret field`)
    assertNoSecretLikeFields(child, `${path}.${key}`)
  }
}

function publicVerificationKey(value) {
  if (value === undefined || value === null) return null
  assertPlainObject(value, 'publicVerificationKey')
  assertNoSecretLikeFields(value, 'publicVerificationKey')
  const keys = Object.keys(value)
  const allowed = new Set(['id', 'keyId', 'material', 'algorithm'])
  for (const key of keys) if (!allowed.has(key)) fail(`publicVerificationKey.${key} is not allowed`)
  const id = assertString(value.id ?? value.keyId, 'publicVerificationKey.id')
  const material = value.material
  if (typeof material !== 'string' && (material === null || typeof material !== 'object' || Array.isArray(material))) {
    fail('publicVerificationKey.material must be public text or a public JSON object')
  }
  if (typeof material === 'string' && material.trim() === '') fail('publicVerificationKey.material must not be empty')
  if (typeof value.algorithm !== 'undefined') assertString(value.algorithm, 'publicVerificationKey.algorithm')
  return {
    id,
    material: typeof material === 'string' ? material : canonicalize(material, 'publicVerificationKey.material'),
    ...(value.algorithm === undefined ? {} : { algorithm: value.algorithm }),
  }
}

function signatureBytes(value, label = 'detachedSignature') {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string' && value.length > 0) return Buffer.from(value)
  fail(`${label} must be non-empty detached signature bytes`)
}

async function resolveDetachedSignature(options) {
  if (options.detachedSignaturePath !== undefined) {
    const file = await readRegularFile(options.detachedSignaturePath, 'detached signature')
    return file.bytes
  }
  if (options.detachedSignature !== undefined) return signatureBytes(options.detachedSignature)
  return null
}

async function verifyWithAdapter({ data, signature, key, verifier }) {
  let result
  try {
    if (typeof verifier === 'function') {
      result = await verifier({
        data: Buffer.from(data),
        signature: Buffer.from(signature),
        publicVerificationKey: structuredClone(key),
      })
    } else {
      if (key.algorithm !== undefined && key.algorithm.toLowerCase() !== 'ed25519') {
        fail(`unsupported built-in signature algorithm: ${key.algorithm}`)
      }
      const publicKey = createPublicKey({
        key: key.material,
        ...(typeof key.material === 'object' ? { format: 'jwk' } : {}),
      })
      if (publicKey.asymmetricKeyType !== 'ed25519') fail('public verification key must be Ed25519')
      result = verifySignature(null, Buffer.from(data), publicKey, Buffer.from(signature))
    }
  } catch (error) {
    if (error instanceof ReleaseEvidenceError) throw error
    throw new ReleaseEvidenceError('detached signature verifier failed closed', { cause: error })
  }
  const valid = result === true || (result !== null && typeof result === 'object' && result.valid === true)
  if (!valid) fail('detached signature verification failed')
}

/** Verify a detached signature over caller-provided canonical bytes. */
export async function verifyDetachedSignature({ data, detachedSignature, publicVerificationKey: keyInput, verifier }) {
  const key = publicVerificationKey(keyInput)
  if (!key) fail('publicVerificationKey is required for detached signature verification')
  const signature = signatureBytes(detachedSignature)
  const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data ?? [])
  await verifyWithAdapter({ data: bytes, signature, key, verifier })
  return true
}

function unsignedEvidence(evidence) {
  return {
    ...evidence,
    signing: { status: 'unsigned' },
  }
}

async function signingResult(baseEvidence, options) {
  const signature = await resolveDetachedSignature(options)
  const key = publicVerificationKey(options.publicVerificationKey)
  if (!signature && !key) return { status: 'unsigned' }
  if (!signature || !key) fail('signature and publicVerificationKey must be supplied together')
  const payload = serializeCanonicalJson(unsignedEvidence(baseEvidence))
  await verifyWithAdapter({ data: payload, signature, key, verifier: options.signatureVerifier })
  return {
    status: 'signed',
    signatureSha256: sha256Bytes(signature),
    publicVerificationKey: key,
  }
}

function artifactForPath(manifest, path, label) {
  const normalized = normalizeRelativePath(path, label)
  const artifact = manifest.artifacts.find(item => item.path === normalized)
  if (!artifact) fail(`${label} is missing from the artifact manifest: ${normalized}`)
  return artifact
}

function outputFileName(filePath, label) {
  const name = basename(resolve(assertString(filePath, label)))
  if (!name || name === '.' || name === '..') fail(`${label} has no safe file name`)
  return name
}

export async function generateReleaseEvidence(options = {}) {
  const required = ['stagingRoot', 'packageLockPath', 'packageJsonPath', 'releaseManifestPath', 'setupPath', 'portablePath']
  for (const key of required) if (options[key] === undefined) fail(`${key} is required and must be an explicit path`)
  const setupPath = normalizeRelativePath(options.setupPath, 'setupPath')
  const portablePath = normalizeRelativePath(options.portablePath, 'portablePath')
  if (setupPath === portablePath) fail('setupPath and portablePath must identify different artifacts')
  const additionalRequired = options.requiredArtifacts ?? []
  if (!Array.isArray(additionalRequired)) fail('requiredArtifacts must be an array')

  const artifactManifest = await createArtifactManifest({
    stagingRoot: options.stagingRoot,
    exclude: options.exclude ?? options.exclusions,
    requiredArtifacts: [...additionalRequired, setupPath, portablePath],
  })
  const sbom = await createCycloneDxSbom({
    packageLockPath: options.packageLockPath,
    packageJsonPath: options.packageJsonPath,
  })
  const notices = createThirdPartyNotices(sbom)
  const releaseManifestFile = await readRegularFile(options.releaseManifestPath, 'release manifest')
  const setup = artifactForPath(artifactManifest, setupPath, 'setupPath')
  const portable = artifactForPath(artifactManifest, portablePath, 'portablePath')
  const baseEvidence = {
    schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
    artifactManifest: {
      file: 'artifact-manifest.json',
      sha256: artifactManifestSha256(artifactManifest),
    },
    artifacts: [
      { kind: 'desktop-setup', path: setup.path, bytes: setup.bytes, sha256: setup.sha256 },
      { kind: 'desktop-portable', path: portable.path, bytes: portable.bytes, sha256: portable.sha256 },
    ],
    sbom: {
      file: 'bom.cdx.json',
      sha256: sha256Bytes(serializeCanonicalJson(sbom)),
    },
    notices: {
      file: 'THIRD-PARTY-NOTICES.md',
      sha256: sha256Bytes(Buffer.from(notices, 'utf8')),
    },
    releaseManifest: {
      file: outputFileName(options.releaseManifestPath, 'releaseManifestPath'),
      sha256: releaseManifestFile.sha256,
    },
  }
  if (options.releaseId !== undefined) {
    const releaseId = assertString(options.releaseId, 'releaseId')
    if (!RELEASE_ID.test(releaseId)) fail('releaseId contains unsupported characters')
    baseEvidence.releaseId = releaseId
  }
  return {
    artifactManifest,
    sbom,
    notices,
    evidence: {
      ...baseEvidence,
      signing: await signingResult(baseEvidence, options),
    },
  }
}

export const buildReleaseEvidence = generateReleaseEvidence

function assertEvidenceShape(evidence) {
  assertPlainObject(evidence, 'release-evidence')
  if (evidence.schemaVersion !== RELEASE_EVIDENCE_SCHEMA_VERSION) fail('release-evidence has an unsupported schemaVersion')
  if (!Array.isArray(evidence.artifacts) || evidence.artifacts.length !== 2) fail('release-evidence must list setup and portable artifacts')
  const kinds = new Set(evidence.artifacts.map(artifact => artifact?.kind))
  if (!kinds.has('desktop-setup') || !kinds.has('desktop-portable')) fail('release-evidence is missing setup or portable artifact')
  if (!evidence.artifactManifest || !evidence.sbom || !evidence.notices || !evidence.releaseManifest || !evidence.signing) fail('release-evidence is incomplete')
}

function outputSibling(basePath, fileName, label) {
  const base = resolve(assertString(basePath, label))
  const candidate = resolve(dirname(base), fileName)
  const rel = relative(dirname(base), candidate)
  if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`${label} escapes the evidence output directory`)
  return candidate
}

async function readCanonicalJsonFile(filePath, label) {
  const file = await readRegularFile(filePath, label)
  let value
  try {
    value = JSON.parse(file.bytes.toString('utf8'))
  } catch (error) {
    throw new ReleaseEvidenceError(`${label} is not valid JSON`, { cause: error })
  }
  if (serializeCanonicalJson(value) !== file.bytes.toString('utf8')) fail(`${label} is not canonical JSON`)
  return { value, file }
}

export async function verifyReleaseEvidence(options = {}) {
  const evidenceInput = options.evidencePath !== undefined
    ? (await readCanonicalJsonFile(options.evidencePath, 'release-evidence.json')).value
    : options.evidence
  assertEvidenceShape(evidenceInput)

  const artifactManifestPath = options.artifactManifestPath ?? (options.evidencePath !== undefined
    ? outputSibling(options.evidencePath, evidenceInput.artifactManifest.file, 'artifact manifest path')
    : undefined)
  const sbomPath = options.sbomPath ?? (options.evidencePath !== undefined
    ? outputSibling(options.evidencePath, evidenceInput.sbom.file, 'SBOM path')
    : undefined)
  const noticesPath = options.noticesPath ?? (options.evidencePath !== undefined
    ? outputSibling(options.evidencePath, evidenceInput.notices.file, 'notices path')
    : undefined)
  if (!artifactManifestPath || !sbomPath || !noticesPath || options.releaseManifestPath === undefined || options.stagingRoot === undefined) {
    fail('stagingRoot, releaseManifestPath, artifactManifestPath, sbomPath and noticesPath are required for evidence verification')
  }

  const artifactInput = await readCanonicalJsonFile(artifactManifestPath, 'artifact-manifest.json')
  const artifactManifest = artifactInput.value
  const artifactHash = artifactManifestSha256(artifactManifest)
  if (artifactHash !== assertSha256(evidenceInput.artifactManifest.sha256, 'release-evidence.artifactManifest.sha256')) fail('artifact manifest hash mismatch')
  const currentManifest = await createArtifactManifest({
    stagingRoot: options.stagingRoot,
    exclude: artifactManifest.exclusions,
    requiredArtifacts: artifactManifest.requiredArtifacts,
  })
  if (serializeArtifactManifest(currentManifest) !== artifactInput.file.bytes.toString('utf8')) fail('staging content does not match artifact manifest')

  for (const expected of evidenceInput.artifacts) {
    const artifact = artifactManifest.artifacts.find(item => item.path === normalizeRelativePath(expected.path, 'release-evidence artifact path'))
    if (!artifact || artifact.bytes !== expected.bytes || artifact.sha256 !== assertSha256(expected.sha256, 'release-evidence artifact.sha256')) fail(`release artifact verification failed for ${String(expected.path)}`)
  }

  const sbomInput = await readCanonicalJsonFile(sbomPath, 'SBOM')
  if (sha256Bytes(sbomInput.file.bytes) !== assertSha256(evidenceInput.sbom.sha256, 'release-evidence.sbom.sha256')) fail('SBOM hash mismatch')
  const noticesInput = await readRegularFile(noticesPath, 'third-party notices')
  if (sha256Bytes(noticesInput.bytes) !== assertSha256(evidenceInput.notices.sha256, 'release-evidence.notices.sha256')) fail('third-party notices hash mismatch')
  const releaseManifest = await readRegularFile(options.releaseManifestPath, 'release manifest')
  if (releaseManifest.sha256 !== assertSha256(evidenceInput.releaseManifest.sha256, 'release-evidence.releaseManifest.sha256')) fail('release manifest hash mismatch')

  const status = evidenceInput.signing.status
  if (status === 'unsigned') {
    if (Object.keys(evidenceInput.signing).some(key => key !== 'status')) fail('unsigned evidence must not carry signing material')
    if (options.detachedSignature !== undefined || options.detachedSignaturePath !== undefined || options.publicVerificationKey !== undefined) {
      fail('unsigned evidence cannot be verified with detached signing material')
    }
    return true
  }
  if (status !== 'signed') fail('signing.status must be signed or unsigned')
  const embeddedKey = publicVerificationKey(evidenceInput.signing.publicVerificationKey)
  if (!embeddedKey) fail('signed evidence must carry a public verification key')
  const trustedKey = publicVerificationKey(options.publicVerificationKey)
  if (!trustedKey) fail('signed evidence verification requires an explicit trusted publicVerificationKey')
  if (serializeCanonicalJson(embeddedKey) !== serializeCanonicalJson(trustedKey)) {
    fail('embedded public verification key does not match the trusted key')
  }
  const signature = await resolveDetachedSignature(options)
  if (!signature) fail('signed evidence requires detached signature bytes')
  if (sha256Bytes(signature) !== assertSha256(evidenceInput.signing.signatureSha256, 'release-evidence.signing.signatureSha256')) fail('detached signature hash mismatch')
  await verifyWithAdapter({
    data: serializeCanonicalJson(unsignedEvidence(evidenceInput)),
    signature,
    key: trustedKey,
    verifier: options.signatureVerifier,
  })
  return true
}

export async function writeReleaseEvidence(options = {}) {
  if (options.outputDir === undefined) fail('outputDir is required and must be explicit')
  const outputDir = resolve(assertString(options.outputDir, 'outputDir'))
  const stagingRoot = resolve(assertString(options.stagingRoot, 'stagingRoot'))
  const outputRelative = relative(stagingRoot, outputDir)
  if (outputRelative === '' || (!outputRelative.startsWith(`..${sep}`) && !isAbsolute(outputRelative))) {
    fail('outputDir must be outside stagingRoot so generated evidence cannot self-invalidate')
  }
  const result = await generateReleaseEvidence(options)
  await mkdir(outputDir, { recursive: true })
  const paths = {
    artifactManifestPath: join(outputDir, 'artifact-manifest.json'),
    sbomPath: join(outputDir, 'bom.cdx.json'),
    noticesPath: join(outputDir, 'THIRD-PARTY-NOTICES.md'),
    evidencePath: join(outputDir, 'release-evidence.json'),
  }
  await writeFile(paths.artifactManifestPath, serializeArtifactManifest(result.artifactManifest), 'utf8')
  await writeFile(paths.sbomPath, serializeCanonicalJson(result.sbom), 'utf8')
  await writeFile(paths.noticesPath, result.notices, 'utf8')
  await writeFile(paths.evidencePath, serializeCanonicalJson(result.evidence), 'utf8')
  return { ...result, paths }
}
