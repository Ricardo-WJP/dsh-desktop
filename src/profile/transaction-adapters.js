import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { runGit, runPnpm } from '../plugin-management.js'
import { runOwnedCommand } from '../owned-command.js'
import { rebaseManagedReleaseManifest, validateReleaseManifest } from '../release/manifest.js'
import { localPackageTarballName } from './template-builder.js'
import { inspectCandidateProfile } from './compatibility-gate.js'

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,127}\/)?[a-z0-9][a-z0-9._-]{0,127}$/i
const SHA256 = /^[a-f0-9]{64}$/i
const PROFILE_NAME = /^(?!node_modules$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PROFILE_FILES = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
  'cordis.patch.yml',
  'cordis.yml',
  'pnpm-workspace.yaml',
  'profile-plan.json',
])

export async function renameWithTransientRetry(source, target, {
  signal,
  attempts = 7,
  baseDelayMs = 50,
  renameImpl = rename,
  delayImpl = delay,
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) throw new TypeError('Invalid rename retry count')
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error('Candidate publish aborted')
    try {
      await renameImpl(source, target)
      return
    } catch (error) {
      lastError = error
      const transient = ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)
      if (!transient || attempt + 1 >= attempts) throw error
      const waitMs = Math.min(1_000, baseDelayMs * (2 ** attempt))
      await delayImpl(waitMs, undefined, signal === undefined ? undefined : { signal })
    }
  }
  throw lastError
}

async function copyFileWithTransientRetry(sourcePath, targetPath, {
  signal,
  copyFileImpl = copyFile,
  flags = fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE,
  attempts = 8,
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) throw new TypeError('Invalid copy retry count')
  const abortError = () => signal?.reason ?? new Error('Plugin candidate clone aborted')
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw abortError()
    try {
      await copyFileImpl(sourcePath, targetPath, flags)
      return
    } catch (error) {
      lastError = error
      if (!['EACCES', 'EBUSY', 'ENOENT', 'EPERM'].includes(error?.code) || attempt + 1 >= attempts) throw error
      await delay(Math.min(1_000, 50 * (2 ** attempt)), undefined, signal === undefined ? undefined : { signal })
    }
  }
  throw lastError
}

function disableElectronAsarFilesystem() {
  if (process.versions?.electron === undefined) return () => {}
  const hadOwnValue = Object.hasOwn(process, 'noAsar')
  const previousValue = process.noAsar
  process.noAsar = true
  return () => {
    if (hadOwnValue) process.noAsar = previousValue
    else delete process.noAsar
  }
}

function isWithin(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  const remainder = relative(resolve(root), resolve(target))
  return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder))
}

function assertAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`)
  return resolve(value)
}

function assertInside(root, target, label) {
  const resolvedRoot = assertAbsolute(root, 'candidateRoot')
  const resolvedTarget = assertAbsolute(target, label)
  if (!isWithin(resolvedRoot, resolvedTarget) || resolvedRoot === resolvedTarget) {
    throw new Error(`${label} must remain inside candidateRoot`)
  }
  return resolvedTarget
}

async function existingRealpath(value, label) {
  const resolved = await realpath(value)
  const details = await stat(resolved)
  if (!details.isDirectory() && !details.isFile()) throw new Error(`${label} is not a regular filesystem entry`)
  return resolved
}

function unsafeDirectoryEntry(details) {
  return details.isSymbolicLink?.() === true
    || details.isReparsePoint?.() === true
    || !details.isDirectory()
}

async function removeMirrorEntry(path, label) {
  let details
  try {
    details = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true) {
    throw new Error(`${label} is an unexpected link`)
  }
  await rm(path, { recursive: details.isDirectory(), force: true, maxRetries: 3, retryDelay: 100 })
  return true
}

async function assertNoExternalSymlinks(root, label = 'Candidate source') {
  const canonicalRoot = await realpath(root)

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        let target
        try {
          target = await realpath(entryPath)
        } catch (error) {
          throw new Error(`${label} contains an unreadable symbolic link: ${entryPath}`, { cause: error })
        }
        if (!isWithin(canonicalRoot, target)) {
          throw new Error(`${label} contains a symbolic link outside the release: ${entryPath}`)
        }
        const targetStats = await stat(target)
        if (!targetStats.isDirectory() && !targetStats.isFile()) {
          throw new Error(`${label} contains an unsupported symbolic-link target: ${entryPath}`)
        }
        // Do not recurse through links: a valid dependency link can point to
        // an ancestor or to a shared package tree and must not create a loop.
        continue
      }
      if (entry.isDirectory()) await walk(entryPath)
      else if (!entry.isFile()) throw new Error(`${label} contains an unsupported filesystem entry: ${entryPath}`)
    }
  }

  await walk(canonicalRoot)
}

async function copyDirectoryConcurrent(sourceRoot, targetRoot, {
  filter = () => true,
  signal,
  concurrency = process.platform === 'win32' ? 32 : 8,
  copyFileImpl = copyFile,
} = {}) {
  const limit = Math.max(1, Math.trunc(concurrency))
  const queue = []
  let active = 0
  let firstError

  const schedule = task => new Promise(resolveTask => {
    queue.push({ task, resolveTask })
    drain()
  })

  function drain() {
    while (active < limit && queue.length > 0) {
      const item = queue.shift()
      active += 1
      Promise.resolve()
        .then(item.task)
        .catch(error => { firstError ??= error })
        .finally(() => {
          active -= 1
          item.resolveTask()
          drain()
        })
    }
  }

  const pendingCopies = []
  // Prefer filesystem copy-on-write when the platform supports it. Node falls
  // back to a normal independent copy otherwise; either result is isolated
  // from the active release, unlike hardlinks.
  const copyFlags = fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE
  const abortError = () => signal?.reason ?? new Error('Plugin candidate clone aborted')

  async function walk(sourceDirectory, targetDirectory, ancestors = new Set()) {
    if (signal?.aborted) throw abortError()
    if (firstError) throw firstError
    const canonicalDirectory = await realpath(sourceDirectory)
    if (ancestors.has(canonicalDirectory)) {
      throw new Error(`Candidate source contains a cyclic symbolic link: ${sourceDirectory}`)
    }
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(canonicalDirectory)
    const sourceDetails = await stat(canonicalDirectory)
    await mkdir(targetDirectory, { mode: sourceDetails.mode })

    const entries = await readdir(sourceDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (signal?.aborted) throw abortError()
      if (firstError) throw firstError
      const sourcePath = join(sourceDirectory, entry.name)
      if (!filter(sourcePath)) continue
      const targetPath = join(targetDirectory, entry.name)

      if (entry.isDirectory()) {
        await walk(sourcePath, targetPath, nextAncestors)
        continue
      }

      if (entry.isFile()) {
        pendingCopies.push(schedule(() => copyFileWithTransientRetry(sourcePath, targetPath, { signal, copyFileImpl, flags: copyFlags })))
        continue
      }

      if (entry.isSymbolicLink()) {
        const canonicalTarget = await realpath(sourcePath)
        const targetDetails = await stat(canonicalTarget)
        if (targetDetails.isDirectory()) {
          await walk(sourcePath, targetPath, nextAncestors)
        } else if (targetDetails.isFile()) {
          pendingCopies.push(schedule(() => copyFileWithTransientRetry(canonicalTarget, targetPath, { signal, copyFileImpl, flags: copyFlags })))
        } else {
          throw new Error(`Candidate source contains an unsupported symbolic-link target: ${sourcePath}`)
        }
        continue
      }

      throw new Error(`Candidate source contains an unsupported filesystem entry: ${sourcePath}`)
    }
  }

  if (!filter(sourceRoot)) throw new Error('Candidate source root was rejected by the clone filter')
  try {
    await walk(sourceRoot, targetRoot)
  } catch (error) {
    firstError ??= error
  }
  await Promise.all(pendingCopies)
  if (signal?.aborted) throw abortError()
  if (firstError) throw firstError
}

async function readJson(path, label) {
  const details = await stat(path)
  if (!details.isFile()) throw new Error(`${label} is not a regular file`)
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    try { await rm(temporary, { force: true }) } catch { /* preserve original failure */ }
    throw error
  }
}

async function writeTextAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    try { await rm(temporary, { force: true }) } catch { /* preserve original failure */ }
    throw error
  }
}

function outputText(result) {
  if (typeof result === 'string') return result
  if (typeof result?.stdout === 'string') return result.stdout
  if (typeof result?.output === 'string') return result.output
  return ''
}

function parseJsonOutput(result) {
  const output = outputText(result).trim()
  if (output === '') return undefined
  try { return JSON.parse(output) } catch { /* try JSON lines */ }
  for (const line of output.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    try { return JSON.parse(line) } catch { /* ignore progress text */ }
  }
  return undefined
}

function assertPackageName(value) {
  if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) throw new TypeError('Invalid plugin package name')
  return value
}

function assertProfileName(value) {
  if (typeof value !== 'string' || !PROFILE_NAME.test(value)) throw new Error(`Invalid candidate profile name: ${String(value)}`)
  return value
}

function normalizeDuplicatedNpmSpecifiers(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return { manifest, changed: false }
  const dependencies = manifest.dependencies
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) return { manifest, changed: false }
  let changed = false
  const normalized = { ...dependencies }
  for (const [name, value] of Object.entries(dependencies)) {
    if (!PACKAGE_NAME.test(name) || typeof value !== 'string') continue
    const prefix = `${name}@`
    if (!value.startsWith(prefix)) continue
    const version = value.slice(prefix.length)
    if (!EXACT_VERSION.test(version)) continue
    normalized[name] = version
    changed = true
  }
  return changed
    ? { manifest: { ...manifest, dependencies: normalized }, changed: true }
    : { manifest, changed: false }
}

function normalizeLocalFilePath(value) {
  return typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value)
    ? value.replaceAll('\\', '/')
    : value
}

function rebaseProfileLockfileSpecifiers(text, { sourceProfilePath, candidateProfilePath } = {}) {
  if (typeof text !== 'string' || typeof sourceProfilePath !== 'string' || typeof candidateProfilePath !== 'string') {
    return { text, changed: false }
  }
  const sourcePackages = resolve(sourceProfilePath, 'packages')
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  let changed = false
  const rebased = text.split(/\r?\n/).map(line => {
    const match = /^(\s*specifier:\s*)(['"]?)(file:)(.+?)\2(\s*)$/.exec(line)
    if (match === null) return line
    const specifierPath = normalizeLocalFilePath(match[4])
    if (!isAbsolute(specifierPath)) return line
    const relativePath = relative(sourcePackages, resolve(specifierPath))
    if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) return line
    const normalizedRelativePath = relativePath.replaceAll('\\', '/')
    if (normalizedRelativePath.startsWith('../') || normalizedRelativePath.includes('/../')) return line
    changed = true
    return `${match[1]}${match[2]}file:./packages/${normalizedRelativePath}${match[2]}${match[5]}`
  }).join(newline)
  return { text: rebased, changed }
}

function activeReleaseId(release) {
  const identities = [
    release?.pointer?.releaseId,
    release?.candidate?.releaseId,
    release?.recipe?.releaseId,
  ].filter(value => value !== undefined)
  if (identities.length === 0 || identities.some(value => typeof value !== 'string' || !RELEASE_ID.test(value))) {
    throw new Error('Active candidate release has no valid identity')
  }
  if (new Set(identities).size !== 1) throw new Error('Active candidate release identities disagree')
  return identities[0]
}

function assertAllowedPath(path, roots, label) {
  const resolved = assertAbsolute(path, label)
  if (!Array.isArray(roots) || roots.length === 0 || !roots.some(root => isWithin(root, resolved))) {
    throw new Error(`${label} is outside the configured local-dev roots`)
  }
  return resolved
}

function commandOptions(options, request, { profileDir, cwd } = {}) {
  if (request?.shell !== undefined && request.shell !== false) throw new Error('Plugin command shell mode is disabled')
  return {
    args: [...(request?.args ?? [])],
    env: options.env,
    execPath: options.execPath,
    pnpmEntry: options.pnpmEntry,
    profileDir: profileDir ?? request?.profileDir ?? options.commandDirectory,
    cwd: cwd ?? request?.cwd ?? options.commandDirectory,
    signal: request?.signal,
    onOutput: options.onOutput,
    ...(options.hiddenChildProcess === undefined ? {} : { hiddenChildProcess: options.hiddenChildProcess }),
  }
}

/**
 * Build the production adapters for PluginTransactionService.
 *
 * The adapter deliberately has no dshHome input. It can only clone/read/write
 * a verified candidate release supplied by resolveActiveRelease, and every
 * filesystem write is checked against candidateRoot before it is performed.
 * The static compatibility gate is offline and fail-closed. Production also
 * injects a desktop-owned runtime gate; the adapter itself stays generic so
 * plugin packages are never patched to accommodate the host.
 */
export function createDesktopPluginTransactionAdapters({
  candidateRoot,
  resolveActiveRelease,
  allowedRoots = [],
  pnpmEntry,
  execPath = process.execPath,
  env = process.env,
  onOutput = () => {},
  hiddenChildProcess,
  commandDirectory = candidateRoot,
  runPnpmImpl = runPnpm,
  runGitImpl = runGit,
  runCommandImpl = runOwnedCommand,
  runCandidateRuntimeGate,
  engineCompatibilityOverrides = [],
  removeImpl = rm,
  copyFileImpl = copyFile,
} = {}) {
  const root = assertAbsolute(candidateRoot, 'candidateRoot')
  if (typeof resolveActiveRelease !== 'function') throw new TypeError('resolveActiveRelease adapter is required')
  if (typeof runPnpmImpl !== 'function' || typeof runGitImpl !== 'function' || typeof runCommandImpl !== 'function' || typeof removeImpl !== 'function') {
    throw new TypeError('Invalid plugin command adapters')
  }

  async function activeCandidate(signal) {
    const release = await resolveActiveRelease({ signal })
    const recipe = release?.recipe
    if (recipe?.mode === 'legacy' || typeof recipe?.profileHome !== 'string' || typeof recipe?.profilePath !== 'string') {
      throw new Error('Plugin transactions require an active immutable candidate release')
    }
    const sourceRoot = await existingRealpath(recipe.profileHome, 'Active candidate release')
    const sourceProfile = await existingRealpath(recipe.profilePath, 'Active candidate profile')
    if (!isWithin(root, sourceRoot) || !isWithin(sourceRoot, sourceProfile)) {
      throw new Error(`Active candidate release escapes candidateRoot (root=${root}; release=${sourceRoot}; profile=${sourceProfile})`)
    }
    await assertNoExternalSymlinks(sourceRoot, 'Active candidate release')
    const releaseId = activeReleaseId(release)
    const manifest = validateReleaseManifest(await readJson(join(sourceRoot, 'manifest.json'), 'Active candidate manifest'))
    if (manifest.releaseId !== releaseId) throw new Error('Active candidate release id does not match its manifest')
    return { release, releaseId, manifest, sourceRoot, sourceProfile }
  }

  async function cloneActiveProfile({ candidateId, candidatePath, signal }) {
    if (typeof candidateId !== 'string' || !RELEASE_ID.test(candidateId)) throw new TypeError('Invalid candidate id')
    const active = await activeCandidate(signal)
    const canonicalRoot = assertInside(root, join(root, candidateId), 'Candidate path')
    const targetRoot = assertInside(root, candidatePath ?? canonicalRoot, 'Candidate path')
    if (targetRoot === active.sourceRoot || isWithin(targetRoot, active.sourceRoot) || isWithin(active.sourceRoot, targetRoot)) {
      throw new Error('Candidate clone target overlaps the active candidate')
    }
    if (targetRoot !== canonicalRoot) throw new Error('Candidate clone path does not match its id')
    await mkdir(root, { recursive: true, mode: 0o700 })
    try {
      await stat(targetRoot)
      throw new Error('Candidate clone target already exists')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const stageRoot = assertInside(root, join(root, `.clone-${candidateId}-${randomUUID()}`), 'Candidate clone stage')
    const activeProfileManifest = await readJson(join(active.sourceProfile, 'package.json'), 'Active candidate package manifest')
    const activePhysicalProfileName = assertProfileName(activeProfileManifest.name)
    const derivedLinkFarm = join(active.sourceRoot, 'profiles', 'node_modules')
    const derivedPhysicalDependencies = join(active.sourceRoot, 'profiles', activePhysicalProfileName, 'node_modules')
    const derivedPhysicalModuleFallback = join(active.sourceRoot, 'profiles', activePhysicalProfileName, '.dsh-module-fallback')
    // Electron's optional default app is opened/recreated by some Helper
    // runtimes. Preserve it for the cloned Helper, but use a normal copy flag
    // instead of FICLONE because copying it while live can yield a persistent
    // Windows ENOENT even though the file is visible immediately before copy.
    const volatileElectronDefaultApp = resolve(join(active.sourceRoot, 'electron', 'resources', 'default_app.asar'))
    // profiles/node_modules is generated by DSH from the selected runtime. It
    // contains hundreds of junctions back into runtime/node_modules and is not
    // release input. Dereferencing it duplicated the entire runtime into every
    // plugin candidate (about 30k files on Windows), while preserving it would
    // leave the candidate coupled to the previously active release. Omit the
    // derived farm and let the candidate-owned DSH entry recreate it. The
    // physical profile's node_modules is derived as well: pnpm records an
    // absolute virtualStoreDir in .modules.yaml, so copying that directory
    // into a child candidate permanently points it at the parent release and
    // pnpm rejects the next plugin install with
    // ERR_PNPM_UNEXPECTED_VIRTUAL_STORE.
    const restoreElectronAsarFilesystem = disableElectronAsarFilesystem()
    let published = false
    let stagedElectronDefaultApp
    try {
      if (signal?.aborted) throw signal.reason ?? new Error('Plugin candidate clone aborted')
      if (active.release.recipe.dataHome === undefined) try {
        const details = await lstat(volatileElectronDefaultApp)
        if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isFile()) {
          throw new Error('Active Electron default app is not a regular file')
        }
        stagedElectronDefaultApp = join(root, `.electron-default-app-${candidateId}-${randomUUID()}.tmp`)
        // Snapshot this volatile file before the large tree walk. The target
        // candidate still receives the complete Helper runtime, while the
        // copy no longer depends on a file being live-opened mid-walk.
        await copyFileWithTransientRetry(volatileElectronDefaultApp, stagedElectronDefaultApp, {
          signal,
          copyFileImpl,
          flags: fsConstants.COPYFILE_EXCL,
        })
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      // Node's fs.cp walks this 20k+ file runtime mostly serially on Windows,
      // which made a normal market update appear frozen for several minutes.
      // Keep a real, independent copy (never hardlinks) so an untrusted plugin
      // cannot mutate the active release, but copy regular files with bounded
      // parallelism. Unsupported or external links still fail closed above.
      await copyDirectoryConcurrent(active.sourceRoot, stageRoot, {
        signal,
        copyFileImpl,
        filter: source => {
          const resolvedSource = resolve(source)
          if (active.release.recipe.dataHome !== undefined) {
            const first = relative(active.sourceRoot, resolvedSource).split(/[\\/]/u)[0]
            if (first && !['manifest.json', 'profile', 'profiles', 'runtime', 'artifacts'].includes(first)) return false
          }
          return !isWithin(derivedLinkFarm, resolvedSource)
            && !isWithin(derivedPhysicalDependencies, resolvedSource)
            // DSH recreates this fallback farm for the target profile. Its
            // junctions must not be dereferenced into regular directories:
            // dsh-app-boot rejects that shape before the candidate can start.
            && !isWithin(derivedPhysicalModuleFallback, resolvedSource)
            && resolvedSource !== volatileElectronDefaultApp
        },
      })
      if (stagedElectronDefaultApp !== undefined) {
        const targetElectronDefaultApp = join(stageRoot, 'electron', 'resources', 'default_app.asar')
        await mkdir(join(stageRoot, 'electron', 'resources'), { recursive: true })
        await renameWithTransientRetry(stagedElectronDefaultApp, targetElectronDefaultApp, { signal })
        stagedElectronDefaultApp = undefined
      }
      if (signal?.aborted) throw signal.reason ?? new Error('Plugin candidate clone aborted')
      const rebasedManifest = rebaseManagedReleaseManifest(active.manifest, {
        releaseId: candidateId,
        createdAt: new Date().toISOString(),
      })
      await writeJsonAtomic(join(stageRoot, 'manifest.json'), rebasedManifest)
      const stagedManifest = validateReleaseManifest(await readJson(join(stageRoot, 'manifest.json'), 'Staged candidate manifest'))
      if (stagedManifest.releaseId !== candidateId) throw new Error('Staged candidate release id does not match its manifest')
      const profilePath = assertInside(root, join(stageRoot, 'profile'), 'Candidate profile')
      const profile = await existingRealpath(profilePath, 'Candidate profile')
      if (profile !== profilePath) throw new Error('Candidate profile contains an unexpected link')
      const candidateProfileManifest = await readJson(join(profilePath, 'package.json'), 'Candidate package manifest')
      const physicalName = assertProfileName(candidateProfileManifest.name)
      const physicalProfilePath = assertInside(root, join(stageRoot, 'profiles', physicalName), 'Candidate physical profile')
      const physicalProfile = await existingRealpath(physicalProfilePath, 'Candidate physical profile')
      if (physicalProfile !== physicalProfilePath) throw new Error('Candidate physical profile contains an unexpected link')
      const lockfilePath = join(profilePath, 'pnpm-lock.yaml')
      let lockfile
      try {
        lockfile = await readFile(lockfilePath, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      if (lockfile !== undefined) {
        const rebasedLockfile = rebaseProfileLockfileSpecifiers(lockfile, {
          sourceProfilePath: active.sourceProfile,
          candidateProfilePath: profilePath,
        })
        if (rebasedLockfile.changed) {
          // A local tarball may have been installed from a previous candidate.
          // Rebase only absolute `specifier: file:` importer entries in the
          // child; never touch the active release and never rewrite registry or
          // Git sources. The physical profile mirrors the repaired lockfile
          // before pnpm's frozen-lockfile hydration runs.
          await writeTextAtomic(lockfilePath, rebasedLockfile.text)
          await syncProfileFiles(profilePath, physicalProfilePath)
        }
      }
      const normalizedProfile = normalizeDuplicatedNpmSpecifiers(candidateProfileManifest)
      if (normalizedProfile.changed) {
        // Repair only the exact historical `name: name@version` corruption in
        // the new candidate. The immutable active release is never modified.
        await writeJsonAtomic(join(profilePath, 'package.json'), normalizedProfile.manifest)
        await syncProfileFiles(profilePath, physicalProfilePath)
      }
      await renameWithTransientRetry(stageRoot, targetRoot, { signal })
      published = true
      const publishedRoot = await existingRealpath(targetRoot, 'Published candidate')
      if (publishedRoot !== targetRoot) throw new Error('Published candidate contains an unexpected link')
      const publishedManifest = validateReleaseManifest(await readJson(join(targetRoot, 'manifest.json'), 'Published candidate manifest'))
      if (publishedManifest.releaseId !== candidateId) throw new Error('Published candidate release id does not match its manifest')
      return {
        candidateId,
        candidatePath: targetRoot,
        parentReleaseId: active.releaseId,
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(`Plugin candidate clone failed: ${String(error)}`, { cause: error })
      const cleanupErrors = []
      if (stagedElectronDefaultApp !== undefined) {
        try { await removeImpl(stagedElectronDefaultApp, { force: true }) } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      }
      try {
        await removeImpl(stageRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
      if (published) {
        try {
          await removeImpl(targetRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }
      if (cleanupErrors.length > 0) {
        failure.cleanupError = cleanupErrors.length === 1
          ? cleanupErrors[0]
          : new AggregateError(cleanupErrors, 'Plugin candidate clone cleanup failed')
      }
      throw failure
    } finally {
      restoreElectronAsarFilesystem()
    }
  }

  async function discardCandidate({ candidateId, candidatePath }) {
    if (typeof candidateId !== 'string' || !RELEASE_ID.test(candidateId)) throw new TypeError('Invalid candidate id')
    const canonicalPath = assertInside(root, join(root, candidateId), 'Candidate path')
    const targetRoot = assertInside(root, candidatePath ?? canonicalPath, 'Candidate path')
    if (targetRoot !== canonicalPath) throw new Error('Candidate cleanup path does not match its id')

    let targetDetails
    try {
      targetDetails = await lstat(targetRoot)
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, candidateId, candidatePath: targetRoot, missing: true }
      throw error
    }
    if (unsafeDirectoryEntry(targetDetails)) throw new Error('Candidate cleanup target is not a regular directory')

    const [canonicalCandidateRoot, canonicalTargetRoot] = await Promise.all([realpath(root), realpath(targetRoot)])
    if (relative(resolve(canonicalCandidateRoot, candidateId), canonicalTargetRoot) !== '') {
      throw new Error('Candidate cleanup target real path does not match its id')
    }

    const active = await resolveActiveRelease({})
    const activeRoot = active?.recipe?.profileHome
    if (typeof activeRoot === 'string') {
      const resolvedActiveRoot = resolve(activeRoot)
      let canonicalActiveRoot = resolvedActiveRoot
      try { canonicalActiveRoot = await realpath(resolvedActiveRoot) } catch { /* the active owner validates its own path */ }
      if (targetRoot === resolvedActiveRoot
        || canonicalTargetRoot === canonicalActiveRoot
        || isWithin(targetRoot, resolvedActiveRoot)
        || isWithin(resolvedActiveRoot, targetRoot)) {
        throw new Error('Refusing to discard the active candidate release')
      }
    }

    // Atomically detach the exact directory from its public candidate id. A
    // junction swap before rename moves only that junction; the second lstat
    // then fails closed instead of recursively following an external target.
    const tombstone = assertInside(root, join(root, `.discard-${candidateId}-${randomUUID()}`), 'Candidate cleanup tombstone')
    await rename(targetRoot, tombstone)
    const detachedDetails = await lstat(tombstone)
    if (unsafeDirectoryEntry(detachedDetails)) {
      throw new Error('Detached candidate cleanup target is not a regular directory')
    }
    const detachedRealPath = await realpath(tombstone)
    if (!isWithin(canonicalCandidateRoot, detachedRealPath)
      || relative(resolve(canonicalCandidateRoot, relative(root, tombstone)), detachedRealPath) !== '') {
      throw new Error('Detached candidate cleanup target escapes candidateRoot')
    }
    await removeImpl(tombstone, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    return { ok: true, candidateId, candidatePath: targetRoot }
  }

  async function candidateProfilePaths(candidatePath) {
    const candidateDir = assertInside(root, candidatePath, 'Candidate path')
    const profilePath = assertInside(root, join(candidateDir, 'profile'), 'Candidate profile')
    const profile = await existingRealpath(profilePath, 'Candidate profile')
    if (profile !== profilePath) throw new Error('Candidate profile contains an unexpected link')
    const profileManifest = await readJson(join(profilePath, 'package.json'), 'Candidate package manifest')
    const physicalName = assertProfileName(profileManifest.name)
    const physicalProfilePath = assertInside(root, join(candidateDir, 'profiles', physicalName), 'Candidate physical profile')
    const physicalProfile = await existingRealpath(physicalProfilePath, 'Candidate physical profile')
    if (physicalProfile !== physicalProfilePath) throw new Error('Candidate physical profile contains an unexpected link')
    return { candidateDir, profilePath, physicalProfilePath, profileManifest }
  }

  async function syncProfileFiles(sourcePath, targetPath) {
    await mkdir(targetPath, { recursive: true, mode: 0o700 })
    for (const fileName of PROFILE_FILES) {
      const sourceFile = join(sourcePath, fileName)
      const targetFile = join(targetPath, fileName)
      try {
        const details = await stat(sourceFile)
        if (!details.isFile()) throw new Error(`Candidate profile entry is not a regular file: ${sourceFile}`)
        const targetDetails = await lstat(targetFile).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
        if (targetDetails?.isSymbolicLink?.() === true || targetDetails?.isReparsePoint?.() === true || targetDetails?.isDirectory?.() === true) {
          throw new Error(`Candidate profile mirror target is not a regular file: ${targetFile}`)
        }
        await cp(sourceFile, targetFile, { force: true, dereference: true })
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        await removeMirrorEntry(targetFile, 'Candidate profile mirror target')
      }
    }
    const sourcePackages = join(sourcePath, 'packages')
    const targetPackages = join(targetPath, 'packages')
    try {
      const details = await stat(sourcePackages)
      if (!details.isDirectory()) throw new Error(`Candidate profile packages is not a directory: ${sourcePackages}`)
      await removeMirrorEntry(targetPackages, 'Candidate profile packages mirror')
      await cp(sourcePackages, targetPackages, { recursive: true, force: true, dereference: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await removeMirrorEntry(targetPackages, 'Candidate profile packages mirror')
    }
  }

  async function readCandidateProfile({ candidatePath }) {
    const { profilePath } = await candidateProfilePaths(candidatePath)
    return readJson(join(profilePath, 'package.json'), 'Candidate package manifest')
  }

  async function writeCandidateProfile({ candidatePath, profile }) {
    const { profilePath, physicalProfilePath } = await candidateProfilePaths(candidatePath)
    await writeJsonAtomic(join(profilePath, 'package.json'), profile)
    await syncProfileFiles(profilePath, physicalProfilePath)
  }

  async function invokeDshPlugin(request) {
    const active = await activeCandidate(request?.signal)
    const activeEntry = await existingRealpath(active.release?.recipe?.entry, 'Active candidate DSH entry')
    if (!isWithin(active.sourceRoot, activeEntry)) throw new Error('Active candidate DSH entry escapes its release')
    const { candidateDir, profilePath, physicalProfilePath, profileManifest } = await candidateProfilePaths(request?.candidatePath)
    const entry = await existingRealpath(join(candidateDir, relative(active.sourceRoot, activeEntry)), 'Candidate DSH entry')
    if (!isWithin(candidateDir, entry)) throw new Error('Candidate DSH entry escapes its release')
    // DSH resolves --profile as $DSH_HOME/profiles/<physicalName>. Keep the
    // source profile as the candidate's release input and run pnpm against its
    // materialized physical copy, then synchronize the metadata back.
    await syncProfileFiles(profilePath, physicalProfilePath)
    const candidateHome = candidateDir
    const profileName = assertProfileName(profileManifest.name)
    const argv = [...(request?.argv ?? [])]
    const profileFlag = argv.indexOf('--profile')
    if (profileFlag < 0 || profileFlag === argv.length - 1) throw new Error('Plugin invocation is missing a profile selector')
    argv[profileFlag + 1] = profileName
    const result = await runCommandImpl({
      command: execPath,
      args: [
        ...(hiddenChildProcess === undefined ? [] : ['--require', hiddenChildProcess]),
        entry,
        ...argv,
      ],
      cwd: physicalProfilePath,
      env: {
        ...env,
        DSH_HOME: candidateHome,
        ELECTRON_RUN_AS_NODE: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      signal: request?.signal,
      spawnImpl: undefined,
      windowsHide: true,
      outputLabel: 'dsh plugin transaction',
      onOutput,
      shell: false,
    })
    const exitCode = result?.code ?? result?.exitCode ?? result?.status
    if (exitCode === undefined || exitCode === 0) await syncProfileFiles(physicalProfilePath, profilePath)
    return result
  }

  async function inspectGithubPackage({ source, packageName, signal }) {
    if (typeof source?.repository !== 'string' || typeof source?.commit !== 'string') {
      const error = new Error('GitHub plugin source must be resolved to an exact repository commit before inspection')
      error.code = 'GITHUB_SOURCE_NOT_PINNED'
      throw error
    }
    const inspectionDirectory = await mkdtemp(join(root, '.github-inspection-'))
    const remote = `https://github.com/${source.repository}.git`
    const runGitInspection = args => runGitImpl({
      args,
      cwd: commandDirectory,
      env,
      onOutput,
      signal,
    })
    const packagePath = source.path === undefined
      ? 'package.json'
      : `${source.path.slice(1).replaceAll('\\', '/')}/package.json`
    try {
      // Fetch only the pinned commit and inspect package metadata with git
      // objects. No checkout or lifecycle script is executed, so an arbitrary
      // GitHub repository cannot run code during the safety check.
      await runGitInspection(['init', '--quiet', inspectionDirectory])
      await runGitInspection(['-C', inspectionDirectory, 'remote', 'add', 'origin', remote])
      await runGitInspection(['-C', inspectionDirectory, 'fetch', '--no-tags', '--depth=1', 'origin', source.commit])
      let manifest
      try {
        manifest = JSON.parse(outputText(await runGitInspection(['-C', inspectionDirectory, 'show', `FETCH_HEAD:${packagePath}`])))
      } catch (error) {
        const detail = error instanceof SyntaxError ? 'package.json is not valid JSON' : 'package.json is missing at the selected GitHub path'
        const manifestError = new Error(`Unable to inspect GitHub plugin ${packageName}: ${detail}`, { cause: error })
        manifestError.code = 'GITHUB_PACKAGE_MANIFEST_UNAVAILABLE'
        throw manifestError
      }
      if (manifest?.name !== packageName) {
        const error = new Error(`GitHub package manifest name ${String(manifest?.name ?? '<missing>')} does not match ${packageName}`)
        error.code = 'GITHUB_PACKAGE_IDENTITY_MISMATCH'
        throw error
      }
      const scripts = manifest.scripts !== null && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)
        ? { ...manifest.scripts }
        : {}
      return { packages: [{ package: packageName, scripts }] }
    } finally {
      await rm(inspectionDirectory, { recursive: true, force: true })
    }
  }

  async function inventoryScripts({ source, packageName, signal }) {
    const name = assertPackageName(packageName)
    if (source?.type === 'local-dev') {
      const sourcePath = assertAllowedPath(source.path, allowedRoots, 'local-dev source')
      const manifest = await readJson(join(sourcePath, 'package.json'), 'local-dev package manifest')
      const scripts = { ...(manifest.scripts ?? {}) }
      try {
        const details = await stat(join(sourcePath, 'binding.gyp'))
        if (details.isFile()) scripts.install ??= 'native binding.gyp build'
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      return { packages: [{ package: name, scripts }] }
    }
    if (source?.type === 'npm') {
      const result = await runPnpmImpl(commandOptions({ env, execPath, pnpmEntry, onOutput, hiddenChildProcess, commandDirectory }, {
        args: ['view', `${source.package}@${source.version}`, 'scripts', '--json'],
        shell: false,
        signal,
      }, { profileDir: root }))
      const scripts = parseJsonOutput(result)
      return { packages: [{ package: name, scripts: scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? scripts : {} }] }
    }
    if (source?.type === 'github') return inspectGithubPackage({ source, packageName: name, signal })
    throw new TypeError('Unsupported plugin source type')
  }

  async function packLocalSource({ source, candidatePath, packageName, signal }) {
    const sourcePath = assertAllowedPath(source?.path, allowedRoots, 'local-dev source')
    const manifest = await readJson(join(sourcePath, 'package.json'), 'local-dev package manifest')
    const name = assertPackageName(packageName ?? manifest.name)
    if (manifest.name !== name || typeof manifest.version !== 'string' || !EXACT_VERSION.test(manifest.version)) {
      throw new Error('local-dev package manifest must expose the exact requested package identity')
    }
    const { profilePath, physicalProfilePath } = await candidateProfilePaths(candidatePath)
    const packageOutput = join(profilePath, 'packages')
    await mkdir(packageOutput, { recursive: true, mode: 0o700 })
    const artifactPath = join(packageOutput, localPackageTarballName(name, manifest.version))
    try { await stat(artifactPath); throw new Error('Packed local artifact already exists') } catch (error) { if (error?.code !== 'ENOENT') throw error }
    await runPnpmImpl(commandOptions({ env, execPath, pnpmEntry, onOutput, hiddenChildProcess, commandDirectory }, {
      args: ['pack', '--pack-destination', packageOutput],
      profileDir: sourcePath,
      shell: false,
      signal,
    }, { profileDir: sourcePath }))
    const artifact = await existingRealpath(artifactPath, 'Packed local artifact')
    if (!isWithin(profilePath, artifact)) throw new Error('Packed local artifact escapes candidate profile')
    await syncProfileFiles(profilePath, physicalProfilePath)
    const bytes = await readFile(artifact)
    return {
      package: name,
      version: manifest.version,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      artifactPath: artifactPath,
      specifier: `file:./packages/${localPackageTarballName(name, manifest.version)}`,
    }
  }

  async function readActiveProfile({ signal }) {
    const active = await activeCandidate(signal)
    return readJson(join(active.sourceProfile, 'package.json'), 'Active candidate package manifest')
  }

  async function runCandidateGate({ candidatePath, platform = process.platform }) {
    const { candidateDir, profilePath, physicalProfilePath } = await candidateProfilePaths(candidatePath)
    const releaseManifest = validateReleaseManifest(await readJson(join(candidateDir, 'manifest.json'), 'Candidate release manifest'))
    return inspectCandidateProfile({
      profilePath,
      nodeModulesPath: join(physicalProfilePath, 'node_modules'),
      platform,
      dshVersion: releaseManifest.dsh.version,
      engineCompatibilityOverrides,
    })
  }

  async function resolvePnpm(request) {
    return runPnpmImpl(commandOptions({ env, execPath, pnpmEntry, onOutput, hiddenChildProcess, commandDirectory }, request, { profileDir: request?.profileDir ?? root }))
  }

  async function resolveGit(request) {
    return runGitImpl({
      args: [...(request?.args ?? [])],
      cwd: request?.cwd ?? root,
      env,
      signal: request?.signal,
      onOutput,
    })
  }

  return Object.freeze({
    candidateRoot: root,
    candidateGateAvailable: true,
    allowedRoots: [...allowedRoots],
    runPnpm: resolvePnpm,
    runGit: resolveGit,
    cloneActiveProfile,
    discardCandidate,
    invokeDshPlugin,
    inventoryScripts,
    runCandidateGate,
    ...(typeof runCandidateRuntimeGate === 'function' ? { runCandidateRuntimeGate } : {}),
    readCandidateProfile,
    writeCandidateProfile,
    packLocalSource,
    readActiveProfile,
  })
}

export const createPluginTransactionAdapters = createDesktopPluginTransactionAdapters
