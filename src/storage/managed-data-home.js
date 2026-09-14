import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

/*
 * Electron's patched fs layer treats an asar archive as a virtual directory.
 * The managed-data boundary is outside the application bundle, but a
 * candidate can legitimately contain an asar file such as
 * electron/resources/default_app.asar. Select original-fs in Electron so
 * copy/hash/list operations never enter the asar virtual filesystem. In a
 * normal Node test/runtime, node:fs is already the native implementation.
 * No process.noAsar mutation is used because migration is asynchronous and
 * must not change fs behavior for other operations in the process.
 */
const nativeRequire = createRequire(import.meta.url)
const selectedFs = process.versions.electron === undefined
  ? nativeRequire('node:fs')
  : nativeRequire('original-fs')
const selectedFsPromises = selectedFs.promises

if (selectedFsPromises === undefined) {
  throw new Error('Electron original-fs does not expose fs.promises')
}

const {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} = selectedFs
const {
  copyFile: copyFileAsync,
  lstat: lstatAsync,
  mkdir: mkdirAsync,
  open: openAsync,
  readFile: readFileAsync,
  readdir: readdirAsync,
  realpath: realpathAsync,
  rename: renameAsync,
  rm: rmAsync,
  unlink: unlinkAsync,
} = selectedFsPromises

/**
 * The managed data pointer is deliberately a pointer to a fixed sibling of
 * the runtime root. It is not a user-data symlink and it never accepts an
 * arbitrary path from a candidate or from a persisted file.
 */
export const MANAGED_DATA_SCHEMA_VERSION = 1
export const MANAGED_DATA_HOME_FILE = 'data-home.json'
export const MANAGED_DATA_JOURNAL_FILE = 'data-home.journal.json'
export const MANAGED_DATA_STAGING_PREFIX = '.user-data-staging-'
export const MANAGED_DATA_HOME_DIRECTORY = 'user-data'
export const MANAGED_DATA_PROJECTION_BACKUP_DIRECTORY = 'projection-backups'
export const MANAGED_DATA_EXCLUDED_ROOTS = Object.freeze([
  'manifest.json',
  'profile',
  'profiles',
  'runtime',
  'artifacts',
])
export const MANAGED_DATA_STRUCTURAL_DIRECTORIES = Object.freeze(['profiles'])

// These aliases make the public names readable to callers that use the
// longer terminology, while the on-disk schema remains one versioned format.
export const MANAGED_DATA_HOME_SCHEMA_VERSION = MANAGED_DATA_SCHEMA_VERSION
export const DATA_HOME_SCHEMA_VERSION = MANAGED_DATA_SCHEMA_VERSION

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[a-f0-9]{64}$/iu
const JOURNAL_KIND = 'managed-data-migration'
const JOURNAL_PHASES = Object.freeze([
  'copying',
  'verified',
  'renamed',
])

export class ManagedDataHomeError extends Error {
  constructor(message, code = 'MANAGED_DATA_HOME_ERROR', options = {}) {
    super(message, options)
    this.name = 'ManagedDataHomeError'
    this.code = code
  }
}

export class ManagedDataHomeAbortedError extends ManagedDataHomeError {
  constructor(message = 'Managed data migration aborted', options = {}) {
    super(message, 'ABORT_ERR', options)
    this.name = 'ManagedDataHomeAbortedError'
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function fail(message, code = 'MANAGED_DATA_HOME_ERROR', options = {}) {
  throw new ManagedDataHomeError(message, code, options)
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`, 'MANAGED_DATA_STATE_INVALID')
  return value
}

function assertExactKeys(value, keys, label) {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not supported`, 'MANAGED_DATA_STATE_INVALID')
  }
}

function assertAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new TypeError(`${label} must be an explicit absolute path`)
  }
  return resolve(value)
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${label} must be a safe identifier`)
  }
  return value
}

function comparablePath(value) {
  let normalized = resolve(value).replaceAll('\\', '/')
  if (normalized.startsWith('//?/UNC/')) normalized = `//${normalized.slice('//?/UNC/'.length)}`
  else if (normalized.startsWith('//?/')) normalized = normalized.slice('//?/'.length)
  if (process.platform === 'win32') normalized = normalized.toLowerCase()
  return normalized.replace(/\/+$/u, '') || '/'
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right)
}

function isPathWithin(parent, child, allowEqual = true) {
  const parentValue = comparablePath(parent)
  const childValue = comparablePath(child)
  if (childValue === parentValue) return allowEqual
  return childValue.startsWith(`${parentValue}/`)
}

function assertPathWithin(parent, child, label, allowEqual = false) {
  if (!isPathWithin(parent, child, allowEqual)) fail(`${label} escapes its allowed root`, 'MANAGED_DATA_PATH_ESCAPE')
  return child
}

function assertRelativePath(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || value.includes(':')) {
    fail(`${label} must be a relative POSIX path`, 'MANAGED_DATA_STATE_INVALID')
  }
  if (value === '' && allowEmpty) return value
  if (value === '' || posix.isAbsolute(value) || value === '.' || value === '..'
    || value.startsWith('../') || value.includes('/../') || posix.normalize(value) !== value
    || value.split('/').some(part => part === '' || part === '.' || part === '..')) {
    fail(`${label} must be a normalized relative POSIX path`, 'MANAGED_DATA_STATE_INVALID')
  }
  return value
}

function assertEntryName(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value === '.' || value === '..'
    || value.includes('/') || value.includes('\\') || value.includes(':')) {
    fail(`${label} is not a safe tree entry`, 'MANAGED_DATA_TREE_INVALID')
  }
  return value
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    fail(`${label} must be an ISO-8601 UTC timestamp`, 'MANAGED_DATA_STATE_INVALID')
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    fail(`${label} must be a canonical ISO-8601 UTC timestamp`, 'MANAGED_DATA_STATE_INVALID')
  }
  return value
}

function now() {
  return new Date().toISOString()
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const reason = signal.reason
  if (reason instanceof ManagedDataHomeError && reason.code === 'ABORT_ERR') throw reason
  if (reason instanceof Error) throw new ManagedDataHomeAbortedError(reason.message, { cause: reason })
  if (reason === undefined) throw new ManagedDataHomeAbortedError()
  throw new ManagedDataHomeAbortedError(`Managed data migration aborted: ${String(reason)}`, { cause: reason })
}

function assertNotLinked(stats, pathValue, label = pathValue) {
  // lstat() is intentional. On Windows a directory junction is exposed as
  // a symbolic link by Node, so it is rejected for data trees and handled
  // explicitly only by projectManagedProfile().
  if (stats?.isSymbolicLink?.() === true) {
    fail(`${label} is a symbolic link or junction`, 'MANAGED_DATA_LINK_REJECTED')
  }
  return stats
}

function isNotFound(error) {
  return error?.code === 'ENOENT'
}

