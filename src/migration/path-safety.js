import { execFileSync } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import process from 'node:process'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class MigrationSafetyError extends Error {
  constructor(message, code = 'MIGRATION_SAFETY_ERROR', options = {}) {
    super(message, options)
    this.name = 'MigrationSafetyError'
    this.code = code
  }
}

function normalizeComparablePath(pathValue) {
  const absolute = resolve(pathValue)
  const normalized = absolute.replace(/[\\/]+/g, sep)
  const withoutTrailingSeparator = normalized.length > 1
    ? normalized.replace(new RegExp(`${sep.replace('\\', '\\\\')}+$`), '')
    : normalized
  return process.platform === 'win32' ? withoutTrailingSeparator.toLowerCase() : withoutTrailingSeparator
}

export function assertAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new MigrationSafetyError(`${label} must be an explicit absolute path`, 'MIGRATION_PATH_NOT_ABSOLUTE')
  }
  return resolve(value)
}

export function isPathWithin(parent, child) {
  const parentComparable = normalizeComparablePath(parent)
  const childComparable = normalizeComparablePath(child)
  return childComparable === parentComparable || childComparable.startsWith(`${parentComparable}${sep}`)
}

export function assertPathWithin(parent, child, label = 'Path') {
  if (!isPathWithin(parent, child)) {
    throw new MigrationSafetyError(`${label} is outside the allowed root`, 'MIGRATION_PATH_ESCAPE')
  }
  return child
}

const reparsePointCache = new Map()

function windowsReparsePointProbe(pathValue) {
  const cached = reparsePointCache.get(pathValue)
  if (cached !== undefined) return cached

  if (process.platform !== 'win32') {
    reparsePointCache.set(pathValue, false)
    return false
  }

  try {
    execFileSync('fsutil.exe', ['reparsepoint', 'query', pathValue], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    const isReparsePoint = true
    reparsePointCache.set(pathValue, isReparsePoint)
    return isReparsePoint
  } catch (error) {
    // fsutil returns exit code 1 for an ordinary file/directory. Any other
    // failure means that the reparse status is unknown, so fail closed.
    if (error?.status === 1) {
      reparsePointCache.set(pathValue, false)
      return false
    }
    throw new MigrationSafetyError(
      `Unable to determine whether ${pathValue} is a Windows reparse point; refusing to continue`,
      'MIGRATION_REPARSE_PROBE_UNAVAILABLE',
      { cause: error },
    )
  }
}

export function isReparsePoint(pathValue, stats) {
  if (stats?.isSymbolicLink?.() === true) return true
  return windowsReparsePointProbe(pathValue)
}

export function assertNoReparsePoint(pathValue, stats) {
  if (isReparsePoint(pathValue, stats)) {
    throw new MigrationSafetyError(`${pathValue} is a symbolic link or reparse point`, 'MIGRATION_REPARSE_POINT')
  }
  return stats
}

export function assertNoLinkedEntry(pathValue, stats) {
  if (stats?.isSymbolicLink?.() === true) {
    throw new MigrationSafetyError(`${pathValue} is a symbolic link or reparse point`, 'MIGRATION_REPARSE_POINT')
  }
  return stats
}

/** Scan a complete Windows tree in one process instead of starting fsutil once per file. */
export function assertTreeHasNoReparsePoints(root, { excludedRoots = [] } = {}) {
  if (process.platform !== 'win32') return
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    '$root = [string]$payload.root',
    '$excludedRoots = @($payload.excludedRoots | ForEach-Object { [string]$_ })',
    '$rootItem = Get-Item -LiteralPath $root -Force',
    '$items = @()',
    'if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $items += $rootItem }',
    '$items += @(Get-ChildItem -LiteralPath $root -Force -Recurse -Attributes ReparsePoint -ErrorAction Stop)',
    '$hit = $items | Where-Object { $candidate = $_.FullName; $excluded = $false; foreach ($excludedRoot in $excludedRoots) { if ($candidate.Equals($excludedRoot, [StringComparison]::OrdinalIgnoreCase) -or $candidate.StartsWith($excludedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { $excluded = $true; break } }; -not $excluded } | Select-Object -First 1 -ExpandProperty FullName',
    'if ($null -ne $hit) { [Console]::Out.Write($hit); exit 3 }',
  ].join('; ')
  try {
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      input: JSON.stringify({ root, excludedRoots }),
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (error?.status === 3) {
      throw new MigrationSafetyError(`${root} contains a symbolic link or reparse point`, 'MIGRATION_REPARSE_POINT', { cause: error })
    }
    throw new MigrationSafetyError(
      `Unable to scan ${root} for Windows reparse points; refusing to continue`,
      'MIGRATION_REPARSE_PROBE_UNAVAILABLE',
      { cause: error },
    )
  }
}

