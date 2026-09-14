import { createHash, randomUUID as randomUUIDValue } from 'node:crypto'
import {
  copyFile as copyFileDefault,
  lstat as lstatDefault,
  mkdir as mkdirDefault,
  readdir as readdirDefault,
  readFile as readFileDefault,
  realpath as realpathDefault,
  rename as renameDefault,
  rm as rmDefault,
  writeFile as writeFileDefault,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import process from 'node:process'

export const SNAPSHOT_SCHEMA_VERSION = 1
export const SNAPSHOT_INVENTORY_NAME = 'inventory.json'
export const SNAPSHOT_PAYLOAD_DIRECTORY = 'payload'

const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SNAPSHOT_KINDS = Object.freeze(['pre-switch', 'rescue'])
const SHA256 = /^[a-f0-9]{64}$/i
const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER

export class SnapshotStoreError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'SnapshotStoreError'
  }
}

export class SnapshotIntegrityError extends SnapshotStoreError {
  constructor(message, options) {
    super(message, options)
    this.name = 'SnapshotIntegrityError'
  }
}

export class SnapshotAbortedError extends SnapshotStoreError {
  constructor(message = 'Snapshot operation aborted', options) {
    super(message, options)
    this.name = 'SnapshotAbortedError'
    this.code = 'ABORT_ERR'
  }
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  copyFile: copyFileDefault,
  lstat: lstatDefault,
  mkdir: mkdirDefault,
  readdir: readdirDefault,
  readFile: readFileDefault,
  realpath: realpathDefault,
  rename: renameDefault,
  rm: rmDefault,
  writeFile: writeFileDefault,
})

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function validateAbsolutePath(value, label) {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || !isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`)
  }
  return resolve(value)
}

function validateSnapshotId(value, label = 'snapshot id') {
  if (typeof value !== 'string' || !SNAPSHOT_ID.test(value)) throw new TypeError(`Invalid ${label}`)
  return value
}

function validateSnapshotKind(value) {
  if (!SNAPSHOT_KINDS.includes(value)) throw new TypeError('Snapshot kind must be pre-switch or rescue')
  return value
}

function isWithin(root, target) {
  const child = relative(resolve(root), resolve(target))
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function assertWithin(root, target, label) {
  if (!isWithin(root, target)) throw new SnapshotStoreError(`${label} escapes its root`)
}

function normalizePathForComparison(value) {
  let normalized = resolve(value).replaceAll('\\', '/')
  if (normalized.startsWith('//?/UNC/')) normalized = `//${normalized.slice('//?/UNC/'.length)}`
  else if (normalized.startsWith('//?/')) normalized = normalized.slice('//?/'.length)
  return normalized.toLowerCase()
}

function sameCanonicalPath(left, right) {
  return normalizePathForComparison(left) === normalizePathForComparison(right)
    || windowsRoamingVirtualizationEquivalent(left, right)
    || windowsRoamingVirtualizationEquivalent(right, left)
}

export function windowsRoamingVirtualizationEquivalent(logicalPath, physicalPath) {
  const logical = normalizePathForComparison(logicalPath)
  const physical = normalizePathForComparison(physicalPath)
  const logicalMatch = /^(.*\/appdata)\/roaming(\/.*)?$/u.exec(logical)
  const physicalMatch = /^(.*\/appdata)\/local\/packages\/[^/]+\/localcache\/roaming(\/.*)?$/u.exec(physical)
  return logicalMatch !== null
    && physicalMatch !== null
    && logicalMatch[1] === physicalMatch[1]
    && (logicalMatch[2] ?? '') === (physicalMatch[2] ?? '')
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function abortReason(signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  if (reason === undefined) return new SnapshotAbortedError()
  return new SnapshotAbortedError(`Snapshot operation aborted: ${String(reason)}`, { cause: reason })
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal)
}

function canonicalTimestamp(value) {
  const candidate = typeof value === 'function' ? value() : value
  const date = candidate instanceof Date ? candidate : new Date(candidate ?? Date.now())
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid snapshot creation timestamp')
  return date.toISOString()
}

function pathName(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new SnapshotStoreError('Snapshot tree contains an invalid entry name')
  }
  return value
}

function normalizeExcludedRelativePaths(value = []) {
  if (!Array.isArray(value)) throw new TypeError('excludedRelativePaths must be an array')
  return [...new Set(value.map((entry, index) => {
    if (typeof entry !== 'string' || entry === '' || entry.includes('\0')) {
      throw new TypeError(`Invalid excludedRelativePaths entry ${String(index)}`)
    }
    const normalized = entry.replaceAll('\\', '/')
    if (posix.isAbsolute(normalized) || normalized === '.' || normalized === '..'
      || normalized.startsWith('../') || normalized.includes('/../')
      || posix.normalize(normalized) !== normalized) {
      throw new TypeError(`Invalid excludedRelativePaths entry ${String(index)}`)
    }
    return normalized.replace(/\/$/, '')
  }))].sort()
}

function normalizeRelativeFilePath(value, label = 'snapshot file path') {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || value.includes('\\') || value.includes(':')) {
    throw new SnapshotIntegrityError(`Invalid ${label}`)
  }
  if (value.startsWith('/') || value === '.' || value === '..' || value.startsWith('../')) {
    throw new SnapshotIntegrityError(`Invalid ${label}`)
  }
  const normalized = value.split('/').filter(Boolean).join('/')
  if (normalized !== value || posix.normalize(value) !== value || normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new SnapshotIntegrityError(`Invalid ${label}`)
  }
  return normalized
}