function readJsonSync(pathValue, label) {
  let stats
  try {
    stats = lstatSync(pathValue)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw new ManagedDataHomeError(`Unable to inspect ${label}: ${errorMessage(error)}`, 'MANAGED_DATA_STATE_UNREADABLE', { cause: error })
  }
  assertNotLinked(stats, pathValue, label)
  if (!stats.isFile()) fail(`${label} must be a regular file`, 'MANAGED_DATA_STATE_INVALID')
  let text
  try {
    text = readFileSync(pathValue, 'utf8')
  } catch (error) {
    throw new ManagedDataHomeError(`Unable to read ${label}: ${errorMessage(error)}`, 'MANAGED_DATA_STATE_UNREADABLE', { cause: error })
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ManagedDataHomeError(`Unable to parse ${label}: ${errorMessage(error)}`, 'MANAGED_DATA_STATE_INVALID', { cause: error })
  }
}

function validateHash(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} must be a SHA-256 digest`, 'MANAGED_DATA_STATE_INVALID')
  return value.toLowerCase()
}

function validateManifest(value, label = 'manifest') {
  const manifest = assertPlainObject(value, label)
  assertExactKeys(manifest, ['createdAt', 'files', 'directories'], label)
  if (!Object.hasOwn(manifest, 'createdAt') || !Object.hasOwn(manifest, 'files') || !Object.hasOwn(manifest, 'directories')) {
    fail(`${label} is incomplete`, 'MANAGED_DATA_STATE_INVALID')
  }
  const createdAt = canonicalTimestamp(manifest.createdAt, `${label}.createdAt`)
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) {
    fail(`${label}.files and ${label}.directories must be arrays`, 'MANAGED_DATA_STATE_INVALID')
  }

  const files = manifest.files.map((entry, index) => {
    const item = assertPlainObject(entry, `${label}.files[${String(index)}]`)
    assertExactKeys(item, ['path', 'bytes', 'sha256'], `${label}.files[${String(index)}]`)
    if (!Object.hasOwn(item, 'path') || !Object.hasOwn(item, 'bytes') || !Object.hasOwn(item, 'sha256')) {
      fail(`${label}.files[${String(index)}] is incomplete`, 'MANAGED_DATA_STATE_INVALID')
    }
    const pathValue = assertRelativePath(item.path, `${label}.files[${String(index)}].path`)
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0) fail(`${label}.files[${String(index)}].bytes is invalid`, 'MANAGED_DATA_STATE_INVALID')
    return { path: pathValue, bytes: item.bytes, sha256: validateHash(item.sha256, `${label}.files[${String(index)}].sha256`) }
  }).sort(comparePathEntry)

  const directories = manifest.directories.map((entry, index) => {
    if (typeof entry !== 'string') fail(`${label}.directories[${String(index)}] must be a path`, 'MANAGED_DATA_STATE_INVALID')
    return assertRelativePath(entry, `${label}.directories[${String(index)}]`)
  }).sort(compareStrings)

  const filePaths = new Set()
  for (const file of files) {
    if (filePaths.has(file.path)) fail(`${label} contains a duplicate file`, 'MANAGED_DATA_STATE_INVALID')
    filePaths.add(file.path)
  }
  if (new Set(directories).size !== directories.length) fail(`${label} contains a duplicate directory`, 'MANAGED_DATA_STATE_INVALID')
  return {
    createdAt,
    files,
    directories,
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function comparePathEntry(left, right) {
  return compareStrings(left.path, right.path)
}

function contentManifest(value) {
  return {
    files: value.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    directories: [...value.directories],
  }
}

function withStructuralDirectories(manifest) {
  return makeManifest(
    manifest.files,
    [...new Set([...manifest.directories, ...MANAGED_DATA_STRUCTURAL_DIRECTORIES])],
    manifest.createdAt,
  )
}

function manifestsEqual(left, right) {
  const a = contentManifest(left)
  const b = contentManifest(right)
  return JSON.stringify(a) === JSON.stringify(b)
}

function makeManifest(files, directories, createdAt = now()) {
  return validateManifest({ createdAt, files, directories }, 'manifest')
}

function serializeJson(value) {
  return `${JSON.stringify(value, undefined, 2)}\n`
}

async function directoryFsync(pathValue) {
  if (process.platform === 'win32') return
  let handle
  try {
    handle = await openAsync(pathValue, 'r')
    await handle.sync()
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function writeJsonAtomic(pathValue, value, label) {
  const temporary = join(dirname(pathValue), `.${pathValue.split(sep).at(-1)}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await openAsync(temporary, 'wx', 0o600)
    await handle.writeFile(serializeJson(value), 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await renameAsync(temporary, pathValue)
    await directoryFsync(dirname(pathValue))
  } catch (error) {
    try { await handle?.close() } catch { /* preserve the original failure */ }
    try { await unlinkAsync(temporary) } catch { /* preserve the original failure */ }
    if (error instanceof ManagedDataHomeError) throw error
    throw new ManagedDataHomeError(`Unable to atomically write ${label}: ${errorMessage(error)}`, 'MANAGED_DATA_PUBLISH_FAILED', { cause: error })
  }
}

function validateDataHomeRecord(value, runtimeRoot, label = 'data-home.json') {
  const record = assertPlainObject(value, label)
  assertExactKeys(record, ['schemaVersion', 'status', 'dataHome', 'sourceReleaseId', 'publishedAt', 'manifest'], label)
  for (const key of ['schemaVersion', 'status', 'dataHome', 'sourceReleaseId']) {
    if (!Object.hasOwn(record, key)) fail(`${label}.${key} is missing`, 'MANAGED_DATA_STATE_INVALID')
  }
  if (record.schemaVersion !== MANAGED_DATA_SCHEMA_VERSION) fail(`${label}.schemaVersion is unsupported`, 'MANAGED_DATA_STATE_INVALID')
  if (record.status !== 'ready') fail(`${label}.status must be ready`, 'MANAGED_DATA_STATE_INVALID')
  const dataHome = join(runtimeRoot, MANAGED_DATA_HOME_DIRECTORY)
  const persistedDataHome = record.dataHome
  if (typeof persistedDataHome !== 'string'
    || (persistedDataHome !== MANAGED_DATA_HOME_DIRECTORY && !samePath(persistedDataHome, dataHome))) {
    fail(`${label}.dataHome must be the fixed runtimeRoot/user-data path`, 'MANAGED_DATA_PATH_INVALID')
  }
  const sourceReleaseId = assertSafeId(record.sourceReleaseId, `${label}.sourceReleaseId`)
  const publishedAt = record.publishedAt === undefined ? undefined : canonicalTimestamp(record.publishedAt, `${label}.publishedAt`)
  const manifest = record.manifest === undefined ? undefined : validateManifest(record.manifest, `${label}.manifest`)
  return {
    schemaVersion: MANAGED_DATA_SCHEMA_VERSION,
    status: 'ready',
    dataHome,
    sourceReleaseId,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(manifest === undefined ? {} : { manifest }),
  }
}

function dataHomePath(runtimeRoot) {
  return join(runtimeRoot, MANAGED_DATA_HOME_DIRECTORY)
}

function dataHomePointerPath(runtimeRoot) {
  return join(runtimeRoot, MANAGED_DATA_HOME_FILE)
}

