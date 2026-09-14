import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  createManagedReleaseManifest,
  releaseManifestSha256,
  serializeReleaseManifest,
  validateReleaseManifest,
} from './manifest.js'
import {
  DSH_PACKAGE_NAME,
  installDshVersion,
  resolveDshDistTag,
} from '../dsh-runtime.js'
import {
  createProfilePlan,
  localPackageTarballName,
  materializeProfileTemplate,
  readProfileInputs,
} from '../profile/template-builder.js'
import { runPnpm } from '../plugin-management.js'

export const CANDIDATE_CHANNELS = Object.freeze(['stable', 'next'])
export const CANDIDATE_MANIFEST_NAME = 'manifest.json'
export const CANDIDATE_PROFILE_DIRECTORY = 'profile'
export const CANDIDATE_RUNTIME_DIRECTORY = 'runtime'
export const CANDIDATE_ARTIFACT_DIRECTORY = 'artifacts'
export const CANDIDATE_RUNTIME_INVENTORY = 'inventory.json'

const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SHA256 = /^[a-f0-9]{64}$/i
const SRI = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/

export class CandidateBuildError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'CandidateBuildError'
  }
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new CandidateBuildError('Candidate preparation aborted')
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal)
}

function validateChannel(value) {
  if (!CANDIDATE_CHANNELS.includes(value)) throw new TypeError('Candidate channel must be stable or next')
  return value
}

function validateReleaseId(value) {
  if (typeof value !== 'string' || !RELEASE_ID.test(value)) throw new TypeError('Invalid candidate releaseId')
  return value
}