function sumBytes(files) {
  let total = 0
  for (const file of files) {
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_SAFE_BYTES - total) {
      throw new SnapshotIntegrityError('Snapshot byte count exceeds the safe integer range')
    }
    total += file.bytes
  }
  return total
}

function sortFiles(files) {
  return [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

function normalizeFileEntry(value, index) {
  if (!isObject(value) || Array.isArray(value)) throw new SnapshotIntegrityError(`Invalid snapshot file entry ${String(index)}`)
  if (Object.keys(value).sort().join(',') !== 'bytes,path,sha256') throw new SnapshotIntegrityError(`Invalid snapshot file entry ${String(index)} fields`)
  const path = normalizeRelativeFilePath(value.path, `snapshot file entry ${String(index)} path`)
  const bytes = value.bytes
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new SnapshotIntegrityError(`Invalid byte count for ${path}`)
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) throw new SnapshotIntegrityError(`Invalid SHA-256 for ${path}`)
  return { path, bytes, sha256: value.sha256.toLowerCase() }
}

function validateInventory(value, expectedSnapshotId) {
  if (!isObject(value) || Array.isArray(value)) throw new SnapshotIntegrityError('Snapshot inventory must be an object')
  if (Object.keys(value).sort().join(',') !== 'bytes,count,createdAt,files,kind,schemaVersion,snapshotId') throw new SnapshotIntegrityError('Snapshot inventory has invalid fields')
  if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) throw new SnapshotIntegrityError('Unsupported snapshot inventory schema')
  const snapshotId = validateSnapshotId(value.snapshotId, 'snapshot inventory id')
  if (expectedSnapshotId !== undefined && snapshotId !== expectedSnapshotId) {
    throw new SnapshotIntegrityError('Snapshot inventory id does not match its directory')
  }
  const filesValue = value.files
  if (!Array.isArray(filesValue)) throw new SnapshotIntegrityError('Snapshot inventory files must be an array')
  const files = filesValue.map(normalizeFileEntry)
  const seen = new Set()
  for (const file of files) {
    if (seen.has(file.path)) throw new SnapshotIntegrityError(`Duplicate snapshot file ${file.path}`)
    seen.add(file.path)
  }
  if (!Number.isSafeInteger(value.count) || value.count < 0 || value.count !== files.length) {
    throw new SnapshotIntegrityError('Snapshot inventory count does not match its files')
  }
  const bytes = sumBytes(files)
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes !== bytes) {
    throw new SnapshotIntegrityError('Snapshot inventory bytes do not match its files')
  }
  const createdAt = canonicalTimestamp(value.createdAt)
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    kind: validateSnapshotKind(value.kind),
    createdAt,
    count: files.length,
    bytes,
    files: sortFiles(files),
  }
}

function serializeInventory(inventory) {
  return `${JSON.stringify(inventory, undefined, 2)}\n`
}

function dependencyFrom(sources, name) {
  for (const source of sources) {
    if (!isObject(source)) continue
    const direct = source[name]
    if (typeof direct === 'function') return direct
    const implementation = source[`${name}Impl`]
    if (typeof implementation === 'function') return implementation
  }
  return DEFAULT_DEPENDENCIES[name]
}

function createDependencies(options = {}) {
  const nested = options.dependencies ?? options.deps ?? options.fs
  const sources = [nested, options]
  const dependencies = {}
  for (const name of Object.keys(DEFAULT_DEPENDENCIES)) dependencies[name] = dependencyFrom(sources, name)
  dependencies.isReparsePoint = dependencyFrom(sources, 'isReparsePoint')
  dependencies.randomUUID = dependencyFrom(sources, 'randomUUID') ?? randomUUIDValue
  dependencies.faults = options.faults ?? options.failurePoints ?? nested?.faults ?? nested?.failurePoints
  return dependencies
}

async function invokeFault(dependencies, point, context) {
  const faults = dependencies.faults
  if (!isObject(faults)) return
  const names = [point, point.replaceAll(':', '.'), point.replaceAll(':', '_')]
  for (const name of names) {
    const fault = faults[name]
    if (typeof fault !== 'function') continue
    const result = await fault(context)
    if (result instanceof Error) throw result
    if (result === false) throw new SnapshotStoreError(`Injected snapshot fault at ${point}`)
    return
  }
}

async function lstatPath(path, dependencies, label) {
  try {
    return await dependencies.lstat(path)
  } catch (error) {
    throw new SnapshotStoreError(`Unable to inspect ${label} ${path}: ${errorMessage(error)}`, { cause: error })
  }
}

function statKind(stats) {
  const directory = typeof stats?.isDirectory === 'function' ? stats.isDirectory() : stats?.isDirectory === true
  const file = typeof stats?.isFile === 'function' ? stats.isFile() : stats?.isFile === true
  return directory ? 'directory' : file ? 'file' : undefined
}

function hasLinkType(stats) {
  const symbolic = typeof stats?.isSymbolicLink === 'function' ? stats.isSymbolicLink() : stats?.isSymbolicLink === true
  const reparse = typeof stats?.isReparsePoint === 'function' ? stats.isReparsePoint() : stats?.isReparsePoint === true
  return symbolic || reparse || stats?.reparsePoint === true || stats?.isJunction === true
}