export async function assertNoReparseAncestors(pathValue) {
  let cursor = assertAbsolutePath(pathValue, 'Path')
  while (true) {
    try {
      const stats = await lstat(cursor)
      assertNoReparsePoint(cursor, stats)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
}

export async function inspectExistingPath(pathValue, label = 'Path') {
  const absolute = assertAbsolutePath(pathValue, label)
  let stats
  try {
    stats = await lstat(absolute)
  } catch (error) {
    throw new MigrationSafetyError(`Cannot inspect ${label}: ${absolute}`, 'MIGRATION_PATH_UNREADABLE', { cause: error })
  }
  assertNoReparsePoint(absolute, stats)
  return { absolute, stats, canonical: await realpath(absolute) }
}

async function nearestExistingAncestor(pathValue) {
  let cursor = assertAbsolutePath(pathValue, 'Destination path')
  const missing = []
  while (true) {
    try {
      const inspected = await inspectExistingPath(cursor, 'Destination ancestor')
      if (!inspected.stats.isDirectory()) {
        throw new MigrationSafetyError(`${cursor} is not a directory`, 'MIGRATION_DESTINATION_NOT_DIRECTORY')
      }
      await assertNoReparseAncestors(cursor)
      return {
        canonical: join(inspected.canonical, ...missing.reverse()),
        existingAncestor: inspected,
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.cause?.code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw new MigrationSafetyError(`No existing ancestor for ${pathValue}`, 'MIGRATION_PATH_UNREADABLE')
      missing.push(cursor.slice(parent.length + 1))
      cursor = parent
    }
  }
}

export async function assertNoSourceDestinationOverlap({ sourceRoot, destinationRoot }) {
  await assertNoReparseAncestors(sourceRoot)
  const source = await inspectExistingPath(sourceRoot, 'DSH_HOME')
  if (!source.stats.isDirectory()) throw new MigrationSafetyError('DSH_HOME must be a directory', 'MIGRATION_SOURCE_NOT_DIRECTORY')

  const destination = await nearestExistingAncestor(destinationRoot)
  if (isPathWithin(source.canonical, destination.canonical) || isPathWithin(destination.canonical, source.canonical)) {
    throw new MigrationSafetyError(
      'Source DSH_HOME and side-by-side destination overlap; refusing to copy',
      'MIGRATION_SOURCE_DESTINATION_OVERLAP',
    )
  }
  return { source, destination }
}

export async function assertWebProfileInsideDshHome({ dshHome, webProfile }) {
  await assertNoReparseAncestors(dshHome)
  await assertNoReparseAncestors(webProfile)
  const source = await inspectExistingPath(dshHome, 'DSH_HOME')
  const profile = await inspectExistingPath(webProfile, 'web profile')
  if (!profile.stats.isDirectory()) throw new MigrationSafetyError('web profile must be a directory', 'MIGRATION_PROFILE_NOT_DIRECTORY')
  if (normalizeComparablePath(profile.canonical) === normalizeComparablePath(source.canonical)) {
    throw new MigrationSafetyError('web profile must be nested inside DSH_HOME', 'MIGRATION_PROFILE_INVALID_ROOT')
  }
  if (!isPathWithin(source.canonical, profile.canonical)) {
    throw new MigrationSafetyError('web profile is outside DSH_HOME', 'MIGRATION_PROFILE_OUTSIDE_HOME')
  }
  return { source, profile }
}

export async function assertDestinationPathSafe(destinationRoot) {
  const absolute = assertAbsolutePath(destinationRoot, 'side-by-side root')
  const { canonical, existingAncestor } = await nearestExistingAncestor(absolute)
  if (existingAncestor.stats.isDirectory() !== true) {
    throw new MigrationSafetyError(`${absolute} is not a directory`, 'MIGRATION_DESTINATION_NOT_DIRECTORY')
  }
  return { absolute, canonical }
}

export function assertGeneratedPathInside(root, child, label) {
  const absoluteRoot = assertAbsolutePath(root, 'Generated root')
  const absoluteChild = assertAbsolutePath(child, label)
  const lexicalRelative = relative(absoluteRoot, absoluteChild)
  if (lexicalRelative === '' || lexicalRelative.startsWith(`..${sep}`) || lexicalRelative === '..' || isAbsolute(lexicalRelative)) {
    throw new MigrationSafetyError(`${label} escapes generated root`, 'MIGRATION_GENERATED_PATH_ESCAPE')
  }
  return absoluteChild
}
