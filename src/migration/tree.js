import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import {
  assertGeneratedPathInside,
  assertNoLinkedEntry,
  assertNoReparsePoint,
  assertNoSourceDestinationOverlap,
  assertTreeHasNoReparsePoints,
  MigrationSafetyError,
} from './path-safety.js'

const DEFAULT_RETRY_LIMIT = 3

function abortIfNeeded(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Migration operation aborted')
}

function relativePath(root, pathValue) {
  const value = relative(root, pathValue)
  return value.split(sep).join(posix.sep)
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function manifestDigest(entries, excludedRelativePaths = []) {
  return createHash('sha256').update(JSON.stringify({
    entries: sortEntries(entries),
    excludedRelativePaths: [...excludedRelativePaths].sort(),
  })).digest('hex')
}

function normalizeExclusions(root, excludedRelativePaths = []) {
  if (!Array.isArray(excludedRelativePaths)) throw new TypeError('excludedRelativePaths must be an array')
  const normalized = [...new Set(excludedRelativePaths.map(value => {
    const candidate = String(value).replaceAll('\\', '/')
    if (candidate.length === 0 || isAbsolute(candidate) || candidate === '..' || candidate.startsWith('../') || candidate.includes('/../')) {
      throw new MigrationSafetyError(`Invalid migration exclusion: ${value}`, 'MIGRATION_EXCLUSION_INVALID')
    }
    return candidate.replace(/^\.\//, '').replace(/\/$/, '')
  }))].sort()
  return {
    relativePaths: normalized,
    absoluteRoots: normalized.map(value => resolve(root, ...value.split('/'))),
  }
}

function isExcluded(relativeValue, excludedRelativePaths) {
  return excludedRelativePaths.some(excluded => relativeValue === excluded || relativeValue.startsWith(`${excluded}/`))
}

export function serializeTreeEntries(entries) {
  return JSON.stringify(sortEntries(entries))
}

export function manifestsEqual(first, second) {
  if (first === undefined || second === undefined) return false
  return first.rootSha256 === second.rootSha256 && serializeTreeEntries(first.entries) === serializeTreeEntries(second.entries)
}

export function sha256File(filePath) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function inspectRegularFile(filePath) {
  const stats = await lstat(filePath)
  assertNoLinkedEntry(filePath, stats)
  if (!stats.isFile()) throw new MigrationSafetyError(`${filePath} is not a regular file`, 'MIGRATION_NON_REGULAR_ENTRY')
  return stats
}

async function stableFileHash(filePath, retryLimit) {
  let lastError
  for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
    abortIfNeeded()
    try {
      const before = await inspectRegularFile(filePath)
      const firstHash = await sha256File(filePath)
      const after = await inspectRegularFile(filePath)
      const secondHash = await sha256File(filePath)
      if (before.size === after.size && firstHash === secondHash) {
        return { sha256: firstHash, size: after.size }
      }
      lastError = new MigrationSafetyError(
        `File changed while hashing: ${filePath} (attempt ${attempt}/${retryLimit})`,
        'MIGRATION_SOURCE_DRIFT',
      )
    } catch (error) {
      if (error?.code === 'MIGRATION_REPARSE_POINT' || error?.code === 'MIGRATION_NON_REGULAR_ENTRY') throw error
      lastError = error
    }
  }
  throw new MigrationSafetyError(
    `Unable to obtain a stable hash for ${filePath} after ${retryLimit} attempts`,
    'MIGRATION_SOURCE_SNAPSHOT_UNSTABLE',
    { cause: lastError },
  )
}

async function walkTree(root, current, entries, { retryLimit, signal, excludedRelativePaths }) {
  abortIfNeeded(signal)
  const children = await readdir(current, { withFileTypes: true })
  children.sort((a, b) => a.name.localeCompare(b.name))
  for (const child of children) {
    abortIfNeeded(signal)
    const childPath = join(current, child.name)
    const childRelativePath = relativePath(root, childPath)
    if (isExcluded(childRelativePath, excludedRelativePaths)) continue
    const stats = await lstat(childPath)
    assertNoLinkedEntry(childPath, stats)
    if (stats.isDirectory()) {
      await walkTree(root, childPath, entries, { retryLimit, signal, excludedRelativePaths })
      continue
    }
    if (!stats.isFile()) throw new MigrationSafetyError(`${childPath} is not a regular file`, 'MIGRATION_NON_REGULAR_ENTRY')
    const stable = await stableFileHash(childPath, retryLimit)
    entries.push({
      relativePath: relativePath(root, childPath),
      type: 'file',
      size: stable.size,
      sha256: stable.sha256,
    })
  }
}

export async function snapshotTree(root, { retryLimit = DEFAULT_RETRY_LIMIT, signal, excludedRelativePaths = [] } = {}) {
  if (!Number.isInteger(retryLimit) || retryLimit < 1 || retryLimit > 10) {
    throw new TypeError('retryLimit must be an integer between 1 and 10')
  }
  const rootStats = await lstat(root)
  assertNoReparsePoint(root, rootStats)
  if (!rootStats.isDirectory()) throw new MigrationSafetyError(`${root} is not a directory`, 'MIGRATION_SOURCE_NOT_DIRECTORY')
  const exclusions = normalizeExclusions(root, excludedRelativePaths)
  assertTreeHasNoReparsePoints(root, { excludedRoots: exclusions.absoluteRoots })
  const entries = []
  await walkTree(root, root, entries, { retryLimit, signal, excludedRelativePaths: exclusions.relativePaths })
  const sorted = sortEntries(entries)
  return {
    root: root,
    fileCount: sorted.length,
    totalBytes: sorted.reduce((total, entry) => total + entry.size, 0),
    entries: sorted,
    excludedRelativePaths: exclusions.relativePaths,
    rootSha256: manifestDigest(sorted, exclusions.relativePaths),
  }
}

async function ensureDirectory(pathValue) {
  await mkdir(pathValue, { recursive: true })
  const stats = await lstat(pathValue)
  assertNoLinkedEntry(pathValue, stats)
  if (!stats.isDirectory()) throw new MigrationSafetyError(`${pathValue} is not a directory`, 'MIGRATION_DESTINATION_NOT_DIRECTORY')
}

export async function copyTree(sourceRoot, targetRoot, {
  retryLimit = DEFAULT_RETRY_LIMIT,
  signal,
  copyFileImpl = copyFile,
  excludedRelativePaths = [],
} = {}) {
  if (!Number.isInteger(retryLimit) || retryLimit < 1 || retryLimit > 10) {
    throw new TypeError('retryLimit must be an integer between 1 and 10')
  }
  await assertNoSourceDestinationOverlap({ sourceRoot, destinationRoot: targetRoot })
  const sourceStats = await lstat(sourceRoot)
  assertNoReparsePoint(sourceRoot, sourceStats)
  if (!sourceStats.isDirectory()) throw new MigrationSafetyError(`${sourceRoot} is not a directory`, 'MIGRATION_SOURCE_NOT_DIRECTORY')
  const exclusions = normalizeExclusions(sourceRoot, excludedRelativePaths)
  assertTreeHasNoReparsePoints(sourceRoot, { excludedRoots: exclusions.absoluteRoots })
  await ensureDirectory(targetRoot)
  const entries = []

  async function copyDirectory(sourceDirectory, targetDirectory) {
    abortIfNeeded(signal)
    await ensureDirectory(targetDirectory)
    const children = await readdir(sourceDirectory, { withFileTypes: true })
    children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      abortIfNeeded(signal)
      const sourcePath = join(sourceDirectory, child.name)
      const sourceRelativePath = relativePath(sourceRoot, sourcePath)
      if (isExcluded(sourceRelativePath, exclusions.relativePaths)) continue
      const targetPath = assertGeneratedPathInside(targetRoot, join(targetDirectory, child.name), 'copy target')
      const stats = await lstat(sourcePath)
      assertNoLinkedEntry(sourcePath, stats)
      if (stats.isDirectory()) {
        await copyDirectory(sourcePath, targetPath)
        continue
      }
      if (!stats.isFile()) throw new MigrationSafetyError(`${sourcePath} is not a regular file`, 'MIGRATION_NON_REGULAR_ENTRY')

      let copied
      let lastDrift
      for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
        abortIfNeeded(signal)
        const sourceBefore = await stableFileHash(sourcePath, retryLimit)
        await ensureDirectory(dirname(targetPath))
        await copyFileImpl(sourcePath, targetPath)
        const destinationStats = await lstat(targetPath)
        assertNoLinkedEntry(targetPath, destinationStats)
        if (!destinationStats.isFile()) throw new MigrationSafetyError(`${targetPath} is not a regular file`, 'MIGRATION_NON_REGULAR_ENTRY')
        const destinationHash = await sha256File(targetPath)
        const sourceAfter = await stableFileHash(sourcePath, retryLimit)
        if (sourceBefore.sha256 === sourceAfter.sha256 && sourceBefore.size === sourceAfter.size && destinationHash === sourceBefore.sha256) {
          copied = { relativePath: relativePath(sourceRoot, sourcePath), type: 'file', size: sourceBefore.size, sha256: destinationHash }
          break
        }
        lastDrift = new MigrationSafetyError(
          `Source changed while copying ${sourcePath} (attempt ${attempt}/${retryLimit})`,
          'MIGRATION_SOURCE_DRIFT',
        )
      }
      if (copied === undefined) {
        throw new MigrationSafetyError(
          `Unable to copy a consistent snapshot of ${sourcePath}`,
          'MIGRATION_SOURCE_SNAPSHOT_UNSTABLE',
          { cause: lastDrift },
        )
      }
      entries.push(copied)
    }
  }

  await copyDirectory(sourceRoot, targetRoot)
  assertTreeHasNoReparsePoints(sourceRoot, { excludedRoots: exclusions.absoluteRoots })
  assertTreeHasNoReparsePoints(targetRoot)
  const sorted = sortEntries(entries)
  return {
    sourceRoot,
    targetRoot,
    fileCount: sorted.length,
    totalBytes: sorted.reduce((total, entry) => total + entry.size, 0),
    entries: sorted,
    excludedRelativePaths: exclusions.relativePaths,
    rootSha256: manifestDigest(sorted, exclusions.relativePaths),
  }
}