async function inspectPath(path, { dependencies, platform, label, allowMissing = false }) {
  let stats
  try {
    stats = await dependencies.lstat(path)
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return undefined
    throw new SnapshotStoreError(`Unable to inspect ${label} ${path}: ${errorMessage(error)}`, { cause: error })
  }
  if (hasLinkType(stats)) throw new SnapshotStoreError(`${label} ${path} is a symlink, junction, or reparse point`)
  if (platform === 'win32' && typeof dependencies.isReparsePoint === 'function') {
    let reparse
    try {
      reparse = await dependencies.isReparsePoint(path, stats)
    } catch (error) {
      throw new SnapshotStoreError(`Unable to determine whether ${label} ${path} is a reparse point: ${errorMessage(error)}`, { cause: error })
    }
    if (reparse === true) throw new SnapshotStoreError(`${label} ${path} is a reparse point`)
  }
  const kind = statKind(stats)
  if (kind === undefined) throw new SnapshotStoreError(`${label} ${path} is an unsupported filesystem entry`)

  if (platform === 'win32') {
    let canonical
    try {
      canonical = await dependencies.realpath(path)
    } catch (error) {
      throw new SnapshotStoreError(`Unable to resolve ${label} ${path}: ${errorMessage(error)}`, { cause: error })
    }
    if (!sameCanonicalPath(path, canonical)) {
      throw new SnapshotStoreError(`${label} ${path} is a junction or reparse point`)
    }
  }
  return { stats, kind }
}

async function assertDirectory(path, context, label, { allowMissing = false } = {}) {
  const details = await inspectPath(path, { ...context, label, allowMissing })
  if (details === undefined) return undefined
  if (details.kind !== 'directory') throw new SnapshotStoreError(`${label} ${path} is not a directory`)
  return details
}

async function assertFile(path, context, label) {
  const details = await inspectPath(path, { ...context, label })
  if (details.kind !== 'file') throw new SnapshotStoreError(`${label} ${path} is not a regular file`)
  return details
}