function validateAbsolutePath(value, label) {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || !isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`)
  }
  return resolve(value)
}

function isWithin(root, target) {
  const path = relative(resolve(root), resolve(target))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function normalizeRelativePath(value, label = 'artifact path') {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || value.includes('\\') || value.includes(':')) {
    throw new CandidateBuildError(`Invalid ${label}`)
  }
  const normalized = value.replaceAll('\\', '/')
  if (posix.isAbsolute(normalized) || normalized === '.' || normalized === '..' || normalized.startsWith('../') || posix.normalize(normalized) !== normalized) {
    throw new CandidateBuildError(`Invalid ${label}`)
  }
  return normalized
}

function normalizeIntegrity(value) {
  if (typeof value !== 'string' || !SRI.test(value)) throw new CandidateBuildError('Resolved DSH release has no exact package integrity')
  return value
}

function normalizeVersion(value) {
  if (typeof value !== 'string' || !EXACT_VERSION.test(value)) throw new CandidateBuildError('Resolved DSH release has no exact semantic version')
  return value
}

function normalizeRuntimeRelease(value, channel) {
  const source = value?.dsh ?? value?.runtime ?? value
  const version = source?.version ?? source?.latestVersion ?? value?.latestVersion
  const integrity = source?.integrity ?? source?.latestIntegrity ?? value?.latestIntegrity ?? source?.distIntegrity
  return {
    channel,
    version: normalizeVersion(version),
    integrity: normalizeIntegrity(integrity),
  }
}

function canonicalTimestamp(value) {
  const candidate = typeof value === 'function' ? value() : value
  const date = candidate instanceof Date ? candidate : new Date(candidate ?? Date.now())
  if (Number.isNaN(date.getTime())) throw new CandidateBuildError('Invalid candidate creation timestamp')
  return date.toISOString()
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function sha256File(path) {
  return sha256(await readFile(path))
}

function canonicalJson(value) {
  return JSON.stringify(value)
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeAtomic(path, content) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    try { await rm(temporary, { force: true }) } catch { /* preserve original failure */ }
    throw error
  }
}

async function assertCandidateFile(root, path, label) {
  const resolved = resolve(path)
  if (!isWithin(root, resolved)) throw new CandidateBuildError(`${label} escapes the candidate directory`)
  const canonicalRoot = await realpath(root)
  const canonicalPath = await realpath(resolved)
  if (!isWithin(canonicalRoot, canonicalPath)) throw new CandidateBuildError(`${label} escapes the candidate directory`)
  const details = await stat(canonicalPath)
  if (!details.isFile()) throw new CandidateBuildError(`${label} is not a regular file`)
  return canonicalPath
}

async function assertCandidateDirectory(root, path, label) {
  const resolved = resolve(path)
  if (!isWithin(root, resolved)) throw new CandidateBuildError(`${label} escapes the candidate directory`)
  const canonicalRoot = await realpath(root)
  const canonicalPath = await realpath(resolved)
  if (!isWithin(canonicalRoot, canonicalPath)) throw new CandidateBuildError(`${label} escapes the candidate directory`)
  const details = await stat(canonicalPath)
  if (!details.isDirectory()) throw new CandidateBuildError(`${label} is not a directory`)
  return canonicalPath
}

async function listFiles(root, prefix = '') {
  const entries = await readdir(root, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativeName = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path, relativeName.replaceAll('\\', '/')))
    else if (entry.isFile()) files.push({ path, relative: relativeName.replaceAll('\\', '/') })
    else throw new CandidateBuildError(`Artifact tree contains unsupported entry ${relativeName}`)
  }
  return files
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1))
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }))
  return results
}

function createPercentProgress(onProgress, phase, total) {
  if (typeof onProgress !== 'function') return () => {}
  let lastPercent = -1
  return completed => {
    const percent = total === 0 ? 100 : Math.floor((completed / total) * 100)
    if (completed !== 0 && completed !== total && percent === lastPercent) return
    lastPercent = percent
    onProgress({ phase, completed, total })
  }
}

export async function createRuntimeInventory(stageDir, { signal, onProgress } = {}) {
  const runtimeDirectory = join(stageDir, CANDIDATE_RUNTIME_DIRECTORY)
  const inventoryPath = join(runtimeDirectory, CANDIDATE_RUNTIME_INVENTORY)
  const files = (await listFiles(runtimeDirectory))
    .filter(file => file.relative !== CANDIDATE_RUNTIME_INVENTORY)
  let completed = 0
  const reportProgress = createPercentProgress(onProgress, 'runtime-inventory', files.length)
  reportProgress(completed)
  const inventory = {
    schemaVersion: 1,
    files: await mapConcurrent(files, 32, async file => {
      throwIfAborted(signal)
      const details = await stat(file.path)
      const result = { path: normalizeRelativePath(file.relative, 'runtime inventory path'), bytes: details.size, sha256: await sha256File(file.path) }
      completed += 1
      reportProgress(completed)
      return result
    }),
  }
  await writeAtomic(inventoryPath, `${JSON.stringify(inventory, undefined, 2)}\n`)
  return {
    path: `${CANDIDATE_RUNTIME_DIRECTORY}/${CANDIDATE_RUNTIME_INVENTORY}`,
    sha256: await sha256File(inventoryPath),
  }
}

async function verifyRuntimeInventory(candidateRoot, { signal, onProgress } = {}) {
  const runtimeDirectory = await assertCandidateDirectory(candidateRoot, join(candidateRoot, CANDIDATE_RUNTIME_DIRECTORY), 'Runtime')
  const inventoryPath = await assertCandidateFile(candidateRoot, join(runtimeDirectory, CANDIDATE_RUNTIME_INVENTORY), 'Runtime inventory')
  const inventory = await readJson(inventoryPath)
  if (inventory?.schemaVersion !== 1 || !Array.isArray(inventory.files) || Object.keys(inventory).sort().join(',') !== 'files,schemaVersion') {
    throw new CandidateBuildError('Invalid runtime inventory')
  }
  const expected = new Map()
  for (const entry of inventory.files) {
    if (entry === null || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'bytes,path,sha256') throw new CandidateBuildError('Invalid runtime inventory entry')
    const path = normalizeRelativePath(entry.path, 'runtime inventory path')
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) throw new CandidateBuildError(`Invalid runtime inventory entry ${path}`)
    if (expected.has(path)) throw new CandidateBuildError(`Duplicate runtime inventory entry ${path}`)
    expected.set(path, { bytes: entry.bytes, sha256: entry.sha256.toLowerCase() })
  }
  const actualFiles = (await listFiles(runtimeDirectory)).filter(file => file.relative !== CANDIDATE_RUNTIME_INVENTORY)
  if (actualFiles.length !== expected.size) throw new CandidateBuildError('Runtime inventory file count does not match')
  let completed = 0
  const reportProgress = createPercentProgress(onProgress, 'runtime-verify', actualFiles.length)
  reportProgress(completed)
  await mapConcurrent(actualFiles, 32, async file => {
    throwIfAborted(signal)
    const expectedFile = expected.get(file.relative)
    if (expectedFile === undefined) throw new CandidateBuildError(`Runtime file ${file.relative} is not inventoried`)
    const details = await stat(file.path)
    if (details.size !== expectedFile.bytes || await sha256File(file.path) !== expectedFile.sha256) {
      throw new CandidateBuildError(`Runtime file ${file.relative} does not match its inventory`)
    }
    completed += 1
    reportProgress(completed)
  })
  return inventory
}

function profileCompatibilityReceipt({ receipt, policy, suiteVersion }) {
  if (receipt !== undefined) return receipt
  if (policy === undefined) throw new CandidateBuildError('Candidate compatibility receipt is missing')
  return {
    suiteVersion: suiteVersion ?? `compat-${String(policy.schemaVersion ?? 1)}`,
    reportSha256: sha256(canonicalJson(policy)),
    passed: true,
  }
}

async function loadProfileInputs(options) {
  if (options.profileInputs !== undefined) return options.profileInputs
  if (options.recipePath !== undefined || options.repositoryRoot !== undefined) {
    if (options.recipePath === undefined || options.repositoryRoot === undefined) {
      throw new CandidateBuildError('recipePath and repositoryRoot are required together')
    }
    return readProfileInputs({ recipePath: options.recipePath, repositoryRoot: options.repositoryRoot })
  }
  return {
    sourcePackage: options.sourcePackage,
    sourceLock: options.sourceLock,
    compatibility: options.profileCompatibility ?? options.compatibility,
    evidenceDir: options.evidenceDir,
  }
}

async function resolveLocalPackageVersions(inputs, repositoryRoot, supplied = {}) {
  const versions = { ...supplied }
  for (const [name, relativePath] of Object.entries(inputs.compatibility?.localPackages ?? {})) {
    if (versions[name] !== undefined) continue
    if (repositoryRoot === undefined) throw new CandidateBuildError(`Repository root is required for local package ${name}`)
    const manifest = await readJson(join(repositoryRoot, relativePath, 'package.json'))
    versions[name] = normalizeVersion(manifest.version)
  }
  return versions
}

async function buildDefaultProfile({ profileDirectory, inputs, repositoryRoot, localPackageVersions, plan, options, signal }) {
  const localPackages = inputs.compatibility?.localPackages ?? {}
  const selectedBundles = new Set((plan?.bundles ?? []).map(bundle => bundle.name))
  const runPnpmImpl = options.runPnpmImpl ?? runPnpm
  for (const [name, relativePath] of Object.entries(localPackages)) {
    if (!selectedBundles.has(name)) continue
    throwIfAborted(signal)
    const packageDirectory = resolve(repositoryRoot, relativePath)
    const packageOutput = join(profileDirectory, 'packages')
    await runPnpmImpl({
      args: ['pack', '--pack-destination', packageOutput],
      env: options.env,
      execPath: options.execPath,
      ...(options.hiddenChildProcess === undefined ? {} : { hiddenChildProcess: options.hiddenChildProcess }),
      onOutput: options.onOutput,
      pnpmEntry: options.pnpmEntry,
      profileDir: packageDirectory,
      signal,
    })
    const expected = localPackageTarballName(name, localPackageVersions[name])
    if (!(await pathExists(join(packageOutput, expected)))) throw new CandidateBuildError(`Local package ${name} did not produce ${expected}`)
  }

  throwIfAborted(signal)
  await runPnpmImpl({
    args: ['install', '--lockfile-only', '--prefer-offline', '--ignore-scripts'],
    env: options.env,
    execPath: options.execPath,
    ...(options.hiddenChildProcess === undefined ? {} : { hiddenChildProcess: options.hiddenChildProcess }),
    onOutput: options.onOutput,
    pnpmEntry: options.pnpmEntry,
    profileDir: profileDirectory,
    signal,
  })
  throwIfAborted(signal)

  // pnpm can omit cached Git integrity metadata. Rehydrate only matching exact
  // records from the checked-in evidence lock so candidate output is cache-independent.
  const generatedLockPath = join(profileDirectory, 'pnpm-lock.yaml')
  const generatedLock = parseYaml(await readFile(generatedLockPath, 'utf8'))
  const evidenceLock = typeof inputs.sourceLock === 'string' ? parseYaml(inputs.sourceLock) : inputs.sourceLock
  for (const [key, evidence] of Object.entries(evidenceLock?.packages ?? {})) {
    const generated = generatedLock?.packages?.[key]
    if (generated === undefined || evidence?.resolution?.integrity === undefined) continue
    generated.resolution = { ...generated.resolution, integrity: evidence.resolution.integrity }
  }
  await writeFile(generatedLockPath, stringifyYaml(generatedLock, { lineWidth: 0 }), { encoding: 'utf8', mode: 0o600 })
}

async function prepareProfile({ stageDir, options, signal }) {
  const profileDirectory = join(stageDir, CANDIDATE_PROFILE_DIRECTORY)
  await mkdir(profileDirectory, { recursive: false, mode: 0o700 })
  throwIfAborted(signal)

  const inputs = await loadProfileInputs(options)
  throwIfAborted(signal)
  const mode = options.profileMode ?? 'stable'
  const repositoryRoot = options.repositoryRoot === undefined ? undefined : validateAbsolutePath(options.repositoryRoot, 'Repository root')
  const localPackageVersions = await resolveLocalPackageVersions(inputs, repositoryRoot, options.localPackageVersions)
  let plan = options.profilePlan
  if (plan === undefined) {
    if (inputs.sourcePackage === undefined || inputs.sourceLock === undefined || inputs.compatibility === undefined) {
      throw new CandidateBuildError('Profile source package, lock, and compatibility policy are required')
    }
    plan = createProfilePlan({
      mode,
      releaseId: options.releaseId,
      sourcePackage: inputs.sourcePackage,
      sourceLock: inputs.sourceLock,
      compatibility: inputs.compatibility,
      localPackageVersions,
    })
  }

  let materializedReport
  if (typeof options.materializeProfileImpl === 'function') {
    materializedReport = await options.materializeProfileImpl({
      plan,
      outputDir: profileDirectory,
      profileDir: profileDirectory,
      evidenceDir: inputs.evidenceDir,
      signal,
    })
  } else {
    if (inputs.evidenceDir === undefined) throw new CandidateBuildError('Profile evidenceDir is required')
    materializedReport = await materializeProfileTemplate({
      plan,
      outputDir: profileDirectory,
      evidenceDir: inputs.evidenceDir,
    })
  }
  throwIfAborted(signal)

  const lockPath = join(profileDirectory, 'pnpm-lock.yaml')
  if (!(await pathExists(lockPath)) && inputs.sourceLock !== undefined) {
    const lockText = typeof inputs.sourceLock === 'string'
      ? inputs.sourceLock
      : stringifyYaml(inputs.sourceLock, { lineWidth: 0 })
    await writeFile(lockPath, lockText, { encoding: 'utf8', mode: 0o600 })
  }

  let built = {}
  if (typeof options.buildProfileImpl === 'function') {
    built = await options.buildProfileImpl({
      plan,
      inputs,
      outputDir: profileDirectory,
      profileDir: profileDirectory,
      stageDir,
      signal,
    }) ?? {}
  } else if (repositoryRoot !== undefined) {
    await buildDefaultProfile({
      profileDirectory,
      inputs,
      repositoryRoot,
      localPackageVersions,
      plan,
      options,
      signal,
    })
  }
  throwIfAborted(signal)

  const profileDirectoryResult = built.profileDir ?? built.profilePath ?? profileDirectory
  await assertCandidateDirectory(stageDir, profileDirectoryResult, 'Physical profile')
  const packagePath = join(profileDirectoryResult, 'package.json')
  const lockFilePath = join(profileDirectoryResult, 'pnpm-lock.yaml')
  const patchPath = join(profileDirectoryResult, 'cordis.patch.yml')
  for (const [path, label] of [[packagePath, 'Profile package manifest'], [lockFilePath, 'Profile lockfile'], [patchPath, 'Profile patch']]) {
    await assertCandidateFile(stageDir, path, label)
  }
  const packageJson = await readJson(packagePath)
  const physicalName = built.physicalName ?? options.physicalProfileName ?? plan.physicalName
  const logicalName = built.logicalName ?? options.logicalProfileName ?? plan.logicalName
  if (packageJson.name !== physicalName) throw new CandidateBuildError('Profile package name does not match its physical profile name')

  const profile = {
    logicalName,
    physicalName,
    manifestSha256: await sha256File(packagePath),
    lockSha256: await sha256File(lockFilePath),
    patchSha256: await sha256File(patchPath),
  }
  const expected = options.profile
  if (expected !== undefined) {
    for (const key of ['logicalName', 'physicalName', 'manifestSha256', 'lockSha256', 'patchSha256']) {
      if (expected[key] !== undefined && expected[key].toLowerCase?.() !== profile[key].toLowerCase?.()) {
        throw new CandidateBuildError(`Profile ${key} does not match the staged file`)
      }
    }
  }
  return {
    directory: resolve(profileDirectoryResult),
    plan,
    report: built.report ?? materializedReport,
    profile,
    bundles: built.bundles ?? plan.bundles ?? [],
    artifacts: built.artifacts ?? built.clientArtifacts,
    inputs,
  }
}

async function materializeArtifactEntries({ stageDir, entries, signal }) {
  const artifactDirectory = join(stageDir, CANDIDATE_ARTIFACT_DIRECTORY)
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 })
  const supplied = entries === undefined ? [] : (Array.isArray(entries) ? entries : [entries])
  for (const entry of supplied) {
    throwIfAborted(signal)
    const value = typeof entry === 'string' ? { path: entry } : entry
    if (value === null || typeof value !== 'object') throw new CandidateBuildError('Invalid client artifact entry')
    const requested = value.path ?? value.relativePath ?? value.name
    if (requested === undefined) throw new CandidateBuildError('Client artifact path is missing')
    const normalized = normalizeRelativePath(requested)
    const relativeArtifact = normalized.startsWith(`${CANDIDATE_ARTIFACT_DIRECTORY}/`)
      ? normalized
      : `${CANDIDATE_ARTIFACT_DIRECTORY}/${normalized}`
    const destination = join(stageDir, ...relativeArtifact.split('/'))
    if (!isWithin(stageDir, destination)) throw new CandidateBuildError('Client artifact escapes the candidate directory')
    await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 })
    if (value.content !== undefined) {
      await writeFile(destination, value.content, { mode: 0o600 })
    } else if (value.filePath !== undefined || value.sourcePath !== undefined) {
      const source = validateAbsolutePath(value.filePath ?? value.sourcePath, 'Client artifact source')
      await copyFile(source, destination)
    }
    if (!(await pathExists(destination))) throw new CandidateBuildError(`Client artifact ${normalized} was not built`)
    const actual = await sha256File(destination)
    if (value.sha256 !== undefined && (!SHA256.test(value.sha256) || value.sha256.toLowerCase() !== actual)) {
      throw new CandidateBuildError(`Client artifact ${normalized} hash does not match`)
    }
  }
  const files = await listFiles(artifactDirectory)
  return Promise.all(files.map(async file => ({
    path: `${CANDIDATE_ARTIFACT_DIRECTORY}/${file.relative}`,
    sha256: await sha256File(file.path),
  })))
}

function runtimeDescriptorPath(candidateDir) {
  return join(candidateDir, CANDIDATE_RUNTIME_DIRECTORY, 'descriptor.json')
}

async function verifyCandidateFiles(candidateDir, manifest, { signal, verifyRuntime = true, onProgress } = {}) {
  const root = await assertCandidateDirectory(candidateDir, candidateDir, 'Candidate')
  throwIfAborted(signal)

  const profileDirectory = await assertCandidateDirectory(root, join(root, CANDIDATE_PROFILE_DIRECTORY), 'Physical profile')
  const packagePath = await assertCandidateFile(root, join(profileDirectory, 'package.json'), 'Profile package manifest')
  const lockPath = await assertCandidateFile(root, join(profileDirectory, 'pnpm-lock.yaml'), 'Profile lockfile')
  const patchPath = await assertCandidateFile(root, join(profileDirectory, 'cordis.patch.yml'), 'Profile patch')
  const packageJson = await readJson(packagePath)
  if (packageJson.name !== manifest.profile.physicalName) throw new CandidateBuildError('Ready profile physical name does not match the manifest')
  const profileHashes = {
    manifestSha256: await sha256File(packagePath),
    lockSha256: await sha256File(lockPath),
    patchSha256: await sha256File(patchPath),
  }
  for (const key of Object.keys(profileHashes)) {
    if (profileHashes[key] !== manifest.profile[key]) throw new CandidateBuildError(`Ready profile ${key} hash does not match the manifest`)
  }

  const descriptor = await readJson(await assertCandidateFile(root, runtimeDescriptorPath(root), 'Runtime descriptor'))
  if (descriptor.name !== DSH_PACKAGE_NAME || descriptor.version !== manifest.dsh.version || descriptor.integrity !== manifest.dsh.integrity) {
    throw new CandidateBuildError('Ready runtime descriptor does not match the manifest')
  }
  if (verifyRuntime) await verifyRuntimeInventory(root, { signal, onProgress })

  for (const artifact of manifest.clientArtifacts) {
    const artifactPath = await assertCandidateFile(root, join(root, ...artifact.path.split('/')), `Client artifact ${artifact.path}`)
    if (await sha256File(artifactPath) !== artifact.sha256) throw new CandidateBuildError(`Client artifact ${artifact.path} hash does not match the manifest`)
  }
  return { profileHashes, descriptor }
}

export async function verifyReadyCandidate(input, maybeOptions = {}) {
  const options = typeof input === 'string' ? { ...maybeOptions, candidateDir: input } : (input ?? {})
  const candidateDir = validateAbsolutePath(options.candidateDir ?? options.directory, 'Candidate directory')
  const manifestPath = validateAbsolutePath(options.manifestPath ?? join(candidateDir, CANDIDATE_MANIFEST_NAME), 'Candidate manifest path')
  if (!isWithin(candidateDir, manifestPath)) throw new CandidateBuildError('Candidate manifest escapes the candidate directory')
  const text = await readFile(manifestPath, 'utf8')
  const manifest = validateReleaseManifest(JSON.parse(text))
  if (serializeReleaseManifest(manifest) !== text) throw new CandidateBuildError('Ready candidate manifest is not canonical')
  if (options.expectedReleaseId !== undefined && manifest.releaseId !== options.expectedReleaseId) throw new CandidateBuildError('Ready candidate releaseId does not match the requested candidate')
  if (options.expectedChannel !== undefined && manifest.channel !== options.expectedChannel) throw new CandidateBuildError('Ready candidate channel does not match the requested candidate')
  await verifyCandidateFiles(candidateDir, manifest, options)
  return {
    status: 'ready',
    candidateDir,
    manifestPath,
    manifest,
    manifestSha256: releaseManifestSha256(manifest),
  }
}

export const verifyCandidate = verifyReadyCandidate

export async function prepareReleaseCandidate(options = {}) {
  const channel = validateChannel(options.channel)
  const releaseId = validateReleaseId(options.releaseId ?? options.candidateId)
  const candidateRoot = validateAbsolutePath(options.candidateRoot ?? options.root, 'Candidate root')
  const candidateDirectory = validateAbsolutePath(options.candidateDir ?? join(candidateRoot, releaseId), 'Candidate directory')
  if (!isWithin(candidateRoot, candidateDirectory) || candidateDirectory === candidateRoot) throw new CandidateBuildError('Candidate directory must be inside candidateRoot')
  if (await pathExists(candidateDirectory)) throw new CandidateBuildError(`Candidate ${releaseId} already exists`)
  await mkdir(candidateRoot, { recursive: true, mode: 0o700 })

  const stageDirectory = join(candidateRoot, `.staging-${releaseId}-${randomUUID()}`)
  let published = false
  let initialStateSeeded = false
  try {
    await mkdir(stageDirectory, { recursive: false, mode: 0o700 })
    throwIfAborted(options.signal)
    if (typeof options.seedCandidateStateImpl === 'function') {
      await options.seedCandidateStateImpl({
        stageDir: stageDirectory,
        releaseId,
        channel,
        signal: options.signal,
      })
      initialStateSeeded = true
      throwIfAborted(options.signal)
    }

    const runtimeRelease = options.runtimeRelease === undefined
      ? await (options.resolveRuntimeImpl ?? resolveDshDistTag)({
          channel,
          packageName: options.packageName ?? DSH_PACKAGE_NAME,
          runtimeRoot: join(stageDirectory, CANDIDATE_RUNTIME_DIRECTORY),
          pnpmEntry: options.pnpmEntry,
          execPath: options.execPath,
          env: options.env,
          ...(options.hiddenChildProcess === undefined ? {} : { hiddenChildProcess: options.hiddenChildProcess }),
          signal: options.signal,
          onOutput: options.onOutput,
          runPnpmImpl: options.runPnpmImpl,
        })
      : options.runtimeRelease
    const resolvedRuntime = normalizeRuntimeRelease(runtimeRelease, channel)
    throwIfAborted(options.signal)

    const runtimeRoot = join(stageDirectory, CANDIDATE_RUNTIME_DIRECTORY)
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
    const installedRuntime = await (options.installRuntimeImpl ?? installDshVersion)({
      version: resolvedRuntime.version,
      integrity: resolvedRuntime.integrity,
      runtimeRoot,
      pnpmEntry: options.pnpmEntry,
      execPath: options.execPath,
      env: options.env,
      ...(options.hiddenChildProcess === undefined ? {} : { hiddenChildProcess: options.hiddenChildProcess }),
      signal: options.signal,
      onOutput: options.onOutput,
      runPnpmImpl: options.runPnpmImpl,
    })
    throwIfAborted(options.signal)
    if (installedRuntime?.version !== undefined && installedRuntime.version !== resolvedRuntime.version) {
      throw new CandidateBuildError('Installed DSH runtime version does not match the resolved dist-tag')
    }
    if (installedRuntime?.integrity !== undefined && installedRuntime.integrity !== resolvedRuntime.integrity) {
      throw new CandidateBuildError('Installed DSH runtime integrity does not match the resolved dist-tag')
    }
    if (installedRuntime?.directory !== undefined && !isWithin(stageDirectory, installedRuntime.directory)) {
      throw new CandidateBuildError('Installed DSH runtime escapes the candidate staging directory')
    }
    const compatibilityRecipe = typeof options.compatibilityRecipeForVersion === 'function'
      ? await options.compatibilityRecipeForVersion(resolvedRuntime.version)
      : options.compatibilityRecipe
    let compatibilityRecipeReport
    if (compatibilityRecipe !== undefined) {
      if (typeof options.applyCompatibilityRecipeImpl !== 'function') {
        throw new CandidateBuildError('Compatibility recipe applier is unavailable')
      }
      if (typeof installedRuntime?.directory !== 'string') {
        throw new CandidateBuildError('Installed DSH runtime directory is required for compatibility recipes')
      }
      compatibilityRecipeReport = await options.applyCompatibilityRecipeImpl({
        root: installedRuntime.directory,
        recipe: compatibilityRecipe,
        dshVersion: resolvedRuntime.version,
        write: true,
        signal: options.signal,
      })
      throwIfAborted(options.signal)
    }
    await writeAtomic(runtimeDescriptorPath(stageDirectory), `${JSON.stringify({
      schemaVersion: 1,
      name: DSH_PACKAGE_NAME,
      source: 'npm',
      version: resolvedRuntime.version,
      integrity: resolvedRuntime.integrity,
    }, undefined, 2)}\n`)
    throwIfAborted(options.signal)
    const runtimeInventoryArtifact = await createRuntimeInventory(stageDirectory, {
      signal: options.signal,
      onProgress: options.onProgress,
    })
    throwIfAborted(options.signal)

    let resolvedProfileOptions = {}
    if (typeof options.resolveProfileOptionsImpl === 'function') {
      resolvedProfileOptions = await options.resolveProfileOptionsImpl({
        channel,
        releaseId,
        runtime: resolvedRuntime,
        stageDir: stageDirectory,
        signal: options.signal,
      }) ?? {}
      if (resolvedProfileOptions === null
        || typeof resolvedProfileOptions !== 'object'
        || Array.isArray(resolvedProfileOptions)) {
        throw new CandidateBuildError('Profile resolver must return an options object')
      }
      throwIfAborted(options.signal)
    }
    if (typeof resolvedProfileOptions.seedCandidateStateImpl === 'function'
      && resolvedProfileOptions.seedCandidateStateImpl !== options.seedCandidateStateImpl
      && !initialStateSeeded) {
      await resolvedProfileOptions.seedCandidateStateImpl({
        stageDir: stageDirectory,
        releaseId,
        channel,
        signal: options.signal,
      })
      throwIfAborted(options.signal)
    }
    const profile = await prepareProfile({
      stageDir: stageDirectory,
      options: { ...options, ...resolvedProfileOptions, channel, releaseId },
      signal: options.signal,
    })
    throwIfAborted(options.signal)
    let artifactEntries = profile.artifacts ?? options.artifacts
    if (typeof options.buildArtifactsImpl === 'function') {
      const built = await options.buildArtifactsImpl({
        channel,
        releaseId,
        plan: profile.plan,
        profileDir: profile.directory,
        outputDir: join(stageDirectory, CANDIDATE_ARTIFACT_DIRECTORY),
        stageDir: stageDirectory,
        runtime: resolvedRuntime,
        signal: options.signal,
      })
      artifactEntries = built?.artifacts ?? built?.clientArtifacts ?? built ?? artifactEntries
    }
    throwIfAborted(options.signal)
    const clientArtifacts = [
      runtimeInventoryArtifact,
      ...await materializeArtifactEntries({ stageDir: stageDirectory, entries: artifactEntries, signal: options.signal }),
    ]
    const compatibility = profileCompatibilityReceipt({
      receipt: options.compatibilityReceipt ?? options.compatibilityReport,
      policy: profile.inputs.compatibility,
      suiteVersion: options.compatibilitySuiteVersion,
    })
    const manifest = createManagedReleaseManifest({
      releaseId,
      channel,
      desktopVersion: options.desktopVersion ?? options.appVersion ?? '0.0.0',
      dshVersion: resolvedRuntime.version,
      dshIntegrity: resolvedRuntime.integrity,
      profile: profile.profile,
      bundles: options.bundles ?? profile.bundles,
      clientArtifacts,
      compatibility,
      createdAt: canonicalTimestamp(options.createdAt ?? options.now),
    })
    throwIfAborted(options.signal)

    const stagedManifestPath = join(stageDirectory, CANDIDATE_MANIFEST_NAME)
    await writeAtomic(stagedManifestPath, serializeReleaseManifest(manifest))
    // The runtime inventory was created from this immutable staging tree. Do
    // the expensive hash comparison once after the directory move; that final
    // pass also catches broken absolute links and relocation issues on Windows.
    await verifyReadyCandidate({
      candidateDir: stageDirectory,
      expectedReleaseId: releaseId,
      expectedChannel: channel,
      signal: options.signal,
      verifyRuntime: false,
    })
    throwIfAborted(options.signal)
    await rename(stageDirectory, candidateDirectory)
    published = true
    throwIfAborted(options.signal)
    const ready = await verifyReadyCandidate({
      candidateDir: candidateDirectory,
      expectedReleaseId: releaseId,
      expectedChannel: channel,
      signal: options.signal,
      onProgress: options.onProgress,
    })
    return {
      ...ready,
      releaseId,
      channel,
      runtime: { ...resolvedRuntime, ...(installedRuntime ?? {}) },
      ...(compatibilityRecipeReport === undefined ? {} : { compatibilityRecipe: compatibilityRecipeReport }),
      profile: { ...profile.profile, directory: join(candidateDirectory, CANDIDATE_PROFILE_DIRECTORY) },
    }
  } catch (error) {
    const failure = error instanceof Error
      ? error
      : new CandidateBuildError(`Candidate preparation failed: ${String(error)}`, { cause: error })
    const cleanupTarget = published ? candidateDirectory : stageDirectory
    const removeImpl = options.removeImpl ?? rm
    try {
      await removeImpl(cleanupTarget, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (cleanupError) {
      failure.cleanupError = new CandidateBuildError(`Unable to remove failed candidate data at ${cleanupTarget}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause: cleanupError })
    }
    throw failure
  }
}

export const prepareCandidate = prepareReleaseCandidate
export const buildReleaseCandidate = prepareReleaseCandidate

export function createCandidateBuilder(defaultOptions = {}) {
  return Object.freeze({
    prepare: options => prepareReleaseCandidate({ ...defaultOptions, ...(options ?? {}) }),
    prepareCandidate: options => prepareReleaseCandidate({ ...defaultOptions, ...(options ?? {}) }),
    verify: options => verifyReadyCandidate(options),
    verifyReadyCandidate,
  })
}