function readDataHomeRecordSync(runtimeRoot, { requireTarget = false } = {}) {
  const root = assertAbsolutePath(runtimeRoot, 'runtimeRoot')
  const parsed = readJsonSync(dataHomePointerPath(root), MANAGED_DATA_HOME_FILE)
  if (parsed === undefined) return undefined
  const record = validateDataHomeRecord(parsed, root)
  if (requireTarget) assertRegularDirectorySync(record.dataHome, 'managed data home')
  return record
}

function assertRegularDirectorySync(pathValue, label) {
  let stats
  try {
    stats = lstatSync(pathValue)
  } catch (error) {
    throw new ManagedDataHomeError(`${label} is unavailable: ${errorMessage(error)}`, 'MANAGED_DATA_STATE_INVALID', { cause: error })
  }
  assertNotLinked(stats, pathValue, label)
  if (!stats.isDirectory()) fail(`${label} must be a regular directory`, 'MANAGED_DATA_STATE_INVALID')
  return stats
}

async function assertRegularDirectoryAsync(pathValue, label) {
  let stats
  try {
    stats = await lstatAsync(pathValue)
  } catch (error) {
    throw new ManagedDataHomeError(`${label} is unavailable: ${errorMessage(error)}`, 'MANAGED_DATA_PATH_INVALID', { cause: error })
  }
  assertNotLinked(stats, pathValue, label)
  if (!stats.isDirectory()) fail(`${label} must be a regular directory`, 'MANAGED_DATA_PATH_INVALID')
  return stats
}

function assertFixedDataHomeStateSync(runtimeRoot) {
  const root = assertAbsolutePath(runtimeRoot, 'runtimeRoot')
  let rootStats
  try {
    rootStats = lstatSync(root)
  } catch (error) {
    throw new ManagedDataHomeError(`runtimeRoot is unavailable: ${errorMessage(error)}`, 'MANAGED_DATA_PATH_INVALID', { cause: error })
  }
  assertNotLinked(rootStats, root, 'runtimeRoot')
  if (!rootStats.isDirectory()) fail('runtimeRoot must be a regular directory', 'MANAGED_DATA_PATH_INVALID')
  let canonical
  try { canonical = realpathSync(root) } catch (error) {
    throw new ManagedDataHomeError(`runtimeRoot cannot be canonicalized: ${errorMessage(error)}`, 'MANAGED_DATA_PATH_INVALID', { cause: error })
  }
  if (!samePath(canonical, root)) fail('runtimeRoot must not resolve through a link', 'MANAGED_DATA_LINK_REJECTED')
  return root
}

async function assertRuntimeRoot(root) {
  const stats = await assertRegularDirectoryAsync(root, 'runtimeRoot')
  const canonical = await realpathAsync(root)
  if (!samePath(canonical, root)) fail('runtimeRoot must not resolve through a link', 'MANAGED_DATA_LINK_REJECTED')
  return stats
}

async function assertCandidateSource({ runtimeRoot, sourceHome, sourceReleaseId }) {
  const root = assertAbsolutePath(runtimeRoot, 'runtimeRoot')
  const source = assertAbsolutePath(sourceHome, 'sourceHome')
  const releaseId = assertSafeId(sourceReleaseId, 'sourceReleaseId')
  const candidatesRoot = join(root, 'candidates')
  const expected = join(candidatesRoot, releaseId)
  assertPathWithin(candidatesRoot, source, 'sourceHome', false)
  if (!samePath(source, expected)) fail('sourceHome must be runtimeRoot/candidates/sourceReleaseId', 'MANAGED_DATA_SOURCE_INVALID')
  await assertRegularDirectoryAsync(root, 'runtimeRoot')
  await assertRegularDirectoryAsync(candidatesRoot, 'candidates root')
  const candidatesCanonical = await realpathAsync(candidatesRoot)
  if (!samePath(candidatesCanonical, candidatesRoot)) fail('candidates root must not be a link', 'MANAGED_DATA_LINK_REJECTED')
  const sourceStats = await assertRegularDirectoryAsync(source, 'source candidate')
  const sourceCanonical = await realpathAsync(source)
  if (!samePath(sourceCanonical, expected)) fail('source candidate must be canonical inside runtimeRoot/candidates', 'MANAGED_DATA_SOURCE_INVALID')
  return { root, source, releaseId, candidatesRoot, sourceStats }
}

async function hashRegularFile(pathValue, initialStats, label) {
  let bytes
  try {
    bytes = await readFileAsync(pathValue)
  } catch (error) {
    throw new ManagedDataHomeError(`Unable to hash ${label}: ${errorMessage(error)}`, 'MANAGED_DATA_SOURCE_UNREADABLE', { cause: error })
  }
  const after = await lstatAsync(pathValue)
  assertNotLinked(after, pathValue, label)
  if (!after.isFile() || after.size !== initialStats.size || after.mtimeMs !== initialStats.mtimeMs) {
    fail(`${label} changed while being read`, 'MANAGED_DATA_SOURCE_CHANGED')
  }
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), mtimeMs: after.mtimeMs }
}