async function ensureDirectory(path, context, label) {
  const existing = await assertDirectory(path, context, label, { allowMissing: true })
  if (existing !== undefined) return existing
  try {
    await context.dependencies.mkdir(path, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new SnapshotStoreError(`Unable to create ${label} ${path}: ${errorMessage(error)}`, { cause: error })
  }
  return assertDirectory(path, context, label)
}

async function assertAbsent(path, context, label) {
  const existing = await inspectPath(path, { ...context, label, allowMissing: true })
  if (existing !== undefined) throw new SnapshotStoreError(`${label} ${path} already exists`)
}

async function readDirectoryEntries(path, context, label) {
  let entries
  try {
    entries = await context.dependencies.readdir(path, { withFileTypes: true })
  } catch (error) {
    throw new SnapshotStoreError(`Unable to list ${label} ${path}: ${errorMessage(error)}`, { cause: error })
  }
  if (!Array.isArray(entries)) throw new SnapshotStoreError(`Unable to list ${label} ${path}: invalid directory result`)
  return entries.map(entry => typeof entry === 'string' ? entry : entry?.name).map(pathName).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

function relativePath(prefix, name) {
  return prefix === '' ? name : `${prefix}/${name}`
}

function isExcluded(relativeValue, excludedRelativePaths) {
  return excludedRelativePaths.some(excluded => relativeValue === excluded || relativeValue.startsWith(`${excluded}/`))
}

async function walkFiles(root, context, { reservedName, inventoryName, excludedRelativePaths = context.excludedRelativePaths ?? [] } = {}) {
  const files = []
  let metadataFound = false

  async function visit(directory, prefix) {
    throwIfAborted(context.signal)
    const names = await readDirectoryEntries(directory, context, 'snapshot tree')
    for (const name of names) {
      throwIfAborted(context.signal)
      const child = join(directory, name)
      const childRelative = relativePath(prefix, name)
      if (isExcluded(childRelative, excludedRelativePaths)) continue
      const details = await inspectPath(child, { ...context, label: `Snapshot entry ${childRelative}` })
      if (prefix === '' && inventoryName !== undefined && name === inventoryName) {
        if (details.kind !== 'file') throw new SnapshotIntegrityError(`Snapshot inventory ${child} is not a regular file`)
        metadataFound = true
        continue
      }
      if (reservedName !== undefined && childRelative === reservedName) {
        throw new SnapshotStoreError(`Source tree contains reserved file ${reservedName}`)
      }
      if (details.kind === 'directory') {
        await visit(child, childRelative)
      } else if (details.kind === 'file') {
        files.push({ path: childRelative, absolutePath: child, stats: details.stats })
      } else {
        throw new SnapshotStoreError(`Snapshot entry ${childRelative} is unsupported`)
      }
    }
  }

  await visit(root, '')
  return { files, metadataFound }
}

async function hashFile(path, context, label = 'Snapshot file') {
  await assertFile(path, context, label)
  throwIfAborted(context.signal)
  let content
  try {
    content = await context.dependencies.readFile(path)
  } catch (error) {
    throw new SnapshotStoreError(`Unable to read ${label} ${path}: ${errorMessage(error)}`, { cause: error })
  }
  throwIfAborted(context.signal)
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content)
  return {
    bytes: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

async function hashTreeFiles(tree, context) {
  const records = []
  for (const file of sortFiles(tree.files)) {
    throwIfAborted(context.signal)
    const digest = await hashFile(file.absolutePath, context, `Snapshot file ${file.path}`)
    records.push({ path: file.path, ...digest })
  }
  return records
}

function compareInventoryFiles(actual, expected) {
  const actualMap = new Map(actual.map(file => [file.path, file]))
  const expectedMap = new Map(expected.files.map(file => [file.path, file]))
  if (actual.length !== expected.files.length) throw new SnapshotIntegrityError('Snapshot file count does not match its inventory')
  for (const [path, expectedFile] of expectedMap) {
    const actualFile = actualMap.get(path)
    if (actualFile === undefined) throw new SnapshotIntegrityError(`Snapshot file ${path} is missing`)
    if (actualFile.bytes !== expectedFile.bytes || actualFile.sha256 !== expectedFile.sha256) {
      throw new SnapshotIntegrityError(`Snapshot file ${path} does not match its inventory`)
    }
  }
  const bytes = sumBytes(actual)
  if (bytes !== expected.bytes) throw new SnapshotIntegrityError('Snapshot byte count does not match its inventory')
}

async function verifyTreeAgainstInventory(root, inventory, context, options = {}) {
  const tree = await walkFiles(root, context, { ...options, excludedRelativePaths: options.excludedRelativePaths ?? context.excludedRelativePaths })
  const actual = await hashTreeFiles(tree, context)
  compareInventoryFiles(actual, inventory)
  return actual
}

async function readInventory(path, context, expectedSnapshotId) {
  await assertFile(path, context, 'Snapshot inventory')
  throwIfAborted(context.signal)
  let content
  try {
    content = await context.dependencies.readFile(path, 'utf8')
  } catch (error) {
    throw new SnapshotIntegrityError(`Unable to read snapshot inventory ${path}: ${errorMessage(error)}`, { cause: error })
  }
  try {
    const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content)
    return validateInventory(JSON.parse(text), expectedSnapshotId)
  } catch (error) {
    if (error instanceof SnapshotIntegrityError || error instanceof SnapshotStoreError) throw error
    throw new SnapshotIntegrityError(`Invalid snapshot inventory ${path}: ${errorMessage(error)}`, { cause: error })
  }
}

async function verifySnapshotDirectory(directory, context, expectedSnapshotId) {
  await assertDirectory(directory, context, 'Snapshot directory')
  const inventoryPath = join(directory, SNAPSHOT_INVENTORY_NAME)
  const inventory = await readInventory(inventoryPath, context, expectedSnapshotId)
  const payloadDirectory = join(directory, SNAPSHOT_PAYLOAD_DIRECTORY)
  await assertDirectory(payloadDirectory, context, 'Snapshot payload')
  await verifyTreeAgainstInventory(payloadDirectory, inventory, context)
  return inventory
}

function inventoryFor(snapshotId, kind, createdAt, files) {
  const normalizedFiles = sortFiles(files.map(file => ({
    path: normalizeRelativeFilePath(file.path),
    bytes: file.bytes,
    sha256: file.sha256.toLowerCase(),
  })))
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    kind,
    createdAt,
    count: normalizedFiles.length,
    bytes: sumBytes(normalizedFiles),
    files: normalizedFiles,
  }
}

async function writeInventory(directory, inventory, context) {
  const path = join(directory, SNAPSHOT_INVENTORY_NAME)
  throwIfAborted(context.signal)
  try {
    await context.dependencies.writeFile(path, serializeInventory(inventory), { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    throw new SnapshotStoreError(`Unable to write snapshot inventory ${path}: ${errorMessage(error)}`, { cause: error })
  }
  await invokeFault(context.dependencies, 'create:after-inventory', { path, inventory, signal: context.signal })
}

async function copySourceTree(sourceRoot, stageRoot, context) {
  const records = []

  async function visit(sourceDirectory, destinationDirectory, prefix) {
    throwIfAborted(context.signal)
    const names = await readDirectoryEntries(sourceDirectory, context, 'source tree')
    for (const name of names) {
      throwIfAborted(context.signal)
      const sourcePath = join(sourceDirectory, name)
      const destinationPath = join(destinationDirectory, name)
      const childRelative = relativePath(prefix, name)
      if (isExcluded(childRelative, context.excludedRelativePaths)) continue
      const details = await inspectPath(sourcePath, { ...context, label: `Source entry ${childRelative}` })
      if (details.kind === 'directory') {
        try {
          await context.dependencies.mkdir(destinationPath, { recursive: false, mode: 0o700 })
        } catch (error) {
          throw new SnapshotStoreError(`Unable to create staged directory ${destinationPath}: ${errorMessage(error)}`, { cause: error })
        }
        await visit(sourcePath, destinationPath, childRelative)
        continue
      }
      if (details.kind !== 'file') throw new SnapshotStoreError(`Source entry ${childRelative} is unsupported`)

      await invokeFault(context.dependencies, 'create:before-copy', {
        sourcePath,
        destinationPath,
        relativePath: childRelative,
        signal: context.signal,
      })
      throwIfAborted(context.signal)
      try {
        await context.dependencies.copyFile(sourcePath, destinationPath)
      } catch (error) {
        throw new SnapshotStoreError(`Unable to copy source file ${childRelative}: ${errorMessage(error)}`, { cause: error })
      }
      await invokeFault(context.dependencies, 'create:after-copy', {
        sourcePath,
        destinationPath,
        relativePath: childRelative,
        signal: context.signal,
      })
      const digest = await hashFile(destinationPath, context, `Staged snapshot file ${childRelative}`)
      records.push({ path: childRelative, ...digest })
    }
  }

  await visit(sourceRoot, stageRoot, '')
  return sortFiles(records)
}

async function copySnapshotTree(snapshotDirectory, stageRoot, inventory, context) {
  const payloadDirectory = join(snapshotDirectory, SNAPSHOT_PAYLOAD_DIRECTORY)
  for (const file of inventory.files) {
    throwIfAborted(context.signal)
    const sourcePath = join(payloadDirectory, ...file.path.split('/'))
    const destinationPath = join(stageRoot, ...file.path.split('/'))
    assertWithin(payloadDirectory, sourcePath, `Snapshot file ${file.path}`)
    assertWithin(stageRoot, destinationPath, `Restore file ${file.path}`)
    const parent = dirname(destinationPath)
    try {
      await context.dependencies.mkdir(parent, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new SnapshotStoreError(`Unable to create restore directory ${parent}: ${errorMessage(error)}`, { cause: error })
    }
    await assertFile(sourcePath, context, `Snapshot file ${file.path}`)
    await invokeFault(context.dependencies, 'restore:before-copy', {
      sourcePath,
      destinationPath,
      relativePath: file.path,
      signal: context.signal,
    })
    try {
      await context.dependencies.copyFile(sourcePath, destinationPath)
    } catch (error) {
      throw new SnapshotStoreError(`Unable to copy snapshot file ${file.path}: ${errorMessage(error)}`, { cause: error })
    }
    await invokeFault(context.dependencies, 'restore:after-copy', {
      sourcePath,
      destinationPath,
      relativePath: file.path,
      signal: context.signal,
    })
    const digest = await hashFile(destinationPath, context, `Staged restore file ${file.path}`)
    if (digest.bytes !== file.bytes || digest.sha256 !== file.sha256) {
      throw new SnapshotIntegrityError(`Copied snapshot file ${file.path} does not match its inventory`)
    }
  }
}

function defaultSnapshotRoot(sourceRoot) {
  const sourceName = basename(sourceRoot)
  // Hidden Windows/POSIX profile roots such as `.dsh` already carry their
  // privacy prefix. Adding another dot produced `..dsh-snapshots`, so the
  // desktop and its recovery tools could disagree about the snapshot owner.
  return join(dirname(sourceRoot), `${sourceName.startsWith('.') ? '' : '.'}${sourceName}-snapshots`)
}

function rootOption(options, names) {
  for (const name of names) {
    if (options[name] !== undefined) return options[name]
  }
  return undefined
}

function normalizeConstructorOptions(input, snapshotRoot, maybeOptions) {
  if (typeof input === 'string') {
    return { ...(maybeOptions ?? {}), sourceRoot: input, ...(snapshotRoot === undefined ? {} : { snapshotRoot }) }
  }
  return { ...(input ?? {}) }
}

function normalizeMethodOptions(input, maybeOptions) {
  if (typeof input === 'string') return { ...(maybeOptions ?? {}), sourceRoot: input }
  return { ...(input ?? {}) }
}

function resolveRoots(baseOptions, operationOptions, { requireSource = false, requireSnapshot = false } = {}) {
  const merged = { ...baseOptions, ...operationOptions }
  const sourceValue = rootOption(merged, ['sourceRoot', 'dshHome', 'homeRoot', 'dataRoot', 'root'])
  const sourceRoot = sourceValue === undefined ? undefined : validateAbsolutePath(sourceValue, 'Source root')
  const snapshotValue = rootOption(merged, ['snapshotRoot', 'snapshotsRoot', 'snapshotStore', 'snapshotsDir', 'storeRoot'])
  const snapshotRoot = snapshotValue === undefined && sourceRoot !== undefined
    ? defaultSnapshotRoot(sourceRoot)
    : snapshotValue === undefined ? undefined : validateAbsolutePath(snapshotValue, 'Snapshot root')
  if (requireSource && sourceRoot === undefined) throw new TypeError('Source root is required')
  if (requireSnapshot && snapshotRoot === undefined) throw new TypeError('Snapshot root is required')
  if (sourceRoot !== undefined && snapshotRoot !== undefined && (isWithin(sourceRoot, snapshotRoot) || isWithin(snapshotRoot, sourceRoot))) {
    throw new SnapshotStoreError('Source root and snapshot root must be separate directories')
  }
  return { sourceRoot, snapshotRoot }
}

function operationContext(baseOptions, operationOptions) {
  const merged = { ...baseOptions, ...operationOptions }
  return {
    dependencies: createDependencies(merged),
    platform: merged.platform ?? baseOptions.platform ?? process.platform,
    signal: merged.signal,
    excludedRelativePaths: normalizeExcludedRelativePaths(
      merged.excludedRelativePaths
        ?? merged.exclusions
        ?? baseOptions.excludedRelativePaths
        ?? baseOptions.exclusions
        ?? [],
    ),
  }
}

function uniqueToken(dependencies) {
  try {
    return String(dependencies.randomUUID())
  } catch {
    return randomUUIDValue()
  }
}

function generatedSnapshotId(dependencies) {
  return `snapshot-${Date.now().toString(36)}-${uniqueToken(dependencies)}`
}

function summaryFor(inventory, directory, extra = {}) {
  return {
    snapshotId: inventory.snapshotId,
    id: inventory.snapshotId,
    directory,
    path: directory,
    createdAt: inventory.createdAt,
    kind: inventory.kind,
    count: inventory.count,
    bytes: inventory.bytes,
    inventory,
    ...extra,
  }
}

async function pathExists(path, context, label) {
  return (await inspectPath(path, { ...context, label, allowMissing: true })) !== undefined
}

async function moveExcludedEntries(sourceRoot, destinationRoot, excludedRelativePaths, context) {
  const moved = []
  try {
    for (const relativeValue of excludedRelativePaths) {
      const sourcePath = join(sourceRoot, ...relativeValue.split('/'))
      const destinationPath = join(destinationRoot, ...relativeValue.split('/'))
      assertWithin(sourceRoot, sourcePath, `Excluded source ${relativeValue}`)
      assertWithin(destinationRoot, destinationPath, `Excluded destination ${relativeValue}`)
      let details
      try {
        details = await context.dependencies.lstat(sourcePath)
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw new SnapshotStoreError(`Unable to inspect excluded source ${relativeValue}: ${errorMessage(error)}`, { cause: error })
      }
      if (!statKind(details)) throw new SnapshotStoreError(`Excluded source ${relativeValue} is unsupported`)
      try {
        await context.dependencies.mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 })
        await context.dependencies.rename(sourcePath, destinationPath)
      } catch (error) {
        throw new SnapshotStoreError(`Unable to preserve excluded source ${relativeValue}: ${errorMessage(error)}`, { cause: error })
      }
      moved.push(relativeValue)
    }
    return moved
  } catch (error) {
    try { await moveExcludedEntriesBack(destinationRoot, sourceRoot, moved, context) } catch { /* preserve original error */ }
    throw error
  }
}

async function moveExcludedEntriesBack(sourceRoot, destinationRoot, excludedRelativePaths, context) {
  for (const relativeValue of [...excludedRelativePaths].reverse()) {
    const sourcePath = join(sourceRoot, ...relativeValue.split('/'))
    const destinationPath = join(destinationRoot, ...relativeValue.split('/'))
    let sourceDetails
    try {
      sourceDetails = await context.dependencies.lstat(sourcePath)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (!statKind(sourceDetails)) continue
    await context.dependencies.mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 })
    await context.dependencies.rename(sourcePath, destinationPath)
  }
}

async function rollbackRestore({ sourceRoot, backupPath, failedPath, context, originalError, movedOriginal }) {
  const rollbackErrors = []
  let backupExists = false
  try {
    backupExists = await pathExists(backupPath, context, 'Restore backup')
  } catch (error) {
    rollbackErrors.push(error)
  }

  let sourceExists = false
  try {
    sourceExists = await pathExists(sourceRoot, context, 'Restore source')
  } catch (error) {
    rollbackErrors.push(error)
  }

  let rescuePath
  if (backupExists && sourceExists) {
    try {
      await context.dependencies.rename(sourceRoot, failedPath)
      rescuePath = failedPath
      sourceExists = false
    } catch (error) {
      rollbackErrors.push(new SnapshotStoreError(`Unable to preserve failed restored data: ${errorMessage(error)}`, { cause: error }))
    }
  } else if (!backupExists && !movedOriginal && sourceExists) {
    try {
      await context.dependencies.rename(sourceRoot, failedPath)
      rescuePath = failedPath
      sourceExists = false
    } catch (error) {
      rollbackErrors.push(new SnapshotStoreError(`Unable to preserve failed restored data: ${errorMessage(error)}`, { cause: error }))
    }
  }

  if (backupExists) {
    try {
      if (!sourceExists) {
        await context.dependencies.rename(backupPath, sourceRoot)
      } else {
        rollbackErrors.push(new SnapshotStoreError('Restore source remains occupied; original data was not moved back'))
      }
    } catch (error) {
      rollbackErrors.push(new SnapshotStoreError(`Unable to restore original data: ${errorMessage(error)}`, { cause: error }))
    }
  }

  const message = `Snapshot restore failed: ${errorMessage(originalError)}`
  const failure = new SnapshotStoreError(message, { cause: originalError })
  if (rescuePath !== undefined) failure.rescuePath = rescuePath
  if (backupExists) failure.backupPath = backupPath
  if (rollbackErrors.length > 0) failure.rollbackError = rollbackErrors.length === 1 ? rollbackErrors[0] : new AggregateError(rollbackErrors, 'Snapshot restore rollback failed')
  return failure
}

export class SnapshotStore {
  constructor(input = {}, snapshotRoot, maybeOptions) {
    this.options = normalizeConstructorOptions(input, snapshotRoot, maybeOptions)
    this.platform = this.options.platform ?? process.platform
    this.dependencies = createDependencies(this.options)
  }

  async create(input = {}, maybeOptions) {
    const options = normalizeMethodOptions(input, maybeOptions)
    const roots = resolveRoots(this.options, options, { requireSource: true, requireSnapshot: true })
    const context = operationContext(this.options, options)
    const { sourceRoot, snapshotRoot } = roots
    throwIfAborted(context.signal)
    await invokeFault(context.dependencies, 'create:start', { sourceRoot, snapshotRoot, signal: context.signal })
    await assertDirectory(sourceRoot, context, 'Source root')
    await ensureDirectory(snapshotRoot, context, 'Snapshot root')

    const snapshotId = validateSnapshotId(options.snapshotId ?? options.id ?? generatedSnapshotId(context.dependencies))
    const kind = validateSnapshotKind(options.kind ?? 'pre-switch')
    const finalDirectory = join(snapshotRoot, snapshotId)
    assertWithin(snapshotRoot, finalDirectory, 'Snapshot directory')
    await assertAbsent(finalDirectory, context, 'Snapshot directory')
    const stageDirectory = join(snapshotRoot, `.staging-${snapshotId}-${uniqueToken(context.dependencies)}`)
    assertWithin(snapshotRoot, stageDirectory, 'Snapshot staging directory')
    await assertAbsent(stageDirectory, context, 'Snapshot staging directory')
    try {
      await context.dependencies.mkdir(stageDirectory, { recursive: false, mode: 0o700 })
    } catch (error) {
      throw new SnapshotStoreError(`Unable to create snapshot staging directory ${stageDirectory}: ${errorMessage(error)}`, { cause: error })
    }

    try {
      const createdAt = canonicalTimestamp(options.createdAt ?? options.now ?? this.options.createdAt ?? this.options.now)
      const payloadDirectory = join(stageDirectory, SNAPSHOT_PAYLOAD_DIRECTORY)
      await context.dependencies.mkdir(payloadDirectory, { recursive: false, mode: 0o700 })
      const files = await copySourceTree(sourceRoot, payloadDirectory, context)
      throwIfAborted(context.signal)
      const inventory = inventoryFor(snapshotId, kind, createdAt, files)
      await writeInventory(stageDirectory, inventory, context)
      await verifySnapshotDirectory(stageDirectory, context, snapshotId)
      throwIfAborted(context.signal)
      await invokeFault(context.dependencies, 'create:before-publish', {
        stageDirectory,
        finalDirectory,
        inventory,
        signal: context.signal,
      })
      throwIfAborted(context.signal)
      await context.dependencies.rename(stageDirectory, finalDirectory)
      await invokeFault(context.dependencies, 'create:after-publish', {
        directory: finalDirectory,
        inventory,
        signal: context.signal,
      })
      const published = await verifySnapshotDirectory(finalDirectory, context, snapshotId)
      return summaryFor(published, finalDirectory)
    } catch (error) {
      const failure = error instanceof SnapshotStoreError || error instanceof SnapshotIntegrityError
        ? error
        : new SnapshotStoreError(`Unable to publish snapshot ${snapshotId}: ${errorMessage(error)}`, { cause: error })
      try {
        await context.dependencies.rm(stageDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch (cleanupError) {
        failure.cleanupError = new SnapshotStoreError(`Unable to remove failed snapshot staging directory ${stageDirectory}: ${errorMessage(cleanupError)}`, { cause: cleanupError })
      }
      throw failure
    }
  }

  async list(input = {}) {
    const options = normalizeMethodOptions(input)
    const roots = resolveRoots(this.options, options, { requireSnapshot: true })
    const context = operationContext(this.options, options)
    const { snapshotRoot } = roots
    throwIfAborted(context.signal)
    const root = await assertDirectory(snapshotRoot, context, 'Snapshot root', { allowMissing: true })
    if (root === undefined) return []
    const names = await readDirectoryEntries(snapshotRoot, context, 'Snapshot root')
    const snapshots = []
    for (const name of names) {
      throwIfAborted(context.signal)
      const directory = join(snapshotRoot, name)
      const details = await inspectPath(directory, { ...context, label: `Snapshot root entry ${name}` })
      if (name.startsWith('.staging-')) {
        if (details.kind !== 'directory') throw new SnapshotStoreError(`Snapshot staging entry ${name} is unsupported`)
        continue
      }
      validateSnapshotId(name)
      if (details.kind !== 'directory') throw new SnapshotStoreError(`Snapshot root entry ${name} is unsupported`)
      const inventory = await verifySnapshotDirectory(directory, context, name)
      snapshots.push(summaryFor(inventory, directory, { inventory: undefined }))
    }
    return snapshots.sort((left, right) => {
      const leftTime = left.createdAt ?? ''
      const rightTime = right.createdAt ?? ''
      if (leftTime !== rightTime) return rightTime < leftTime ? -1 : 1
      return left.snapshotId < right.snapshotId ? -1 : left.snapshotId > right.snapshotId ? 1 : 0
    })
  }

  async sizeReport(input = {}, maybeOptions) {
    const options = typeof input === 'string' ? { ...(maybeOptions ?? {}), target: input } : { ...(input ?? {}) }
    const roots = resolveRoots(this.options, options, { requireSnapshot: options.snapshotId !== undefined || (typeof options.target === 'string' && !isAbsolute(options.target)) })
    const context = operationContext(this.options, options)
    throwIfAborted(context.signal)
    if (options.snapshotId !== undefined || (typeof options.target === 'string' && !isAbsolute(options.target))) {
      const snapshotId = validateSnapshotId(options.snapshotId ?? options.target)
      const directory = join(roots.snapshotRoot, snapshotId)
      const inventory = await verifySnapshotDirectory(directory, context, snapshotId)
      return { count: inventory.count, bytes: inventory.bytes }
    }
    const target = options.target ?? options.root ?? options.sourceRoot ?? roots.sourceRoot
    const root = validateAbsolutePath(target, 'Size report root')
    await assertDirectory(root, context, 'Size report root')
    const tree = await walkFiles(root, context)
    let bytes = 0
    for (const file of tree.files) {
      throwIfAborted(context.signal)
      const size = file.stats?.size
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SAFE_BYTES - bytes) {
        throw new SnapshotStoreError(`Invalid size for ${file.path}`)
      }
      bytes += size
    }
    return { count: tree.files.length, bytes }
  }

  async restore(input, maybeOptions) {
    const options = typeof input === 'string' ? { ...(maybeOptions ?? {}), snapshotId: input } : { ...(input ?? {}) }
    const snapshotId = validateSnapshotId(options.snapshotId ?? options.id)
    const roots = resolveRoots(this.options, options, { requireSource: true, requireSnapshot: true })
    const context = operationContext(this.options, options)
    const { sourceRoot, snapshotRoot } = roots
    throwIfAborted(context.signal)
    await invokeFault(context.dependencies, 'restore:start', { sourceRoot, snapshotRoot, snapshotId, signal: context.signal })
    await assertDirectory(snapshotRoot, context, 'Snapshot root')
    const snapshotDirectory = join(snapshotRoot, snapshotId)
    assertWithin(snapshotRoot, snapshotDirectory, 'Snapshot directory')
    const inventory = await verifySnapshotDirectory(snapshotDirectory, context, snapshotId)
    throwIfAborted(context.signal)

    // Recovery can be interrupted after the restored tree has been published
    // but before the release journal is cleared. Prove the current non-derived
    // tree against the exact snapshot inventory first; if it already matches,
    // make restore idempotent instead of exchanging the whole DSH home again.
    // Excluded runtime/cache paths are intentionally ignored by the same policy
    // used when the snapshot was created and remain untouched.
    try {
      await verifyTreeAgainstInventory(sourceRoot, inventory, context)
      return summaryFor(inventory, sourceRoot, { snapshotDirectory, alreadyRestored: true })
    } catch {
      // A missing or mismatched source is the normal first-restore case. Fall
      // through to the atomic staged swap below so an incomplete tree is never
      // accepted as restored.
    }

    const sourceParent = dirname(sourceRoot)
    await assertDirectory(sourceParent, context, 'Source parent')
    const stageDirectory = join(sourceParent, `.snapshot-restore-staging-${snapshotId}-${uniqueToken(context.dependencies)}`)
    const backupPath = join(sourceParent, `.snapshot-restore-backup-${snapshotId}-${uniqueToken(context.dependencies)}`)
    const failedPath = join(sourceParent, `.snapshot-restore-failed-${snapshotId}-${uniqueToken(context.dependencies)}`)
    assertWithin(sourceParent, stageDirectory, 'Restore staging directory')
    assertWithin(sourceParent, backupPath, 'Restore backup directory')
    assertWithin(sourceParent, failedPath, 'Failed restore directory')
    await assertAbsent(stageDirectory, context, 'Restore staging directory')
    await assertAbsent(backupPath, context, 'Restore backup directory')
    await assertAbsent(failedPath, context, 'Failed restore directory')
    try {
      await context.dependencies.mkdir(stageDirectory, { recursive: false, mode: 0o700 })
    } catch (error) {
      throw new SnapshotStoreError(`Unable to create restore staging directory ${stageDirectory}: ${errorMessage(error)}`, { cause: error })
    }

    try {
      await copySnapshotTree(snapshotDirectory, stageDirectory, inventory, context)
      await verifyTreeAgainstInventory(stageDirectory, inventory, context)
      throwIfAborted(context.signal)
      await invokeFault(context.dependencies, 'restore:before-swap', {
        stageDirectory,
        sourceRoot,
        backupPath,
        inventory,
        signal: context.signal,
      })
    } catch (error) {
      try {
        await context.dependencies.rm(stageDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch (cleanupError) {
        const failure = new SnapshotStoreError(`Snapshot restore staging failed: ${errorMessage(error)}`, { cause: error })
        failure.cleanupError = new SnapshotStoreError(`Unable to remove restore staging directory ${stageDirectory}: ${errorMessage(cleanupError)}`, { cause: cleanupError })
        throw failure
      }
      throw error
    }

    let sourceWasMoved = false
    let movedExcludedPaths = []
    try {
      const sourceExists = await pathExists(sourceRoot, context, 'Source root')
      if (sourceExists) {
        await assertDirectory(sourceRoot, context, 'Source root')
        throwIfAborted(context.signal)
        await context.dependencies.rename(sourceRoot, backupPath)
        sourceWasMoved = true
        movedExcludedPaths = await moveExcludedEntries(backupPath, stageDirectory, context.excludedRelativePaths, context)
        await invokeFault(context.dependencies, 'restore:after-original-move', {
          sourceRoot,
          backupPath,
          signal: context.signal,
        })
      }
      throwIfAborted(context.signal)
      await invokeFault(context.dependencies, 'restore:before-publish', {
        stageDirectory,
        sourceRoot,
        signal: context.signal,
      })
      await context.dependencies.rename(stageDirectory, sourceRoot)
      await invokeFault(context.dependencies, 'restore:after-publish', {
        sourceRoot,
        backupPath,
        inventory,
        signal: context.signal,
      })
      throwIfAborted(context.signal)
      await verifyTreeAgainstInventory(sourceRoot, inventory, context)
      return summaryFor(inventory, sourceRoot, { snapshotDirectory, rescuePath: sourceWasMoved ? backupPath : undefined })
    } catch (error) {
      try { await moveExcludedEntriesBack(stageDirectory, backupPath, movedExcludedPaths, context) } catch { /* preserve original error */ }
      try { await moveExcludedEntriesBack(sourceRoot, backupPath, movedExcludedPaths, context) } catch { /* preserve original error */ }
      throw await rollbackRestore({
        sourceRoot,
        backupPath,
        failedPath,
        context,
        originalError: error,
        movedOriginal: sourceWasMoved,
      })
    }
  }
}

export function createSnapshotStore(options, snapshotRoot, maybeOptions) {
  return new SnapshotStore(options, snapshotRoot, maybeOptions)
}

export async function createSnapshot(options, maybeOptions) {
  const store = options instanceof SnapshotStore ? options : new SnapshotStore(options, maybeOptions?.snapshotRoot, maybeOptions)
  return store.create(options instanceof SnapshotStore ? maybeOptions : options)
}

export async function listSnapshots(options, maybeOptions) {
  const store = options instanceof SnapshotStore ? options : new SnapshotStore(options, maybeOptions?.snapshotRoot, maybeOptions)
  return store.list(options instanceof SnapshotStore ? maybeOptions : {})
}

export async function sizeReport(options, maybeOptions) {
  const store = options instanceof SnapshotStore ? options : new SnapshotStore(options, maybeOptions?.snapshotRoot, maybeOptions)
  return store.sizeReport(options instanceof SnapshotStore ? maybeOptions : options)
}

export async function restoreSnapshot(options, maybeOptions) {
  const store = options instanceof SnapshotStore ? options : new SnapshotStore(options, maybeOptions?.snapshotRoot, maybeOptions)
  return store.restore(options instanceof SnapshotStore ? maybeOptions : options)
}

export default SnapshotStore