async function captureTree(root, { excludeRootNames = new Set(), signal } = {}) {
  await assertRegularDirectoryAsync(root, 'tree root')
  const files = []
  const directories = []
  const signatures = []

  async function visit(directory, relativeDirectory, atRoot = false) {
    throwIfAborted(signal)
    let entries
    try {
      entries = await readdirAsync(directory, { withFileTypes: true })
    } catch (error) {
      throw new ManagedDataHomeError(`Unable to list ${directory}: ${errorMessage(error)}`, 'MANAGED_DATA_SOURCE_UNREADABLE', { cause: error })
    }
    entries.sort((left, right) => compareStrings(left.name, right.name))
    for (const entry of entries) {
      throwIfAborted(signal)
      const name = assertEntryName(entry.name, `${directory} entry`)
      const child = join(directory, name)
      const childRelative = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`
      let stats
      try {
        stats = await lstatAsync(child)
      } catch (error) {
        throw new ManagedDataHomeError(`Unable to inspect ${child}: ${errorMessage(error)}`, 'MANAGED_DATA_SOURCE_UNREADABLE', { cause: error })
      }
      // Excluded candidate roots are not copied, but the excluded entry
      // itself must still be a regular object; a link cannot hide data.
      if (atRoot && excludeRootNames.has(name)) {
        assertNotLinked(stats, child, child)
        if (!stats.isFile() && !stats.isDirectory()) fail(`${child} is not a regular entry`, 'MANAGED_DATA_TREE_INVALID')
        continue
      }
      assertNotLinked(stats, child, child)
      if (stats.isDirectory()) {
        directories.push(childRelative)
        signatures.push({ type: 'directory', path: childRelative, mtimeMs: stats.mtimeMs })
        await visit(child, childRelative, false)
      } else if (stats.isFile()) {
        const hashed = await hashRegularFile(child, stats, child)
        files.push({ path: childRelative, bytes: hashed.bytes, sha256: hashed.sha256 })
        signatures.push({ type: 'file', path: childRelative, bytes: hashed.bytes, sha256: hashed.sha256, mtimeMs: hashed.mtimeMs })
      } else {
        fail(`${child} is not a regular file or directory`, 'MANAGED_DATA_TREE_INVALID')
      }
    }
  }

  await visit(root, '', true)
  const manifest = makeManifest(files.sort(comparePathEntry), directories.sort(compareStrings))
  signatures.sort((left, right) => comparePathEntry(left, right))
  return { manifest, signatures }
}

function signaturesEqual(left, right) {
  if (left.length !== right.length) return false
  return left.every((entry, index) => {
    const other = right[index]
    return entry.type === other.type && entry.path === other.path && entry.bytes === other.bytes
      && entry.sha256 === other.sha256 && entry.mtimeMs === other.mtimeMs
  })
}

function journalRelativePath(pathValue, root, label) {
  const value = relative(root, pathValue).replaceAll(sep, '/')
  assertPathWithin(root, pathValue, label, false)
  return assertRelativePath(value, label)
}

function stagingPathFromRelative(root, value) {
  assertRelativePath(value, 'journal.staging')
  if (!value.startsWith(MANAGED_DATA_STAGING_PREFIX) || value.includes('/')) {
    fail('journal.staging is not a managed staging path', 'MANAGED_DATA_JOURNAL_INVALID')
  }
  const suffix = value.slice(MANAGED_DATA_STAGING_PREFIX.length)
  if (!UUID.test(suffix)) fail('journal.staging has an invalid identifier', 'MANAGED_DATA_JOURNAL_INVALID')
  return join(root, value)
}

function validateJournal(value, root, label = 'managed-data journal') {
  const journal = assertPlainObject(value, label)
  assertExactKeys(journal, [
    'schemaVersion',
    'kind',
    'phase',
    'sourceReleaseId',
    'sourceHome',
    'staging',
    'sourceManifest',
    'manifest',
    'startedAt',
    'updatedAt',
  ], label)
  for (const key of ['schemaVersion', 'kind', 'phase', 'sourceReleaseId', 'sourceHome', 'staging', 'sourceManifest', 'manifest', 'startedAt', 'updatedAt']) {
    if (!Object.hasOwn(journal, key)) fail(`${label}.${key} is missing`, 'MANAGED_DATA_JOURNAL_INVALID')
  }
  if (journal.schemaVersion !== MANAGED_DATA_SCHEMA_VERSION || journal.kind !== JOURNAL_KIND) {
    fail(`${label} has an unsupported schema`, 'MANAGED_DATA_JOURNAL_INVALID')
  }
  if (!JOURNAL_PHASES.includes(journal.phase)) fail(`${label}.phase is unsupported`, 'MANAGED_DATA_JOURNAL_INVALID')
  const sourceReleaseId = assertSafeId(journal.sourceReleaseId, `${label}.sourceReleaseId`)
  const expectedSourceHome = `candidates/${sourceReleaseId}`
  if (journal.sourceHome !== expectedSourceHome) fail(`${label}.sourceHome is invalid`, 'MANAGED_DATA_JOURNAL_INVALID')
  const staging = assertRelativePath(journal.staging, `${label}.staging`)
  stagingPathFromRelative(root, staging)
  const sourceManifest = validateManifest(journal.sourceManifest, `${label}.sourceManifest`)
  const manifest = validateManifest(journal.manifest, `${label}.manifest`)
  if (!manifestsEqual(manifest, withStructuralDirectories(sourceManifest))) {
    fail(`${label}.manifest does not match its source manifest`, 'MANAGED_DATA_JOURNAL_INVALID')
  }
  return {
    schemaVersion: MANAGED_DATA_SCHEMA_VERSION,
    kind: JOURNAL_KIND,
    phase: journal.phase,
    sourceReleaseId,
    sourceHome: expectedSourceHome,
    staging,
    sourceManifest,
    manifest,
    startedAt: canonicalTimestamp(journal.startedAt, `${label}.startedAt`),
    updatedAt: canonicalTimestamp(journal.updatedAt, `${label}.updatedAt`),
  }
}

async function loadJournal(root) {
  const fileName = MANAGED_DATA_JOURNAL_FILE
  const pathValue = join(root, fileName)
  let stats
  try {
    stats = await lstatAsync(pathValue)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw new ManagedDataHomeError(`Unable to inspect journal ${pathValue}: ${errorMessage(error)}`, 'MANAGED_DATA_JOURNAL_UNREADABLE', { cause: error })
  }
  assertNotLinked(stats, pathValue, pathValue)
  if (!stats.isFile()) fail(`journal ${pathValue} must be a regular file`, 'MANAGED_DATA_JOURNAL_INVALID')
  let parsed
  try {
    parsed = JSON.parse(await readFileAsync(pathValue, 'utf8'))
  } catch (error) {
    throw new ManagedDataHomeError(`Unable to read journal ${pathValue}: ${errorMessage(error)}`, 'MANAGED_DATA_JOURNAL_INVALID', { cause: error })
  }
  return { path: pathValue, fileName, journal: validateJournal(parsed, root, pathValue) }
}

async function writeJournal(root, journal, fileName = MANAGED_DATA_JOURNAL_FILE) {
  const normalized = validateJournal(journal, root)
  await writeJsonAtomic(join(root, fileName), normalized, 'managed-data journal')
  return normalized
}

async function clearJournal(loaded) {
  if (loaded === undefined) return
  try {
    await unlinkAsync(loaded.path)
    await directoryFsync(dirname(loaded.path))
  } catch (error) {
    if (isNotFound(error)) return
    throw new ManagedDataHomeError(`Unable to clear managed-data journal: ${errorMessage(error)}`, 'MANAGED_DATA_JOURNAL_CLEAR_FAILED', { cause: error })
  }
}

async function ensureStagingDirectory(root, stagingPath, { reset = false } = {}) {
  assertPathWithin(root, stagingPath, 'staging path', false)
  if (reset) {
    let stats
    try {
      stats = await lstatAsync(stagingPath)
    } catch (error) {
      if (isNotFound(error)) {
        await mkdirAsync(stagingPath, { recursive: false, mode: 0o700 })
        return
      }
      throw new ManagedDataHomeError(`Unable to inspect staging path: ${errorMessage(error)}`, 'MANAGED_DATA_STAGING_INVALID', { cause: error })
    }
    assertNotLinked(stats, stagingPath, 'staging path')
    if (!stats.isDirectory()) fail('staging path must be a regular directory', 'MANAGED_DATA_STAGING_INVALID')
    // The directory is owned by the validated journal. Validate its complete
    // tree before repairing it; an unexpected link is never removed.
    await captureTree(stagingPath)
    await rmAsync(stagingPath, { recursive: true, force: false })
    await mkdirAsync(stagingPath, { recursive: false, mode: 0o700 })
    return
  }
  try {
    await mkdirAsync(stagingPath, { recursive: false, mode: 0o700 })
  } catch (error) {
    if (error?.code === 'EEXIST') fail('managed staging path already exists', 'MANAGED_DATA_STAGING_COLLISION', { cause: error })
    throw new ManagedDataHomeError(`Unable to create staging path: ${errorMessage(error)}`, 'MANAGED_DATA_STAGING_CREATE_FAILED', { cause: error })
  }
}

async function copyManifestTree(sourceRoot, stagingRoot, manifest, signal) {
  const directories = [...manifest.directories].sort((left, right) => {
    const depth = left.split('/').length - right.split('/').length
    return depth || compareStrings(left, right)
  })
  for (const directory of directories) {
    throwIfAborted(signal)
    const sourcePath = join(sourceRoot, ...directory.split('/'))
    const targetPath = join(stagingRoot, ...directory.split('/'))
    const sourceStats = await lstatAsync(sourcePath)
    assertNotLinked(sourceStats, sourcePath, sourcePath)
    if (!sourceStats.isDirectory()) fail(`${sourcePath} changed from a directory`, 'MANAGED_DATA_SOURCE_CHANGED')
    try {
      await mkdirAsync(targetPath, { recursive: false, mode: 0o700 })
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const targetStats = await lstatAsync(targetPath)
        assertNotLinked(targetStats, targetPath, targetPath)
        if (!targetStats.isDirectory()) fail(`${targetPath} is not a staging directory`, 'MANAGED_DATA_STAGING_INVALID')
      } else {
        throw new ManagedDataHomeError(`Unable to create staging directory ${targetPath}: ${errorMessage(error)}`, 'MANAGED_DATA_COPY_FAILED', { cause: error })
      }
    }
  }
  for (const file of manifest.files) {
    throwIfAborted(signal)
    const sourcePath = join(sourceRoot, ...file.path.split('/'))
    const targetPath = join(stagingRoot, ...file.path.split('/'))
    const sourceStats = await lstatAsync(sourcePath)
    assertNotLinked(sourceStats, sourcePath, sourcePath)
    if (!sourceStats.isFile()) fail(`${sourcePath} changed from a file`, 'MANAGED_DATA_SOURCE_CHANGED')
    try {
      const existingTarget = await lstatAsync(targetPath)
      assertNotLinked(existingTarget, targetPath, targetPath)
      if (!existingTarget.isFile()) fail(`${targetPath} is not a staging file`, 'MANAGED_DATA_STAGING_INVALID')
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    try {
      // node:fs/promises is used against the external runtimeRoot. This keeps
      // user data out of Electron's asar virtual filesystem; packaged builds
      // must not pass an asar-internal path as runtimeRoot or sourceHome.
      await copyFileAsync(sourcePath, targetPath)
    } catch (error) {
      throw new ManagedDataHomeError(`Unable to copy ${file.path}: ${errorMessage(error)}`, 'MANAGED_DATA_COPY_FAILED', { cause: error })
    }
  }
}

async function createStructuralDirectories(stagingRoot, signal) {
  for (const directory of MANAGED_DATA_STRUCTURAL_DIRECTORIES) {
    throwIfAborted(signal)
    const pathValue = join(stagingRoot, ...directory.split('/'))
    try {
      await mkdirAsync(pathValue, { recursive: false, mode: 0o700 })
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const stats = await lstatAsync(pathValue)
        assertNotLinked(stats, pathValue, pathValue)
        if (!stats.isDirectory()) fail(`${pathValue} is not a regular structural directory`, 'MANAGED_DATA_STAGING_INVALID')
      } else {
        throw new ManagedDataHomeError(`Unable to create structural data directory: ${errorMessage(error)}`, 'MANAGED_DATA_COPY_FAILED', { cause: error })
      }
    }
  }
}

async function verifySourceSnapshot(sourceRoot, expectedManifest, signal) {
  const current = await captureTree(sourceRoot, { excludeRootNames: new Set(MANAGED_DATA_EXCLUDED_ROOTS), signal })
  if (!manifestsEqual(current.manifest, expectedManifest)) fail('source candidate changed during migration', 'MANAGED_DATA_SOURCE_CHANGED')
  return current
}

async function verifyStaging(stagingRoot, expectedManifest, signal) {
  const current = await captureTree(stagingRoot, { signal })
  if (!manifestsEqual(current.manifest, expectedManifest)) fail('staging content failed hash verification', 'MANAGED_DATA_INTEGRITY_FAILED')
  return current
}

async function inspectDestinationForJournal(root, { allowMissing = false } = {}) {
  const target = dataHomePath(root)
  let targetStats
  try {
    targetStats = await lstatAsync(target)
  } catch (error) {
    if (!isNotFound(error)) throw new ManagedDataHomeError(`Unable to inspect managed data home: ${errorMessage(error)}`, 'MANAGED_DATA_STATE_UNREADABLE', { cause: error })
  }
  if (targetStats !== undefined) {
    assertNotLinked(targetStats, target, 'managed data home')
    if (!targetStats.isDirectory()) fail('existing user-data is not a regular directory', 'MANAGED_DATA_FOREIGN_DESTINATION')
  }
  const pointer = readDataHomeRecordSync(root)
  if (targetStats === undefined && pointer !== undefined && !allowMissing) fail('data-home.json is ready but user-data is missing', 'MANAGED_DATA_STATE_INVALID')
  if (targetStats !== undefined && pointer === undefined && !allowMissing) fail('existing user-data is not owned by managed data home', 'MANAGED_DATA_FOREIGN_DESTINATION')
  return { target, targetStats, pointer }
}

function makeJournal({ root, phase, releaseId, sourceHome, stagingPath, sourceManifest, manifest, startedAt = now(), updatedAt = now() }) {
  return validateJournal({
    schemaVersion: MANAGED_DATA_SCHEMA_VERSION,
    kind: JOURNAL_KIND,
    phase,
    sourceReleaseId: releaseId,
    sourceHome: journalRelativePath(sourceHome, root, 'journal.sourceHome'),
    staging: journalRelativePath(stagingPath, root, 'journal.staging'),
    sourceManifest,
    manifest,
    startedAt,
    updatedAt,
  }, root)
}

async function createStagingPath(root) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pathValue = join(root, `${MANAGED_DATA_STAGING_PREFIX}${randomUUID()}`)
    try {
      await mkdirAsync(pathValue, { recursive: false, mode: 0o700 })
      return pathValue
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new ManagedDataHomeError(`Unable to create managed staging path: ${errorMessage(error)}`, 'MANAGED_DATA_STAGING_CREATE_FAILED', { cause: error })
    }
  }
  fail('Unable to allocate a unique managed staging path', 'MANAGED_DATA_STAGING_COLLISION')
}

async function publishReady({ root, releaseId, manifest, signal }) {
  throwIfAborted(signal)
  const record = {
    schemaVersion: MANAGED_DATA_SCHEMA_VERSION,
    status: 'ready',
    dataHome: MANAGED_DATA_HOME_DIRECTORY,
    sourceReleaseId: releaseId,
    publishedAt: now(),
    manifest,
  }
  await writeJsonAtomic(dataHomePointerPath(root), record, 'data-home.json')
  const readBack = readDataHomeRecordSync(root, { requireTarget: true })
  if (readBack.sourceReleaseId !== releaseId || readBack.manifest === undefined || !manifestsEqual(readBack.manifest, manifest)) {
    fail('data-home.json read-back verification failed', 'MANAGED_DATA_PUBLISH_FAILED')
  }
  return readBack
}

async function commitVerified({ root, sourceRoot, releaseId, stagingPath, sourceManifest, manifest, journalLoaded, journal, signal }) {
  let currentJournal = journal
  const target = dataHomePath(root)

  if (currentJournal.phase === 'verified') {
    const stageStats = await lstatAsync(stagingPath)
    assertNotLinked(stageStats, stagingPath, 'managed staging path')
    if (!stageStats.isDirectory()) fail('managed staging path is not a directory', 'MANAGED_DATA_STAGING_INVALID')
    // There is intentionally no replacement branch here. A valid ready
    // pointer is handled before a new copy starts; reaching this commit path
    // means user-data was absent and the first migration owns the destination.
    throwIfAborted(signal)
    try {
      await renameAsync(stagingPath, target)
    } catch (error) {
      throw new ManagedDataHomeError(`Unable to publish user-data directory: ${errorMessage(error)}`, 'MANAGED_DATA_RENAME_FAILED', { cause: error })
    }
    currentJournal = makeJournal({
      root,
      phase: 'renamed',
      releaseId,
      sourceHome: sourceRoot,
      stagingPath,
      sourceManifest,
      manifest,
      startedAt: currentJournal.startedAt,
    })
    await writeJournal(root, currentJournal, journalLoaded.fileName)
  }

  if (currentJournal.phase !== 'renamed') fail('managed-data journal cannot be committed', 'MANAGED_DATA_JOURNAL_INVALID')
  await verifyStaging(target, manifest, signal)
  const pointer = await publishReady({ root, releaseId, manifest, signal })
  await clearJournal(journalLoaded)
  return pointer
}

async function recoverJournal({ root, sourceRoot, releaseId, loaded, signal }) {
  const journal = loaded.journal
  if (journal.sourceReleaseId !== releaseId) fail('another managed-data migration is pending', 'MANAGED_DATA_TRANSACTION_PENDING')
  const stagingPath = stagingPathFromRelative(root, journal.staging)
  const sourceManifest = journal.sourceManifest
  const manifest = journal.manifest

  if (journal.phase === 'renamed') {
    const target = dataHomePath(root)
    await verifyStaging(target, manifest, signal)
    const pointerRecord = readDataHomeRecordSync(root)
    let pointer
    if (pointerRecord !== undefined && pointerRecord.sourceReleaseId === releaseId
      && pointerRecord.manifest !== undefined && manifestsEqual(pointerRecord.manifest, manifest)) {
      pointer = pointerRecord
    } else {
      if (pointerRecord !== undefined) fail('a ready data-home pointer already exists; pending migration cannot replace it', 'MANAGED_DATA_TRANSACTION_PENDING')
      pointer = await publishReady({ root, releaseId, manifest, signal })
    }
    await clearJournal(loaded)
    return pointer
  }

  await assertCandidateSource({ runtimeRoot: root, sourceHome: sourceRoot, sourceReleaseId: releaseId })
  const sourceSnapshot = await verifySourceSnapshot(sourceRoot, sourceManifest, signal)
  if (journal.phase === 'copying') {
    await ensureStagingDirectory(root, stagingPath, { reset: true })
    await copyManifestTree(sourceRoot, stagingPath, sourceSnapshot.manifest, signal)
    await createStructuralDirectories(stagingPath, signal)
    await verifySourceSnapshot(sourceRoot, sourceSnapshot.manifest, signal)
    const targetManifest = withStructuralDirectories(sourceSnapshot.manifest)
    await verifyStaging(stagingPath, targetManifest, signal)
    const verified = makeJournal({
      root,
      phase: 'verified',
      releaseId,
      sourceHome: sourceRoot,
      stagingPath,
      sourceManifest: sourceSnapshot.manifest,
      manifest: targetManifest,
      startedAt: journal.startedAt,
    })
    await writeJournal(root, verified, loaded.fileName)
    loaded.journal = verified
    return commitVerified({ root, sourceRoot, releaseId, stagingPath, sourceManifest: sourceSnapshot.manifest, manifest: targetManifest, journalLoaded: loaded, journal: verified, signal })
  }

  if (journal.phase === 'verified') {
    let stagingExists = true
    try { await lstatAsync(stagingPath) } catch (error) {
      if (isNotFound(error)) stagingExists = false
      else throw error
    }
    if (!stagingExists) {
      // rename(staging, user-data) may have committed before the verified
      // journal update reached disk. Treat the fixed target as a candidate
      // only after exact tree verification; never replace or remove it.
      const destination = await inspectDestinationForJournal(root, { allowMissing: true })
      if (destination.targetStats === undefined) fail('verified journal has neither staging nor user-data', 'MANAGED_DATA_RECOVERY_FAILED')
      await verifyStaging(destination.target, manifest, signal)
      const pointerMatches = destination.pointer !== undefined
        && destination.pointer.sourceReleaseId === releaseId
        && destination.pointer.manifest !== undefined
        && manifestsEqual(destination.pointer.manifest, manifest)
      if (destination.pointer !== undefined && !pointerMatches) {
        fail('verified recovery would conflict with an existing ready pointer', 'MANAGED_DATA_TRANSACTION_PENDING')
      }
      const renamed = makeJournal({
        root,
        phase: 'renamed',
        releaseId,
        sourceHome: sourceRoot,
        stagingPath,
        sourceManifest: sourceSnapshot.manifest,
        manifest,
        startedAt: journal.startedAt,
      })
      await writeJournal(root, renamed, loaded.fileName)
      loaded.journal = renamed
      if (pointerMatches) {
        await clearJournal(loaded)
        return readManagedDataHome(root)
      }
      const pointer = await publishReady({ root, releaseId, manifest, signal })
      await clearJournal(loaded)
      return pointer
    }
  }

  await verifyStaging(stagingPath, manifest, signal)
  return commitVerified({ root, sourceRoot, releaseId, stagingPath, sourceManifest, manifest, journalLoaded: loaded, journal, signal })
}

/**
 * Read only the verified managed-data pointer. The returned dataHome is
 * always runtimeRoot/user-data, regardless of how the pointer was encoded.
 * A missing pointer is undefined; malformed, incomplete, linked, or damaged
 * state is rejected instead of being treated as a fresh installation.
 */
export function readManagedDataHome(runtimeRoot) {
  // A fresh installation has no managed root yet. Absence is not a corrupt
  // binding; files, links, unreadable roots and malformed state still fail.
  try { lstatSync(assertAbsolutePath(runtimeRoot, 'runtimeRoot')) }
  catch (error) { if (isNotFound(error)) return undefined; throw error }
  const root = assertFixedDataHomeStateSync(runtimeRoot)
  const journalState = readJournalSync(root)
  const journal = journalState?.journal
  const record = readDataHomeRecordSync(root, { requireTarget: true })
  if (journal !== undefined && journal.phase !== 'renamed') {
    fail('managed-data migration is incomplete; readiness is not published', 'MANAGED_DATA_TRANSACTION_PENDING')
  }
  if (journal !== undefined && (record === undefined || record.sourceReleaseId !== journal.sourceReleaseId
    || record.manifest === undefined || !manifestsEqual(record.manifest, journal.manifest))) {
    fail('managed-data journal and ready pointer disagree', 'MANAGED_DATA_TRANSACTION_PENDING')
  }
  return record === undefined ? undefined : Object.freeze({
    ...record,
    ...(record.manifest === undefined ? {} : {
      manifest: Object.freeze({
        ...record.manifest,
        files: Object.freeze(record.manifest.files.map(file => Object.freeze({ ...file }))),
        directories: Object.freeze([...record.manifest.directories]),
      }),
    }),
  })
}

function readJournalSync(root) {
  const fileName = MANAGED_DATA_JOURNAL_FILE
  const pathValue = join(root, fileName)
  let stats
  try { stats = lstatSync(pathValue) } catch (error) { if (isNotFound(error)) return undefined; throw error }
  assertNotLinked(stats, pathValue, pathValue)
  if (!stats.isFile()) fail(`journal ${pathValue} must be a regular file`, 'MANAGED_DATA_JOURNAL_INVALID')
  let parsed
  try { parsed = JSON.parse(readFileSync(pathValue, 'utf8')) } catch (error) {
    throw new ManagedDataHomeError(`Unable to parse journal ${pathValue}: ${errorMessage(error)}`, 'MANAGED_DATA_JOURNAL_INVALID', { cause: error })
  }
  return { path: pathValue, fileName, journal: validateJournal(parsed, root, pathValue) }
}

/**
 * Migrate only the candidate's user-state roots into a fixed shared data
 * home. The caller owns process safety: assertStopped must return exactly
 * true, and this function never starts or stops a supervisor. Source
 * candidates are copied, never deleted; an interrupted operation leaves its
 * journal and exact staging tree for a later explicit recovery.
 */
export async function migrateManagedDataHome({ runtimeRoot, sourceHome, sourceReleaseId, assertStopped, signal } = {}) {
  const root = assertAbsolutePath(runtimeRoot, 'runtimeRoot')
  const source = assertAbsolutePath(sourceHome, 'sourceHome')
  const releaseId = assertSafeId(sourceReleaseId, 'sourceReleaseId')
  if (typeof assertStopped !== 'function') throw new TypeError('assertStopped must be a function')
  throwIfAborted(signal)
  const stopped = await assertStopped()
  if (stopped !== true) fail('migration requires assertStopped() to return true', 'MANAGED_DATA_NOT_STOPPED')
  throwIfAborted(signal)
  await assertRuntimeRoot(root)

  const loaded = await loadJournal(root)
  if (loaded !== undefined) {
    if (loaded.journal.sourceReleaseId !== releaseId) fail('another managed-data migration is pending', 'MANAGED_DATA_TRANSACTION_PENDING')
    const sourceInfo = await assertCandidateSource({ runtimeRoot: root, sourceHome: source, sourceReleaseId: releaseId })
    return recoverJournal({ root, sourceRoot: sourceInfo.source, releaseId, loaded, signal })
  }

  // A ready pointer makes the shared data home authoritative. Version or
  // candidate changes must never copy a later candidate over user state.
  const ready = readDataHomeRecordSync(root, { requireTarget: true })
  if (ready !== undefined) return readManagedDataHome(root)

  const sourceInfo = await assertCandidateSource({ runtimeRoot: root, sourceHome: source, sourceReleaseId: releaseId })
  const destination = await inspectDestinationForJournal(root)
  // The destination check precedes staging creation so a foreign user-data
  // directory is never renamed, overwritten, or hidden by this operation.
  if (destination.targetStats !== undefined && destination.pointer === undefined) {
    fail('existing user-data is not owned by managed data home', 'MANAGED_DATA_FOREIGN_DESTINATION')
  }
  throwIfAborted(signal)
  const sourceSnapshot = await captureTree(sourceInfo.source, {
    excludeRootNames: new Set(MANAGED_DATA_EXCLUDED_ROOTS),
    signal,
  })
  const stagingPath = await createStagingPath(root)
  let journalLoaded
  try {
    const copying = makeJournal({
      root,
      phase: 'copying',
      releaseId,
      sourceHome: sourceInfo.source,
      stagingPath,
      sourceManifest: sourceSnapshot.manifest,
      manifest: withStructuralDirectories(sourceSnapshot.manifest),
    })
    await writeJournal(root, copying)
    journalLoaded = { path: join(root, MANAGED_DATA_JOURNAL_FILE), fileName: MANAGED_DATA_JOURNAL_FILE, journal: copying }
    await copyManifestTree(sourceInfo.source, stagingPath, sourceSnapshot.manifest, signal)
    await createStructuralDirectories(stagingPath, signal)
    const sourceAfter = await verifySourceSnapshot(sourceInfo.source, sourceSnapshot.manifest, signal)
    const targetManifest = withStructuralDirectories(sourceAfter.manifest)
    await verifyStaging(stagingPath, targetManifest, signal)
    const verified = makeJournal({
      root,
      phase: 'verified',
      releaseId,
      sourceHome: sourceInfo.source,
      stagingPath,
      sourceManifest: sourceAfter.manifest,
      manifest: targetManifest,
      startedAt: copying.startedAt,
    })
    await writeJournal(root, verified)
    journalLoaded.journal = verified
    return commitVerified({
      root,
      sourceRoot: sourceInfo.source,
      releaseId,
      stagingPath,
      sourceManifest: sourceAfter.manifest,
      manifest: targetManifest,
      journalLoaded,
      journal: verified,
      signal,
    })
  } catch (error) {
    // Do not remove staging, old user-data, or the journal here. The exact
    // journal-owned path is the recovery record; orphaned paths without a
    // journal are intentionally left untouched as well.
    throw error
  }
}

function readProjectionLinkSync(linkPath, expectedTarget, candidatesRoot, label) {
  let stats
  try { stats = lstatSync(linkPath) } catch (error) {
    if (isNotFound(error)) return { kind: 'missing', linkPath, expectedTarget }
    throw new ManagedDataHomeError(`Unable to inspect ${label}: ${errorMessage(error)}`, 'MANAGED_DATA_PROJECTION_INVALID', { cause: error })
  }
  if (!stats.isSymbolicLink?.()) {
    fail(`${label} is an existing ordinary directory or file; refusing to overwrite it`, 'MANAGED_DATA_PROJECTION_FOREIGN')
  }
  let rawTarget
  try { rawTarget = readlinkSync(linkPath) } catch (error) {
    throw new ManagedDataHomeError(`Unable to read ${label} link target: ${errorMessage(error)}`, 'MANAGED_DATA_PROJECTION_INVALID', { cause: error })
  }
  const resolvedTarget = resolve(dirname(linkPath), rawTarget)
  let linkedCanonical
  try { linkedCanonical = realpathSync(resolvedTarget) } catch (error) {
    throw new ManagedDataHomeError(`${label} is a broken projection link`, 'MANAGED_DATA_PROJECTION_INVALID', { cause: error })
  }
  if (!isPathWithin(candidatesRoot, linkedCanonical, false)) {
    fail(`${label} points outside the managed candidates root`, 'MANAGED_DATA_LINK_REJECTED')
  }
  const targetStats = lstatSync(linkedCanonical)
  assertNotLinked(targetStats, linkedCanonical, `${label} target`)
  if (!targetStats.isDirectory()) fail(`${label} target is not a regular directory`, 'MANAGED_DATA_PROJECTION_INVALID')
  return {
    kind: 'link',
    linkPath,
    expectedTarget,
    rawTarget,
    resolvedTarget,
    canonicalTarget: linkedCanonical,
    same: samePath(linkedCanonical, expectedTarget),
  }
}

function assertProjectionInputs(runtimeRoot, candidateHome, physicalName) {
  const root = assertFixedDataHomeStateSync(runtimeRoot)
  const name = assertSafeId(physicalName, 'physicalName')
  if (name.toLowerCase() === 'node_modules') throw new TypeError('physicalName cannot be node_modules')
  const candidatesRoot = join(root, 'candidates')
  assertRegularDirectorySync(candidatesRoot, 'candidates root')
  const candidate = assertAbsolutePath(candidateHome, 'candidateHome')
  assertPathWithin(candidatesRoot, candidate, 'candidateHome', false)
  assertRegularDirectorySync(candidate, 'candidateHome')
  const candidateCanonical = realpathSync(candidate)
  if (!samePath(candidateCanonical, candidate)) fail('candidateHome must not be a link', 'MANAGED_DATA_LINK_REJECTED')
  const ready = readManagedDataHome(root)
  if (ready === undefined) fail('managed data home is not ready', 'MANAGED_DATA_NOT_READY')
  const dataProfiles = join(ready.dataHome, 'profiles')
  assertRegularDirectorySync(dataProfiles, 'managed data profiles')
  const candidateProfiles = join(candidate, 'profiles')
  assertRegularDirectorySync(candidateProfiles, 'candidate profiles')
  const profileTarget = join(candidateProfiles, name)
  const nodeModulesTarget = join(candidateProfiles, 'node_modules')
  assertRegularDirectorySync(profileTarget, 'candidate physical profile')
  assertRegularDirectorySync(nodeModulesTarget, 'candidate node_modules')
  return {
    root,
    ready,
    candidatesRoot,
    candidate,
    dataProfiles,
    profileTarget,
    nodeModulesTarget,
    profileLink: join(dataProfiles, name),
    nodeModulesLink: join(dataProfiles, 'node_modules'),
    physicalName: name,
  }
}

function ensureProjectionBackupDirectory(root) {
  const directory = join(root, MANAGED_DATA_PROJECTION_BACKUP_DIRECTORY)
  try {
    const stats = lstatSync(directory)
    assertNotLinked(stats, directory, directory)
    if (!stats.isDirectory()) fail('projection-backups must be a regular directory', 'MANAGED_DATA_PROJECTION_INVALID')
  } catch (error) {
    if (!isNotFound(error)) throw error
    mkdirSync(directory, { recursive: false, mode: 0o700 })
  }
  return directory
}

function projectionBackupPath(directory, name) {
  return join(directory, `${name}-${randomUUID()}`)
}

function unlinkVerifiedProjection(linkPath, expectedTarget, candidatesRoot, label) {
  const state = readProjectionLinkSync(linkPath, expectedTarget, candidatesRoot, label)
  if (state.kind !== 'link' || !state.same) fail(`${label} is not the expected new projection link`, 'MANAGED_DATA_PROJECTION_ROLLBACK_FAILED')
  unlinkSync(linkPath)
}

/**
 * Project a candidate's code/profile directories into an already-ready
 * shared data home. The caller must establish a cold/stopped runtime before
 * invoking this synchronous filesystem operation. It creates only directory
 * junctions (Windows) or directory symlinks (Unix) below user-data/profiles;
 * user-data itself is never linked and candidate target directories are never
 * deleted. A different existing, verified projection is moved as one link
 * into runtimeRoot/projection-backups before replacement. Ordinary directories
 * and files are always rejected.
 */
export function projectManagedProfile({ runtimeRoot, candidateHome, physicalName } = {}) {
  const input = assertProjectionInputs(runtimeRoot, candidateHome, physicalName)
  const projectionBackupDirectory = join(input.root, MANAGED_DATA_PROJECTION_BACKUP_DIRECTORY)
  const entries = [
    { name: input.physicalName, linkPath: input.profileLink, target: input.profileTarget },
    { name: 'node_modules', linkPath: input.nodeModulesLink, target: input.nodeModulesTarget },
  ]
  const states = entries.map(entry => ({
    ...entry,
    state: readProjectionLinkSync(entry.linkPath, entry.target, input.candidatesRoot, `${entry.linkPath}`),
  }))
  const changed = states.filter(entry => entry.state.kind === 'missing' || !entry.state.same)
  if (changed.length === 0) {
    return {
      dataHome: input.ready.dataHome,
      physicalName: input.physicalName,
      profilePath: input.profileLink,
      nodeModulesPath: input.nodeModulesLink,
      changed: false,
      backups: [],
    }
  }

  const backups = []
  const temporaryLinks = []
  const installed = []
  const moved = []
  try {
    const backupDirectory = changed.some(entry => entry.state.kind === 'link')
      ? ensureProjectionBackupDirectory(input.root)
      : undefined
    for (const entry of changed) {
      const temporary = join(input.dataProfiles, `.${entry.name}.${randomUUID()}.projection.tmp`)
      symlinkSync(entry.target, temporary, process.platform === 'win32' ? 'junction' : 'dir')
      temporaryLinks.push({ ...entry, temporary })
    }
    for (const entry of changed) {
      if (entry.state.kind === 'link') {
        const backup = projectionBackupPath(backupDirectory, entry.name)
        renameSync(entry.linkPath, backup)
        moved.push({ ...entry, backup })
        backups.push(backup)
      }
    }
    for (const entry of temporaryLinks) {
      renameSync(entry.temporary, entry.linkPath)
      installed.push(entry)
    }
  } catch (error) {
    for (const entry of installed.reverse()) {
      try { unlinkVerifiedProjection(entry.linkPath, entry.target, input.candidatesRoot, entry.linkPath) } catch { /* preserve original failure */ }
    }
    for (const entry of temporaryLinks) {
      try { unlinkVerifiedProjection(entry.temporary, entry.target, input.candidatesRoot, entry.temporary) } catch { /* not installed or already renamed */ }
    }
    for (const entry of moved.reverse()) {
      try {
        let destinationExists = true
        try { lstatSync(entry.linkPath) } catch (probeError) { if (isNotFound(probeError)) destinationExists = false; else throw probeError }
        if (destinationExists) {
          unlinkVerifiedProjection(entry.linkPath, entry.target, input.candidatesRoot, entry.linkPath)
        }
        renameSync(entry.backup, entry.linkPath)
      } catch { /* retain backup for manual recovery if exact rollback is blocked */ }
    }
    throw new ManagedDataHomeError(`Unable to switch managed profile projection: ${errorMessage(error)}`, 'MANAGED_DATA_PROJECTION_SWITCH_FAILED', { cause: error })
  }
  return {
    dataHome: input.ready.dataHome,
    physicalName: input.physicalName,
    profilePath: input.profileLink,
    nodeModulesPath: input.nodeModulesLink,
    changed: true,
    backups,
  }
}

export const internals = Object.freeze({
  validateDataHomeRecord,
  validateManifest,
  validateJournal,
  contentManifest,
  manifestsEqual,
  readJournalSync,
})
