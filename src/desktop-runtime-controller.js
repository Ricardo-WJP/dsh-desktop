import process from 'node:process'
import { existsSync, readFileSync } from 'node:fs'
const DATA_MIGRATION_OPERATION_OWNER = Symbol('data-migration-operation-owner')
import { createHash, randomUUID } from 'node:crypto'
import { resolvePluginCompatibilityPolicy } from './compatibility/plugin-policy.js'
import { resolveMarketSource } from './profile/market-source.js'
import { prepareLegacyHostServicePatch } from './compatibility/legacy-host-services.js'
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import semver from 'semver'
import { buildHarnessArgs, HarnessServer } from './harness-server.js'
import { createModeSupervisor } from './runtime/mode-supervisor.js'
import { createHarnessLifecycleOwner } from './startup-lifecycle.js'
import { createWorkspaceReadinessOwner } from './workspace-readiness.js'
import { createOperationCoordinator } from './operation-coordinator.js'
import { createDualUpdateManager } from './dual-update.js'
import { loadingStateScript, normalizeProgress } from './startup-progress.js'
import {
  diagnosticDialogDetail,
  diagnosticErrorDetail,
  diagnosticLogText,
  diagnosticStatusText,
  sanitizeDiagnosticValue,
} from './diagnostics.js'
import { createInstallerUpdateController } from './auto-update.js'
import { createDshUpdateController } from './dsh-update.js'
import { createCandidateBuilder, createRuntimeInventory } from './release/candidate-builder.js'
import { applyCompatibilityRecipe } from './release/compatibility-recipe.js'
import { DSH_RC2_COMPATIBILITY_RECIPE } from '../compatibility/recipes/dsh-0.1.1-rc.2.js'
import { compatibilityRecipeForVersion } from '../compatibility/recipes/dsh-0.1.2-rc.1.js'
import {
  OPEN_CODE_GO_MODEL_ENDPOINT,
  OPEN_CODE_GO_DOCUMENTATION_ENDPOINT,
  buildDshOpenCodeGoCatalog,
  catalogModelIds,
  isDshOpenCodeGoCatalog,
  patchDshOpenCodeGoModelCatalog,
  parseOpenCodeGoDocumentation,
} from './compatibility/opencode-go-catalog.js'
import { fetchOpenCodeGoCapabilities } from './compatibility/opencode-go-capabilities.js'
import { readManagedDataHome, migrateManagedDataHome } from './storage/managed-data-home.js'
import {
  DSH_SETTINGS_PACKAGE,
  patchDshSettingsLegacyExports,
} from './compatibility/dsh-settings-legacy-exports.js'
import { ReleaseStateStore, STAGED_PLUGIN_CANDIDATE_SCHEMA_VERSION } from './release/state-store.js'
import { SnapshotStore } from './release/snapshot-store.js'
import { createReleaseSwitcher, DEFAULT_OBSERVE_DURATION } from './release/switcher.js'
import {
  rebaseManagedReleaseManifest,
  releaseManifestSha256,
  serializeReleaseManifest,
  validateReleaseManifest,
} from './release/manifest.js'
import { loadPluginCatalog, normalizePluginSourceUrl } from './plugin-catalog.js'
import { createPluginTransactionService } from './profile/transaction-service.js'
import { createDesktopPluginTransactionAdapters } from './profile/transaction-adapters.js'
import { inspectPluginDshEngine } from './profile/compatibility-gate.js'
import { acceptNativeProfileRevision } from './profile/native-profile-revision.js'
import { runCandidateRuntimeGate as runIsolatedCandidateRuntimeGate } from './profile/runtime-gate.js'
import {
  readPluginCatalog,
  runGit,
  runPnpm,
} from './plugin-management.js'
import { runOwnedCommand } from './owned-command.js'

const DEFAULT_COPY = Object.freeze({
  preparing: 'Preparing the desktop window…',
  preparingPlugins: 'Preparing the Harness profile…',
  loading: 'Starting DeepSeek Harness…',
  loadingServices: 'Loading local services…',
  openingWorkspace: 'Opening the workspace…',
  ready: 'Ready',
  restarting: 'Restarting DeepSeek Harness…',
  startupFailed: 'DeepSeek Harness failed to start',
  stopped: 'DeepSeek Harness stopped',
  dshRollback: 'The updated DSH failed to start. Restoring the bundled version…',
  dshRollbackTitle: 'Bundled DSH Restored',
  dshRollbackMessage: version => `DSH ${version} could not start, so DeepSeek Harness Desktop restored its bundled version automatically.`,
})

const BOOTSTRAP_RELEASE_ID = 'bootstrap-legacy'
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function defaultDesktopSnapshotRoot(dataRoot) {
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '' || !isAbsolute(dataRoot)) {
    throw new TypeError('Desktop data root must be an absolute path')
  }
  const dataDirectoryName = basename(dataRoot)
  const snapshotDirectoryName = dataDirectoryName.startsWith('.')
    ? `${dataDirectoryName}-snapshots`
    : `.${dataDirectoryName}-snapshots`
  return join(dirname(dataRoot), snapshotDirectoryName)
}

const DEFAULT_DESKTOP_SNAPSHOT_EXCLUSIONS = Object.freeze([
  'blob_storage',
  'Cache',
  'Code Cache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Dictionaries',
  'dsh-runtime',
  'electron',
  'GPUCache',
  'Network',
  'profiles/node_modules',
  'Session Storage',
  'Shared Dictionary',
  'shared_proto_db',
  'toolchain',
  'VideoDecodeStats',
])

export function defaultDesktopSnapshotExclusions(dataRoot, activeRoot) {
  const exclusions = new Set(DEFAULT_DESKTOP_SNAPSHOT_EXCLUSIONS)
  if (typeof dataRoot === 'string' && dataRoot !== '' && isAbsolute(dataRoot)
    && typeof activeRoot === 'string' && activeRoot !== '' && isAbsolute(activeRoot)) {
    const runtimeRelative = relative(resolve(dataRoot), resolve(activeRoot)).replaceAll('\\', '/')
    if (runtimeRelative !== '' && runtimeRelative !== '..' && !runtimeRelative.startsWith('../') && !isAbsolute(runtimeRelative)) {
      exclusions.add(runtimeRelative)
    }
  }
  return [...exclusions]
}
const MANIFEST_SHA256_PATTERN = /^[a-f0-9]{64}$/i

function errorDetail(error) {
  return diagnosticErrorDetail(error)
}

const RECOVERY_PLUGIN_ROW_IDS = Object.freeze({
  'dsh-better-sidebar': ['better-sidebar'],
  dshmarket: ['dsh-market'],
  '@changfenhuang/dsh-genui': ['genui'],
  // Preserve recovery for profiles created before the upstream package rename.
  '@omdsh-dev/dsh-genui': ['genui'],
  'dsh-at-file': ['dsh-at-file'],
  aegis: ['aegis-method-pack'],
})

function normalizedDumpValue(value) {
  return String(value ?? '').trim().replace(/^['"]|['"]$/g, '')
}

function userPluginRowsFromDump(output, packageNames) {
  const rows = new Set()
  let packageName
  for (const line of String(output ?? '').split(/\r?\n/u)) {
    const section = /^# ==\s+(.+?)\s*$/u.exec(line)
    if (section !== null) {
      packageName = normalizedDumpValue(section[1].split(', patched by ')[0])
      continue
    }
    const row = /^- id:\s+(.+?)\s*$/u.exec(line)
    if (row === null || !packageNames.has(packageName)) continue
    const id = normalizedDumpValue(row[1])
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) rows.add(id)
  }
  return rows
}

function recoveryPatchText(rowIds) {
  return [...rowIds].sort().map(id => `- id: ${id}\n  disabled: true`).join('\n') + '\n'
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Desktop operation aborted')
}

function resolveAdapter(value, fallback) {
  try {
    const resolved = typeof value === 'function' ? value() : value
    return resolved === undefined ? fallback : resolved
  } catch {
    return fallback
  }
}

function asFunction(value, fallback = () => {}) {
  return typeof value === 'function' ? value : fallback
}

function asResolver(value, fallback = () => undefined) {
  if (typeof value === 'function') return value
  return value === undefined ? fallback : () => value
}

function isWithin(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  const resolved = relative(root, target)
  return resolved === '' || (!resolved.startsWith('..') && !isAbsolute(resolved))
}

function releaseStoreComplete(value, methods) {
  return value !== undefined
    && value !== null
    && methods.every(method => typeof value[method] === 'function')
}

function releaseError(value, fallback = 'Release infrastructure is unavailable') {
  if (value instanceof Error) return value
  return new Error(value === undefined ? fallback : String(value))
}

async function writeTextAtomic(path, content) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    try { await rm(temporary, { force: true }) } catch { /* preserve the original failure */ }
    throw error
  }
}

async function copyFileAtomicIfChanged(sourcePath, targetPath) {
  const source = await readFile(sourcePath)
  try {
    const target = await readFile(targetPath)
    if (target.equals(source)) return false
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
  const temporary = `${targetPath}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, source, { flag: 'wx', mode: 0o600 })
    try {
      await rename(temporary, targetPath)
    } catch (error) {
      // A second desktop process can finish publishing the same immutable
      // overlay between our read and rename. Treat that as success only when
      // the published bytes are exactly the expected source bytes.
      if (['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) {
        try {
          const published = await readFile(targetPath)
          if (published.equals(source)) return false
        } catch {
          // Preserve the original rename failure below.
        }
      }
      throw error
    }
    return true
  } finally {
    try { await rm(temporary, { force: true }) } catch { /* preserve the copy result */ }
  }
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function readCandidateOpenCodeGoApiKey(candidateRoot) {
  try {
    const home = readManagedDataHome(dirname(dirname(resolve(candidateRoot))))?.dataHome ?? candidateRoot
    const document = parseYaml(await readFile(join(home, '.credentials.yaml'), 'utf8'))
    const refs = document?.refs
    for (const name of ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY']) {
      const value = refs?.[name]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  } catch {
    // A candidate without a credentials document simply cannot perform the
    // optional live roster probe. The caller keeps the package's last catalog.
  }
  for (const name of ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY']) {
    const value = String(process.env[name] ?? '').trim()
    if (value !== '') return value
  }
  return undefined
}

/**
 * Resolve one registry plugin from the registry's live dist-tag metadata.
 * This is deliberately a read-only HTTP probe: the candidate package and
 * lockfile remain the only mutation surface, and a registry outage simply
 * leaves that dependency at its last verified version.
 */
async function fetchLatestRegistryPluginRelease(packageName, { signal, fetchImpl = globalThis.fetch } = {}) {
  if (typeof packageName !== 'string' || packageName.trim() === '') throw new TypeError('Plugin package name is required')
  if (typeof fetchImpl !== 'function') throw new Error('Plugin registry resolver has no fetch implementation')
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener?.('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('Plugin registry metadata request timed out')), 12_000)
  timer.unref?.()
  try {
    const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'user-agent': 'DeepSeek-Harness-Desktop/Plugin-Compatibility-Resolver',
      },
      signal: controller.signal,
    })
    if (!response?.ok) throw new Error(`Plugin registry returned HTTP ${String(response?.status ?? 'unknown')}`)
    const metadata = await response.json()
    const version = metadata?.['dist-tags']?.latest
    const release = typeof version === 'string' ? metadata?.versions?.[version] : undefined
    const integrity = release?.dist?.integrity
    if (typeof version !== 'string' || semver.valid(version) !== version || typeof integrity !== 'string') {
      throw new Error(`Plugin registry returned no exact latest release for ${packageName}`)
    }
    return Object.freeze({
      package: packageName,
      version,
      integrity,
      requiredRange: release?.dsh?.engines?.dsh,
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', forwardAbort)
  }
}

async function resolveLiveOpenCodeGoCatalog(candidateRoot, options = {}) {
  const fallback = {
    status: 'stale-cache',
    catalog: null,
    liveModelCount: null,
    appliedModelCount: null,
    unknownModelIds: [],
    reason: '',
    documentationStatus: 'not-requested',
    capabilitiesStatus: 'not-requested',
  }
  if (options.liveModelSync === false) return { ...fallback, status: 'disabled', reason: '实时模型同步已禁用' }
  const key = await readCandidateOpenCodeGoApiKey(candidateRoot)
  if (key === undefined) return { ...fallback, status: 'credential-unavailable', reason: '未找到 OpenCode Go 实时目录凭据' }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ...fallback, status: 'fetch-unavailable', reason: '当前运行时没有可用的 fetch' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('OpenCode Go 模型目录请求超时')), 12_000)
  const onAbort = () => controller.abort(options.signal.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  timeout.unref?.()
  try {
    const modelResponse = await fetchImpl(OPEN_CODE_GO_MODEL_ENDPOINT, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${key}`,
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'user-agent': 'DSH-Desktop/OpenCode-Go-Catalog',
      },
      signal: controller.signal,
    })
    const modelStatus = Number(modelResponse?.status)
    if (modelStatus === 401 || modelStatus === 403) return { ...fallback, status: 'auth-failed', reason: `官方模型目录 HTTP ${modelStatus}` }
    if (!modelResponse?.ok && !(modelStatus >= 200 && modelStatus < 300)) return { ...fallback, status: 'http-error', reason: `官方模型目录 HTTP ${modelStatus || '未知'}` }
    const modelBody = typeof modelResponse.json === 'function'
      ? await modelResponse.json()
      : JSON.parse(await modelResponse.text())
    const liveIds = [...new Set((Array.isArray(modelBody?.data) ? modelBody.data : [])
      .map(entry => entry?.id)
      .filter(id => typeof id === 'string' && id.trim() !== '')
      .map(id => id.trim()))]
    if (liveIds.length === 0) return { ...fallback, status: 'invalid-response', reason: '官方模型目录没有返回 data 模型列表' }

    // Availability and wire routing still come from OpenCode Go. The public
    // provider-scoped metadata only fills capabilities; no credentials go to
    // models.dev, and it may never add models or replace endpoints.
    const capabilityRequest = fetchOpenCodeGoCapabilities({ fetchImpl, signal: controller.signal })
      .then(models => ({ status: 'live', models: Object.fromEntries(models.map(model => [model.id, model])) }))
      .catch(error => ({ status: error?.status ?? 'unavailable', models: {} }))

    let documentation = []
    let documentationStatus = 'unavailable'
    try {
      const documentationResponse = await fetchImpl(OPEN_CODE_GO_DOCUMENTATION_ENDPOINT, {
        headers: { accept: 'text/html', 'cache-control': 'no-cache', pragma: 'no-cache' },
        signal: controller.signal,
      })
      const documentationStatusCode = Number(documentationResponse?.status)
      if (documentationResponse?.ok || documentationStatusCode >= 200 && documentationStatusCode < 300) {
        const documentationText = typeof documentationResponse.text === 'function'
          ? await documentationResponse.text()
          : ''
        documentation = parseOpenCodeGoDocumentation(documentationText)
        documentationStatus = documentation.length > 0 ? 'ok' : 'empty'
      } else {
        documentationStatus = `http-${documentationStatusCode || 'unknown'}`
      }
    } catch (error) {
      documentationStatus = error?.name === 'AbortError' ? 'timeout' : 'network-error'
    }

    const capabilityResult = await capabilityRequest
    const built = buildDshOpenCodeGoCatalog({
      source: options.currentSource ?? '',
      availableIds: liveIds,
      descriptors: documentation,
      capabilities: capabilityResult.models,
    })
    const appliedIds = built.appliedModelIds
    if (appliedIds.length === 0) return {
      ...fallback,
      status: 'live-empty',
      liveModelCount: liveIds.length,
      appliedModelCount: 0,
      unknownModelIds: built.unknownModelIds,
      documentationStatus,
      capabilitiesStatus: capabilityResult.status,
      reason: '官方模型目录返回的模型没有可安全路由的协议元数据',
    }
    return {
      status: 'live',
      catalog: built.catalog,
      liveModelCount: liveIds.length,
      appliedModelCount: appliedIds.length,
      unknownModelIds: built.unknownModelIds,
      documentationStatus,
      capabilitiesStatus: capabilityResult.status,
      reason: '',
    }
  } catch (error) {
    return { ...fallback, status: error?.name === 'AbortError' ? 'timeout' : 'network-error', documentationStatus: 'not-completed', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onAbort)
    controller.abort()
  }
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter(key => value[key] !== undefined)
      .map(key => [key, canonicalJsonValue(value[key])]),
  )
}

function candidateProfileError(message) {
  const error = new Error(message)
  error.code = 'PLUGIN_CANDIDATE_PROFILE_MISMATCH'
  return error
}

function dependencyValue(profile, packageName) {
  const dependencies = profile?.dependencies
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) return undefined
  const value = dependencies[packageName]
  return typeof value === 'string' ? value : value?.specifier ?? value?.version ?? value?.resolved
}

function expectedDependencyValue(source) {
  if (source?.type === 'npm') return source.version
  return source?.specifier
}

export function assertPluginCandidateProfile({ actualProfile, expectedProfile, action, packageName, additions }) {
  if (actualProfile === null || typeof actualProfile !== 'object' || Array.isArray(actualProfile)) {
    throw candidateProfileError('Plugin candidate package manifest is not an object')
  }
  if (typeof actualProfile.name !== 'string' || actualProfile.name.trim() === '') {
    throw candidateProfileError('Plugin candidate package manifest has no profile name')
  }
  if (expectedProfile !== undefined) {
    const actual = JSON.stringify(canonicalJsonValue(actualProfile))
    const expected = JSON.stringify(canonicalJsonValue(expectedProfile))
    if (actual !== expected) {
      throw candidateProfileError('Plugin candidate package manifest does not match the completed transaction')
    }
  }
  if (action === 'remove' && typeof packageName === 'string') {
    if (dependencyValue(actualProfile, packageName) !== undefined) {
      throw candidateProfileError(`Removed plugin ${packageName} is still present in the candidate profile`)
    }
    return
  }
  for (const addition of additions) {
    const nextName = addition?.packageName
    const expected = expectedDependencyValue(addition?.source)
    const actual = dependencyValue(actualProfile, nextName)
    if (typeof nextName !== 'string' || typeof expected !== 'string' || actual !== expected) {
      throw candidateProfileError(`Plugin ${String(nextName ?? '<missing>')} was not persisted with its exact source`)
    }
  }
}

function pluginBundleOrder(profile) {
  const bundles = profile?.dsh?.profile?.bundles ?? profile?.profile?.bundles ?? profile?.bundles
  if (!Array.isArray(bundles)) throw new Error('Active plugin profile has no bundle order')
  return bundles.map((value, index) => {
    const name = typeof value === 'string' ? value : value?.name
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(`Active plugin profile bundle ${String(index)} has no package name`)
    }
    return name
  })
}

async function canonicalCandidateDirectory(candidateRoot, candidateId, candidatePath) {
  if (typeof candidateRoot !== 'string' || !isAbsolute(candidateRoot)) throw new TypeError('Plugin candidate root must be absolute')
  if (typeof candidateId !== 'string' || !RELEASE_ID_PATTERN.test(candidateId)) throw new TypeError('Invalid plugin candidate id')
  if (typeof candidatePath !== 'string' || !isAbsolute(candidatePath)) throw new TypeError('Plugin candidate path must be absolute')
  const rootPath = resolve(candidateRoot)
  const expectedPath = resolve(rootPath, candidateId)
  const requestedPath = resolve(candidatePath)
  if (relative(expectedPath, requestedPath) !== '') throw new Error('Plugin candidate path does not match its release id')

  const details = await lstat(requestedPath)
  if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isDirectory()) {
    throw new Error('Plugin candidate path is not a regular directory')
  }
  const [rootRealPath, candidateRealPath] = await Promise.all([realpath(rootPath), realpath(requestedPath)])
  const expectedRealPath = resolve(rootRealPath, candidateId)
  if (relative(expectedRealPath, candidateRealPath) !== '' || !isWithin(rootRealPath, candidateRealPath)) {
    throw new Error('Plugin candidate real path does not match its release id')
  }
  return {
    rootPath,
    expectedPath,
    candidateRealPath,
    directoryIdentity: {
      dev: String(details.dev),
      ino: String(details.ino),
      birthtimeMs: Number(details.birthtimeMs),
    },
  }
}

function sameDirectoryIdentity(left, right) {
  return left?.dev === right?.dev
    && left?.ino === right?.ino
    && left?.birthtimeMs === right?.birthtimeMs
}

async function ensureCandidatePhysicalProfile(candidateDir, profileSourcePath, physicalProfileName) {
  const physicalProfilePath = join(candidateDir, 'profiles', physicalProfileName)
  if (!isWithin(candidateDir, physicalProfilePath)) throw new Error('Candidate physical profile escapes its release directory')
  const sourceStats = await lstat(profileSourcePath)
  if (sourceStats.isSymbolicLink?.() === true || sourceStats.isReparsePoint?.() === true || !sourceStats.isDirectory()) {
    throw new Error('Candidate profile source is not a regular directory')
  }

  try {
    const targetStats = await lstat(physicalProfilePath)
    if (targetStats.isSymbolicLink?.() === true || targetStats.isReparsePoint?.() === true || !targetStats.isDirectory()) {
      throw new Error('Candidate physical profile is not a regular directory')
    }
    for (const fileName of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
      const sourceHash = await sha256File(join(profileSourcePath, fileName))
      const targetHash = await sha256File(join(physicalProfilePath, fileName))
      if (sourceHash !== targetHash) return await acceptNativeProfileRevision({ candidateDir, sourcePath: profileSourcePath, profilePath: physicalProfilePath })
    }
    return physicalProfilePath
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  await mkdir(dirname(physicalProfilePath), { recursive: true, mode: 0o700 })
  await cp(profileSourcePath, physicalProfilePath, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
  })
  return physicalProfilePath
}

export async function ensureCandidateDesktopIntegration(candidateDir, repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || repositoryRoot.trim() === '') return false
  const sourceRoot = join(repositoryRoot, 'src', 'plugins', 'dsh-desktop-integration')
  const files = ['package.json', 'lib/index.js', 'lib/client.js']
  try {
    await stat(join(sourceRoot, files[0]))
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  const targetRoot = join(candidateDir, 'profiles', 'node_modules', '@dsh-desktop', 'integration')
  if (!isWithin(candidateDir, targetRoot)) throw new Error('Candidate desktop integration escapes its release directory')
  for (const file of files) {
    await copyFileAtomicIfChanged(join(sourceRoot, file), join(targetRoot, file))
  }
  return true
}

/**
 * DSH has changed the location of the settings helper exports across releases.
 * Detect the provider capability in the candidate and add the small legacy
 * facade when the underlying provider already exposes installSection. This is
 * a generic bridge for the plugin ecosystem, not a version allowlist.
 */
export async function ensureCandidateDshSettingsRuntimeCompatibility(
  candidateDir,
  physicalProfilePath,
  options = {},
) {
  const candidateRoot = resolve(candidateDir)
  const profileRoot = resolve(physicalProfilePath)
  if (!isWithin(candidateRoot, profileRoot)) throw new Error('dsh-settings candidate profile escapes its release directory')

  let runtimeVersion
  try {
    runtimeVersion = JSON.parse(await readFile(join(candidateRoot, 'manifest.json'), 'utf8'))?.dsh?.version
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const packageRoots = [profileRoot]
  if (typeof runtimeVersion === 'string' && runtimeVersion.trim() !== '') {
    packageRoots.push(join(candidateRoot, 'runtime', 'versions', runtimeVersion))
  }

  const targetResults = []
  const visited = new Set()
  for (const packageRootBase of packageRoots) {
    const packageRoot = join(packageRootBase, 'node_modules', ...DSH_SETTINGS_PACKAGE.split('/'))
    const normalizedPackageRoot = resolve(packageRoot)
    if (visited.has(normalizedPackageRoot)) continue
    visited.add(normalizedPackageRoot)
    if (!isWithin(candidateRoot, normalizedPackageRoot)) throw new Error('dsh-settings compatibility package escapes its release')

    let packageRealPath
    try {
      const details = await lstat(packageRoot)
      packageRealPath = await realpath(packageRoot)
      if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isDirectory()) {
        throw new Error('dsh-settings compatibility package is not a regular directory')
      }
      if (!isWithin(candidateRoot, packageRealPath)) throw new Error('dsh-settings compatibility package escapes its release')
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }

    const targetPath = join(packageRealPath, 'lib', 'index.js')
    if (!isWithin(packageRealPath, targetPath) || !isWithin(candidateRoot, targetPath)) {
      throw new Error('dsh-settings compatibility target escapes its release')
    }
    const [targetDetails, targetRealPath, packageJson, source] = await Promise.all([
      lstat(targetPath),
      realpath(targetPath),
      readFile(join(packageRealPath, 'package.json'), 'utf8').then(JSON.parse),
      readFile(targetPath, 'utf8'),
    ])
    if (targetDetails.isSymbolicLink?.() === true || targetDetails.isReparsePoint?.() === true || !targetDetails.isFile()) {
      throw new Error('dsh-settings compatibility target is not a regular file')
    }
    if (!isWithin(candidateRoot, targetRealPath) || !isWithin(packageRealPath, targetRealPath)) {
      throw new Error('dsh-settings compatibility target escapes its release')
    }

    const version = typeof packageJson?.version === 'string' ? packageJson.version : null
    const patched = patchDshSettingsLegacyExports(source)
    if (patched.state === 'compatible') {
      targetResults.push({ id: 'legacy-settings-exports', state: 'compatible', path: targetPath, version })
    } else if (patched.state === 'patched') {
      if (options.write !== false) await writeTextAtomic(targetPath, patched.source)
      targetResults.push({ id: 'legacy-settings-exports', state: 'patched', path: targetPath, version })
    } else {
      targetResults.push({ id: 'legacy-settings-exports', state: 'unrecognized', path: targetPath, version })
    }
  }

  if (targetResults.length === 0) {
    return Object.freeze({
      packageName: DSH_SETTINGS_PACKAGE,
      required: true,
      version: typeof runtimeVersion === 'string' ? runtimeVersion : null,
      state: 'absent',
      targets: Object.freeze([]),
    })
  }
  const state = targetResults.some(target => target.state === 'unrecognized')
    ? 'unrecognized'
    : targetResults.some(target => target.state === 'patched')
      ? 'patched'
      : 'compatible'
  return Object.freeze({
    packageName: DSH_SETTINGS_PACKAGE,
    required: true,
    version: typeof runtimeVersion === 'string' ? runtimeVersion : targetResults[0].version,
    state,
    targets: Object.freeze(targetResults.map(target => Object.freeze(target))),
  })
}

const BETTER_DSH_PET_PACKAGE = 'better-dsh-pet'
const BETTER_DSH_PET_COMPATIBILITY_TARGETS = Object.freeze([
  Object.freeze({
    id: 'launcher-env',
    path: Object.freeze(['lib', 'pet-helper-process.js']),
  }),
  Object.freeze({
    id: 'window-topmost',
    path: Object.freeze(['runtime', 'electron-helper', 'main.js']),
  }),
])
const BETTER_DSH_PET_ENV_PATTERN = /env:\s*\{\s*\.\.\.process\.env\s*,\s*\.\.\.this\.options\.env\s*,?\s*\}/g
const BETTER_DSH_PET_SPAWN_PATTERN = /^(\s*)const child = spawn\(command, args, \{$/m
const BETTER_DSH_PET_ENV_MARKER = 'delete childEnv.ELECTRON_RUN_AS_NODE'
const BETTER_DSH_PET_READY_PATTERN = /mainWindow\.once\('ready-to-show',\s*\(\)\s*=>\s*\{\s*mainWindow\.show\(\)\s*\}\)/m
const BETTER_DSH_PET_TOPMOST_MARKER = 'mainWindow.showInactive()'
const BETTER_DSH_PET_ALWAYS_VISIBLE_MARKER = 'DSH_DESKTOP_KEEP_PET_VISIBLE'
const BETTER_DSH_PET_AUTO_HIDE_FUNCTION_MARKER = 'function checkFullscreenAndHide()'
const BETTER_DSH_PET_AUTO_HIDE_PATTERN = /const shouldHide = fullscreen && shouldAutoHideForProcess\(rect\?\.processName\)/g
const DSH_SIGNAL_PACKAGE = 'dsh-signal'
const DSH_SIGNAL_DESKTOP_RECONCILE_MARKER = 'DSH_DESKTOP_BOUNDED_BRAND_RECONCILE'
const DSH_SIGNAL_COMPATIBILITY_TARGETS = Object.freeze({
  '0.5.10': Object.freeze({
    upstreamSha256: 'e2916a93963ef0ddfaac520a494f03fa1fb9826cf909ba62d406f53df579cc12',
    patchedSha256: 'd96d870ae9b467fb4ecdb6a3f76f9d771615b969db6a1bbdca8c2d72ebc0ec88',
  }),
})
const DSH_PI_AI_PACKAGE = '@earendil-works/pi-ai'
const DSH_PI_AI_OPEN_CODE_GO_CATALOG_PATH = Object.freeze([
  'dist',
  'providers',
  'data',
  'opencode-go.json',
])
const DSH_STT_INPUT_PACKAGE = 'dsh-stt-input'
const DSH_STT_INPUT_DESKTOP_SESSION_MARKER = 'DSH_DESKTOP_STT_RESILIENT_BROWSER_SESSION'
const DSH_STT_INPUT_RESULT_MARKER = 'DSH_DESKTOP_STT_PRESERVE_RESULTS_V2'
const DSH_STT_INPUT_BROWSER_BLOCK_PATTERN = /(^[ \t]*)if \(cfg\.engine === 'browser'\) \{[\s\S]*?^\1\} else \{/m
const DSH_STT_INPUT_STOP_PATTERN = /(^[ \t]*)function stopRecording\(inputActions, base, cfg\) \{[\s\S]*?^\1\}/m
const DSH_STT_INPUT_COMPATIBILITY_TARGETS = Object.freeze({
  '0.1.0': Object.freeze({
    upstreamSha256: '9bd0589dfe761f7de7b5a5dc391d3519d6c343eee544e633070d663b5d4f404a',
    patchedSha256: '1e7bfcdd07caabfd2c417dc60e2e1e88f6d8f2037b5651313ea570178a7532f8',
    previousPatchedSha256: '02bcef7ac9456dedb4f964344d7efc64b3a602bf8d3f7d7572147496ca15be3e',
  }),
})
const DSH_FREE_SEARCH_PACKAGE = 'dsh-free-search'
const DSH_FREE_SEARCH_DESKTOP_UPDATE_MARKER = 'DSH_DESKTOP_MANAGED_PLUGIN_UPDATE'
const DSH_FREE_SEARCH_UPDATE_PATTERN = /async updatePlugin\(\) \{\s*const mode = detectInstallMode\(\);/g
const DSH_FREE_SEARCH_COMPATIBILITY_TARGETS = Object.freeze({
  '0.4.15': Object.freeze({
    upstreamSha256: 'a586614413bdf81394877c738c18b85861aa15aafbb8bbf538bc29076db25a4a',
    patchedSha256: 'ca4afbd82dd4f0dbf25eb651a013070a56e34be7db2730751404464274f07097',
  }),
  '0.4.16': Object.freeze({
    upstreamSha256: '3ed787deb3f6800d6948701178bf7093b5ad127ca35e15d1892b5de23ae07f6c',
    patchedSha256: 'd7cc5ad5f20d44ef3bce69b13e324bfe9aeb13ca5ae37c1167131ccc8a9018a8',
  }),
  '0.4.17': Object.freeze({
    upstreamSha256: '0e6da8627f603ddbf42856fad2bc702e6efadace4ea41e03e3ba4f822b4edb97',
    patchedSha256: '05dd383128533f6664bb13c8413ab1b21101867b81aaf7f2435be402bfca1881',
  }),
  '0.4.22': Object.freeze({
    upstreamSha256: 'dee1a14388fa33a1eabdf84af8ba6c45b425a842cebb950ff17b4fc92e06f6d1',
    patchedSha256: '78c7414452502580274588616563ed7f576481f2b2988dce39a17b534f2a9d37',
  }),
})
const DSH_AGY_LINK_PACKAGE = 'dsh-agy-link'
const DSH_AGY_LINK_WINDOWS_CREDENTIAL_MARKER = 'DSH_DESKTOP_WINDOWS_CREDENTIAL_COMPAT'
const DSH_AGY_LINK_READER_PATTERN = /readSystemKeychainToken\(\)\s*\{\s*return readMacKeychainToken\(\);\s*\}/g
const DSH_AGY_LINK_INSERTION_MARKER = 'var QuotaService = class {'
const DSH_AGY_LINK_COMPATIBILITY_ASSET_SHA256 = 'ecd6a71e5916c706b684083e16098c4622d4cba7067721fa4f8ac4fae41c1b75'
const DSH_AGY_LINK_COMPATIBILITY_TARGETS = Object.freeze({
  '0.4.22': Object.freeze({
    upstreamSha256: '67bf37287c1f45295386ae2008f396534d62accf3da8a661f858174bdce82ae5',
    legacyPatchedSha256: '19d334ff43f06265ef54c25a25c7cae1254df5335c3a38db438268362f28c4fb',
    patchedSha256: '357f45b66e9fc07efc837fbf05ca36d75d94588345636b92c8e4848cf8df5ee7',
  }),
  '0.4.24': Object.freeze({
    upstreamSha256: 'f85434403aaf719ee5cefc4cb7ea619edd755a29a3a0b79f5f8b9e04681bd4fd',
    legacyPatchedSha256: '3b0a0e7345218cbba54758bbbb2b69e946c0b52d2741329c4865a3103d590153',
    patchedSha256: 'e07bfcd6e94d6187922f9d9f703cf25b5f193e709eaf2f4d2669bf7f99757269',
  }),
})
const DSH_DOCTOR_PACKAGE = '@linxin666/dsh-doctor'
const DSH_DOCTOR_LOCAL_SPEC_PATTERN = /^file:\.\/packages\/linxin666-dsh-doctor-\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?\.tgz$/i
const DSH_DOCTOR_GENERIC_SERVICE_MARKER = 'DSH_DESKTOP_GENERIC_SERVICE_INSTALL'
const DSH_DOCTOR_SUPERVISOR_COMMAND_PATTERN = /^(\s*)if \(command === ["']supervisor["']\) \{/m
const DSH_DOCTOR_SERVICE_INSTALL_COMMAND_PATTERN = /if \(command === ["']service-install["']\)/
const DSH_DOCTOR_CLEANUP_SCOPE_ENV = Object.freeze({
  candidateRoot: 'DSH_DESKTOP_DOCTOR_CANDIDATE_ROOT',
  cliPath: 'DSH_DESKTOP_DOCTOR_CLI_PATH',
  ownerPid: 'DSH_DESKTOP_DOCTOR_OWNER_PID',
  ownerStartedAt: 'DSH_DESKTOP_DOCTOR_OWNER_STARTED_AT',
})
const DSH_DOCTOR_BUILD_PERMISSIONS = Object.freeze({
  [DSH_DOCTOR_PACKAGE]: true,
  'node-pty': true,
  protobufjs: true,
})
const PLUGIN_ENGINE_COMPATIBILITY_OVERRIDES = Object.freeze([
  Object.freeze({
    name: DSH_DOCTOR_PACKAGE,
    pluginVersion: '0.3.9',
    dshVersion: '0.1.1-rc.2',
    requiredRange: '>=0.1.2-alpha.1',
    reason: 'dsh-doctor-0.3.9-desktop-compatibility-assets',
  }),
  Object.freeze({
    name: DSH_DOCTOR_PACKAGE,
    pluginVersion: '0.3.10',
    dshVersion: '0.1.1-rc.2',
    requiredRange: '>=0.1.2-alpha.1',
    reason: 'dsh-doctor-0.3.10-byte-identical-desktop-compatibility-assets',
  }),
])
const DSH_DOCTOR_COMPATIBILITY_RELEASES = Object.freeze([
  Object.freeze({
    acceptedVersions: Object.freeze(['0.3.6', '0.3.6-dshdesktop.1']),
    assetDirectory: '',
    targets: Object.freeze([
      Object.freeze({
        id: 'cli-launcher',
        path: Object.freeze(['lib', 'cli.mjs']),
        upstreamSha256: '5990e5fbd6fd090e08a6ad8762578586c8f9c47ae4678936830347d0c0deff1e',
        legacyPatchedSha256: Object.freeze([
          'ecb82475e8ad52e162c22f4dba1164df3c939d61f361f265a0af6c9652143ed0',
          '97a6e1e83db892527d778e8ebf5f9f0d61993b0859cd2f1bf2ac0ff7aa34cbf6',
          '4f8e86b161c5f0c1f5d0c058f28e1bdbe3813d12b063c2c728bebc78d1b36b8a',
          'a0708305eac3870734ff2a87c27d888a1d2c28750e8111ac56ca166960ac200f',
          '2457eec4d80bc38bfbcb0b2f299c0fe49be0340ea87809f4dfbf771b5d51d0a6',
        ]),
        patchedSha256: 'c2f0b272961992f8c617d32fd8f2870586543e30c04c03843d15a4bde09da127',
      }),
      Object.freeze({
        id: 'service-supervisor',
        path: Object.freeze(['lib', 'index.js']),
        upstreamSha256: '1819d1bb68def64467ae67b0d250bcdfcdc4b51d8ed0b71d5873d04445d7ee65',
        patchedSha256: '33fc9f361ecb6b4d0ee7677ee64df46a299025e6d718b879282d3bb87b2f646f',
      }),
    ]),
  }),
  Object.freeze({
    // 0.3.10 publishes byte-identical cli/index artifacts to 0.3.9. Keep the
    // same hash-pinned assets while accepting only these exact package versions.
    acceptedVersions: Object.freeze(['0.3.9', '0.3.9-dshdesktop.1', '0.3.10', '0.3.10-dshdesktop.1']),
    assetDirectory: 'v0.3.9',
    targets: Object.freeze([
      Object.freeze({
        id: 'cli-launcher',
        path: Object.freeze(['lib', 'cli.mjs']),
        upstreamSha256: 'b45f38202718615c679250d5dfe59cd9f779e35aa58990de5d7b8bb8043a93b0',
        legacyPatchedSha256: Object.freeze([
          '104339f61b948824cb05c287c34890cd55efa1a5067ba5fac9e10e0922a6d5b4',
          'e5ddf3fcd119998b12ede82112f1a095006005ad2ac37e5fecd43c5c9789b811',
          '87bbe73621df6c8044418fc25e14821dac72ac6b01bfe4068036ef77fba033fb',
        ]),
        patchedSha256: 'cae844164d959d0cb82be34d595211dd65f27c4e6c043294832c5a9b09924e15',
      }),
      Object.freeze({
        id: 'service-supervisor',
        path: Object.freeze(['lib', 'index.js']),
        upstreamSha256: 'cd9c9d9691013802edfe02865070a56ee37300db50897bd36d2412abf2ec9b66',
        patchedSha256: '4f501042da223be9440fc63df430cded479f165fe96aef0f5f4e96909884f902',
      }),
    ]),
  }),
])

/**
 * Give a future Doctor CLI the one desktop lifecycle verb that older Doctor
 * adapters exposed. The upstream supervisor remains untouched; this small
 * capability bridge starts it detached, makes it watch the desktop parent,
 * and lets the existing status handshake verify the result.
 */
export function patchDshDoctorFutureServiceInstall(source) {
  if (typeof source !== 'string') return { state: 'unrecognized', source }
  if (source.includes(DSH_DOCTOR_GENERIC_SERVICE_MARKER) || DSH_DOCTOR_SERVICE_INSTALL_COMMAND_PATTERN.test(source)) {
    return { state: 'compatible', source }
  }
  const match = source.match(DSH_DOCTOR_SUPERVISOR_COMMAND_PATTERN)
  if (match === null) return { state: 'unrecognized', source }
  const indent = match[1]
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const serviceInstall = [
    `${indent}if (command === "service-install") { // ${DSH_DOCTOR_GENERIC_SERVICE_MARKER}`,
    `${indent}\tconst child = spawn(process.execPath, [process.argv[1], "supervisor", "--parent-pid", String(process.ppid)], {`,
    `${indent}\t\tcwd: process.cwd(),`,
    `${indent}\t\tenv: { ...process.env },`,
    `${indent}\t\tstdio: "ignore",`,
    `${indent}\t\tdetached: true,`,
    `${indent}\t\twindowsHide: process.platform === "win32"`,
    `${indent}\t})`,
    `${indent}\tchild.unref?.()`,
    `${indent}\treturn 0`,
    `${indent}}`,
  ].join(eol)
  return {
    state: 'patched',
    source: source.replace(DSH_DOCTOR_SUPERVISOR_COMMAND_PATTERN, `${serviceInstall}${eol}${match[0]}`),
  }
}

function doctorCleanupScope({ candidateRoot, cliPath, ownerPid, ownerStartedAt } = {}) {
  if (![candidateRoot, cliPath].every(value => typeof value === 'string' && value.trim() !== '' && isAbsolute(value))) return undefined
  const normalizedCandidateRoot = resolve(candidateRoot)
  const normalizedCliPath = resolve(cliPath)
  const relativeCliPath = relative(normalizedCandidateRoot, normalizedCliPath).replaceAll('\\', '/')
  if (!/^profiles\/[^/]+\/node_modules\/@linxin666\/dsh-doctor\/lib\/cli\.mjs$/i.test(relativeCliPath)) return undefined
  const normalizedOwnerPid = Number(ownerPid)
  const normalizedOwnerStartedAt = Number(ownerStartedAt)
  if (!Number.isSafeInteger(normalizedOwnerPid) || normalizedOwnerPid < 1
    || !Number.isSafeInteger(normalizedOwnerStartedAt) || normalizedOwnerStartedAt < 0) return undefined
  return Object.freeze({
    candidateRoot: normalizedCandidateRoot,
    cliPath: normalizedCliPath,
    ownerPid: String(normalizedOwnerPid),
    ownerStartedAt: String(normalizedOwnerStartedAt),
    environment: Object.freeze({
      [DSH_DOCTOR_CLEANUP_SCOPE_ENV.candidateRoot]: normalizedCandidateRoot,
      [DSH_DOCTOR_CLEANUP_SCOPE_ENV.cliPath]: normalizedCliPath,
      [DSH_DOCTOR_CLEANUP_SCOPE_ENV.ownerPid]: String(normalizedOwnerPid),
      [DSH_DOCTOR_CLEANUP_SCOPE_ENV.ownerStartedAt]: String(normalizedOwnerStartedAt),
    }),
  })
}

export function buildWindowsDoctorSupervisorCleanupCommand(executable, powershellPath, scope = {}) {
  const normalizedScope = doctorCleanupScope(scope)
  if (normalizedScope === undefined) return undefined
  const encodedExecutable = Buffer.from(executable, 'utf8').toString('base64')
  const encodedCandidateRoot = Buffer.from(normalizedScope.candidateRoot, 'utf8').toString('base64')
  const encodedCliPath = Buffer.from(normalizedScope.cliPath, 'utf8').toString('base64')
  const encodedOwnerPid = Buffer.from(normalizedScope.ownerPid, 'utf8').toString('base64')
  const encodedOwnerStartedAt = Buffer.from(normalizedScope.ownerStartedAt, 'utf8').toString('base64')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedExecutable}'))`,
    `$targetCli = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedCliPath}'))`,
    `$candidateRoot = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedCandidateRoot}'))`,
    `$ownerPidText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedOwnerPid}'))`,
    `$ownerStartedAtText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedOwnerStartedAt}'))`,
    'try {',
    '  $target = [IO.Path]::GetFullPath($target)',
    '  $targetCli = [IO.Path]::GetFullPath($targetCli)',
    '  $candidateRoot = [IO.Path]::GetFullPath($candidateRoot)',
    '} catch { exit 0 }',
    '$ownerPid = 0',
    'if (-not [Int32]::TryParse($ownerPidText, [ref]$ownerPid) -or $ownerPid -le 0) { exit 0 }',
    '$ownerStartedAt = [Int64]0',
    'if (-not [Int64]::TryParse($ownerStartedAtText, [ref]$ownerStartedAt) -or $ownerStartedAt -lt 0) { exit 0 }',
    "$comparison = [StringComparison]::OrdinalIgnoreCase",
    '$currentPid = [Environment]::ProcessId',
    '$quotedExecutable = \'"\' + $target + \'"\'',
    '$cliPattern = \'(?i)(^|\\s)"?\' + [regex]::Escape($targetCli) + \'"?(?=\\s|$)\'',
    '$rootPattern = \'(?i)(^|\\s)--dsh-desktop-candidate-root\\s+"?\' + [regex]::Escape($candidateRoot) + \'"?(?=\\s|$)\'',
    '$ownerPidPattern = \'(?i)(^|\\s)--parent-pid\\s+\' + [regex]::Escape($ownerPidText) + \'(?=\\s|$)\'',
    '$ownerStartedAtPattern = \'(?i)(^|\\s)--parent-started-at\\s+\' + [regex]::Escape($ownerStartedAtText) + \'(?=\\s|$)\'',
    '$supervisorPattern = \'(?i)(^|\\s)supervisor(?=\\s|$)\'',
    '$matches = @(Get-CimInstance Win32_Process | Where-Object {',
    '  if ($_.ProcessId -eq $currentPid -or [string]::IsNullOrWhiteSpace($_.CommandLine)) { return $false }',
    '  $line = [string]$_.CommandLine',
    '  if (-not [regex]::IsMatch($line, $cliPattern) -or -not [regex]::IsMatch($line, $supervisorPattern)) { return $false }',
    '  if (-not [regex]::IsMatch($line, $rootPattern) -or -not [regex]::IsMatch($line, $ownerPidPattern) -or -not [regex]::IsMatch($line, $ownerStartedAtPattern)) { return $false }',
    '  $sameExecutable = $false',
    '  if (-not [string]::IsNullOrWhiteSpace($_.ExecutablePath)) {',
    '    try { $sameExecutable = [IO.Path]::GetFullPath([string]$_.ExecutablePath).Equals([IO.Path]::GetFullPath($target), $comparison) } catch { $sameExecutable = $false }',
    '  }',
    '  if (-not $sameExecutable -and $line.StartsWith($quotedExecutable + \' \', $comparison)) { $sameExecutable = $true }',
    '  if (-not $sameExecutable) { return $false }',
    '  try {',
    '    $creationValue = $_.CreationDate',
    '    if ($creationValue -is [DateTime]) {',
    '      $createdAt = [DateTimeOffset]$creationValue.ToUniversalTime()',
    '    } elseif ($creationValue -is [DateTimeOffset]) {',
    '      $createdAt = $creationValue.ToUniversalTime()',
    '    } elseif ($creationValue -is [string]) {',
    '      $createdAt = [DateTimeOffset]([System.Management.ManagementDateTimeConverter]::ToDateTime($creationValue).ToUniversalTime())',
    '    } else { return $false }',
    '    if ($createdAt.ToUnixTimeMilliseconds() -lt $ownerStartedAt) { return $false }',
    '  } catch { return $false }',
    '  return $true',
    '})',
    'if ($matches.Count -eq 0) { Write-Output "DSH_DOCTOR_CLEANUP_STATUS=skipped;count=0"; exit 0 }',
    'Write-Output ("DSH_DOCTOR_CLEANUP_STATUS=stopped;count=" + [string]$matches.Count)',
    'foreach ($item in $matches) {',
    '  Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop',
    '  for ($attempt = 0; $attempt -lt 50 -and (Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue); $attempt += 1) { Start-Sleep -Milliseconds 100 }',
    '  if (Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue) { throw "doctor: timed out stopping stale supervisor $($item.ProcessId)" }',
    '}',
  ].join('\r\n')
  return Object.freeze({
    command: powershellPath,
    args: Object.freeze([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ]),
  })
}

function patchBetterDshPetLauncher(source) {
  if (source.includes(BETTER_DSH_PET_ENV_MARKER)) return { state: 'compatible', source }
  const envMatches = [...source.matchAll(BETTER_DSH_PET_ENV_PATTERN)]
  const spawnMatches = [...source.matchAll(new RegExp(BETTER_DSH_PET_SPAWN_PATTERN.source, `${BETTER_DSH_PET_SPAWN_PATTERN.flags}g`))]
  if (envMatches.length !== 1 || spawnMatches.length !== 1) return { state: 'unrecognized', source }
  const indent = spawnMatches[0][1]
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const childEnvironment = [
    `${indent}const childEnv = { ...process.env, ...this.options.env }`,
    `${indent}delete childEnv.ELECTRON_RUN_AS_NODE`,
    '',
    `${indent}const child = spawn(command, args, {`,
  ].join(eol)
  return {
    state: 'patched',
    source: source
      .replace(BETTER_DSH_PET_SPAWN_PATTERN, childEnvironment)
      .replace(BETTER_DSH_PET_ENV_PATTERN, 'env: childEnv'),
  }
}

function patchBetterDshPetWindow(source) {
  let patched = false
  let nextSource = source
  const eol = source.includes('\r\n') ? '\r\n' : '\n'

  if (!nextSource.includes(BETTER_DSH_PET_TOPMOST_MARKER)) {
    const matches = [...nextSource.matchAll(new RegExp(BETTER_DSH_PET_READY_PATTERN.source, `${BETTER_DSH_PET_READY_PATTERN.flags}g`))]
    if (matches.length !== 1) return { state: 'unrecognized', source }
    nextSource = nextSource.replace(BETTER_DSH_PET_READY_PATTERN, [
      "mainWindow.once('ready-to-show', () => {",
      '    mainWindow.showInactive()',
      "    mainWindow.setAlwaysOnTop(true, 'screen-saver')",
      '    mainWindow.moveTop()',
      '  })',
    ].join(eol))
    patched = true
  }

  if (!nextSource.includes(BETTER_DSH_PET_ALWAYS_VISIBLE_MARKER)
      && nextSource.includes(BETTER_DSH_PET_AUTO_HIDE_FUNCTION_MARKER)) {
    const matches = [...nextSource.matchAll(new RegExp(BETTER_DSH_PET_AUTO_HIDE_PATTERN.source, BETTER_DSH_PET_AUTO_HIDE_PATTERN.flags))]
    if (matches.length !== 1) return { state: 'unrecognized', source }
    nextSource = nextSource.replace(
      BETTER_DSH_PET_AUTO_HIDE_PATTERN,
      `const shouldHide = false // ${BETTER_DSH_PET_ALWAYS_VISIBLE_MARKER}`,
    )
    patched = true
  }

  return {
    state: patched ? 'patched' : 'compatible',
    source: nextSource,
  }
}

/**
 * The packaged desktop starts DSH through Electron's Node mode. The pet then
 * launches a second Electron process, which must not inherit that flag. Its
 * transparent window also needs its topmost level asserted after the hidden
 * window is shown on Windows, otherwise another application can cover it. The
 * upstream fullscreen watchdog treats unknown desktop apps as games and hides
 * the pet, so the desktop build keeps it visible unless the user hides it.
 *
 * This package-scoped adapter is idempotent and runs for both active releases
 * and newly finalized plugin candidates, so normal plugin updates cannot
 * silently reintroduce either desktop-only failure.
 */
async function ensureCandidateBetterDshPetRuntimeCompatibility(candidateDir, physicalProfilePath, options = {}) {
  const candidateRoot = resolve(candidateDir)
  const profileRoot = resolve(physicalProfilePath)
  if (!isWithin(candidateRoot, profileRoot)) throw new Error('Candidate plugin profile escapes its release directory')
  const packageRoot = join(profileRoot, 'node_modules', BETTER_DSH_PET_PACKAGE)
  if (!isWithin(profileRoot, packageRoot)) throw new Error('Candidate plugin package escapes its profile')

  try {
    const [details, packageRealPath] = await Promise.all([lstat(packageRoot), realpath(packageRoot)])
    if (!details.isDirectory()) throw new Error('better-dsh-pet compatibility package is not a directory')
    if (!isWithin(candidateRoot, packageRealPath)) throw new Error('better-dsh-pet compatibility package escapes its release')
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ packageName: BETTER_DSH_PET_PACKAGE, state: 'absent', targets: [] })
    throw error
  }

  const targetResults = []
  for (const target of BETTER_DSH_PET_COMPATIBILITY_TARGETS) {
    const targetPath = join(packageRoot, ...target.path)
    if (!isWithin(packageRoot, targetPath)) throw new Error('better-dsh-pet compatibility target escapes its package')
    let source
    try {
      const [details, targetRealPath, content] = await Promise.all([
        lstat(targetPath),
        realpath(targetPath),
        readFile(targetPath, 'utf8'),
      ])
      if (!details.isFile()) throw new Error('better-dsh-pet compatibility target is not a regular file')
      if (!isWithin(candidateRoot, targetRealPath)) throw new Error('better-dsh-pet compatibility target escapes its release')
      source = content
    } catch (error) {
      if (error?.code === 'ENOENT') {
        targetResults.push(Object.freeze({ id: target.id, state: 'unrecognized' }))
        continue
      }
      throw error
    }

    const result = target.id === 'launcher-env'
      ? patchBetterDshPetLauncher(source)
      : patchBetterDshPetWindow(source)
    if (result.state === 'patched' && options.write !== false) await writeTextAtomic(targetPath, result.source)
    targetResults.push(Object.freeze({ id: target.id, state: result.state, path: targetPath }))
  }

  const state = targetResults.some(target => target.state === 'patched')
    ? 'patched'
    : targetResults.some(target => target.state === 'unrecognized')
      ? 'unrecognized'
      : 'compatible'
  return Object.freeze({ packageName: BETTER_DSH_PET_PACKAGE, state, targets: Object.freeze(targetResults) })
}

export function patchDshSignalDesktopBrandObserver(source) {
  if (typeof source !== 'string') return { state: 'unrecognized', source }
  if (source.includes(DSH_SIGNAL_DESKTOP_RECONCILE_MARKER)) return { state: 'compatible', source }
  const declarationPattern = /(^[ \t]*)let disposed = false\r?\n\1let reconcileQueued = false\r?\n\1let mount = null/m
  const schedulePattern = /(^[ \t]*)const scheduleReconcile = \(\) => \{\r?\n\1  if \(disposed \|\| reconcileQueued\) return\r?\n\1  reconcileQueued = true\r?\n\1  queueMicrotask\(\(\) => \{\r?\n\1    reconcileQueued = false\r?\n\1    reconcileBrandFx\(\)\r?\n\1  \}\)\r?\n\1\}/m
  const observerPattern = /(^[ \t]*)const integrityObserver = new MutationObserver\(scheduleReconcile\)\r?\n\1integrityObserver\.observe\(document\.body, \{ childList: true, subtree: true, characterData: true \}\)/m
  const cleanupPattern = /(^[ \t]*)integrityObserver\.disconnect\(\)\r?\n\1mount\?\.stop\(\)/m
  const patterns = [declarationPattern, schedulePattern, observerPattern, cleanupPattern]
  if (patterns.some(pattern => source.match(pattern)?.length !== 2)) return { state: 'unrecognized', source }
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const nextSource = source
    .replace(declarationPattern, (_match, indent) => [
      `${indent}let disposed = false`,
      `${indent}let reconcileFrame = 0 // ${DSH_SIGNAL_DESKTOP_RECONCILE_MARKER}`,
      `${indent}let mount = null`,
    ].join(eol))
    .replace(schedulePattern, (_match, indent) => [
      `${indent}const mutationAffectsBrand = record => {`,
      `${indent}  const fxHost = mount?.fxHost`,
      `${indent}  if (fxHost instanceof Node && (record.target === fxHost || fxHost.contains(record.target))) return false`,
      `${indent}  const headline = mount?.headline`,
      `${indent}  if (headline instanceof Node && (record.target === headline || headline.contains(record.target))) return true`,
      `${indent}  const affectedNodes = [...record.addedNodes, ...record.removedNodes]`,
      `${indent}  return affectedNodes.some(node => {`,
      `${indent}    if (!(node instanceof Node)) return false`,
      `${indent}    if (fxHost instanceof Node && (node === fxHost || fxHost.contains(node))) return false`,
      `${indent}    return node === root`,
      `${indent}      || node.contains(root)`,
      `${indent}      || root.contains(node)`,
      `${indent}      || (headline instanceof Node && (`,
      `${indent}        node === headline`,
      `${indent}        || node.contains(headline)`,
      `${indent}        || headline.contains(node)`,
      `${indent}      ))`,
      `${indent}  })`,
      `${indent}}`,
      `${indent}const scheduleReconcile = () => {`,
      `${indent}  if (disposed || reconcileFrame !== 0) return`,
      `${indent}  reconcileFrame = window.requestAnimationFrame(reconcileBrandFx)`,
      `${indent}}`,
    ].join(eol))
    .replace(observerPattern, (_match, indent) => [
      `${indent}const integrityObserver = new MutationObserver(records => {`,
      `${indent}  if (records.some(mutationAffectsBrand)) scheduleReconcile()`,
      `${indent}})`,
      `${indent}integrityObserver.observe(document.body, { childList: true, subtree: true, characterData: true })`,
    ].join(eol))
    .replace(cleanupPattern, (_match, indent) => [
      `${indent}integrityObserver.disconnect()`,
      `${indent}if (reconcileFrame !== 0) window.cancelAnimationFrame(reconcileFrame)`,
      `${indent}mount?.stop()`,
    ].join(eol))
  return { state: 'patched', source: nextSource }
}

/**
 * Chromium's Web Speech implementation may end an otherwise healthy
 * continuous recognition session after a short silence or a service recycle.
 * The upstream STT plugin treats every onend as an explicit user stop, which
 * makes the microphone button drop back to idle after one click. Keep the
 * session alive until the user clicks again, preserve finalized segments, and
 * fail only for errors that genuinely require user intervention.
 */
export function patchDshSttInputBrowserSession(source) {
  if (typeof source !== 'string') return { state: 'unrecognized', source }
  if (source.includes(DSH_STT_INPUT_RESULT_MARKER)) return { state: 'compatible', source }
  if (source.includes(DSH_STT_INPUT_DESKTOP_SESSION_MARKER)) return preserveSttResults(source)
  const browserMatch = source.match(DSH_STT_INPUT_BROWSER_BLOCK_PATTERN)
  const stopMatch = source.match(DSH_STT_INPUT_STOP_PATTERN)
  if (browserMatch === null || stopMatch === null || source.split('var activeRec = null;').length - 1 !== 1) {
    return { state: 'unrecognized', source }
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const indent = browserMatch[1]
  const inner = `${indent}  `
  const nested = `${indent}    `
  const deeper = `${indent}      `
  const browserReplacement = [
    `${indent}if (cfg.engine === 'browser') { // ${DSH_STT_INPUT_DESKTOP_SESSION_MARKER}`,
    `${inner}var SR = browserSR();`,
    `${inner}if (!SR) {`,
    `${nested}setStatus({ kind: 'error', msg: T('err.browserUnsupported') });`,
    `${nested}return;`,
    `${inner}}`,
    `${inner}var session = { stopping: false, rec: null, restartTimer: null, finalText: '', instanceFinal: '' };`,
    `${inner}function clearRestart() {`,
    `${nested}if (session.restartTimer !== null) { clearTimeout(session.restartTimer); session.restartTimer = null; }`,
    `${inner}}`,
    `${inner}function finishError(message) {`,
    `${nested}if (session.stopping) return;`,
    `${nested}session.stopping = true;`,
    `${nested}clearRestart();`,
    `${nested}if (activeRec === session.rec) activeRec = null;`,
    `${nested}if (activeBrowserStop === session.stop) activeBrowserStop = null;`,
    `${nested}setStatus({ kind: 'error', msg: message });`,
    `${inner}}`,
    `${inner}function scheduleRestart() {`,
    `${nested}if (session.stopping || session.restartTimer !== null) return;`,
    `${nested}session.restartTimer = setTimeout(function () {`,
    `${deeper}session.restartTimer = null;`,
    `${deeper}if (!session.stopping) launch();`,
    `${nested}}, 180);`,
    `${inner}}`,
    `${inner}function launch() {`,
    `${nested}if (session.stopping) return;`,
    `${nested}var rec = new SR();`,
    `${nested}var instanceFinal = '';`,
    `${nested}session.rec = rec;`,
    `${nested}session.instanceFinal = '';`,
    `${nested}activeRec = rec;`,
    `${nested}rec.lang = cfg.language === 'auto' ? (navigator.language || 'en') : cfg.language;`,
    `${nested}rec.continuous = true;`,
    `${nested}rec.interimResults = true;`,
    `${nested}rec.onresult = function (e) {`,
    `${deeper}var f = '';`,
    `${deeper}var it = '';`,
    `${deeper}for (var i = 0; i < e.results.length; i++) {`,
    `${deeper}  if (e.results[i].isFinal) f += e.results[i][0].transcript;`,
    `${deeper}  else it = e.results[i][0].transcript;`,
    `${deeper}}`,
    `${deeper}instanceFinal = f;`,
    `${deeper}session.instanceFinal = f;`,
    `${deeper}var prefix = session.finalText ? session.finalText + ' ' : '';`,
    `${deeper}applyText(inputActions, base, (prefix + f + it).replace(/\\s+$/, ''));`,
    `${nested}};`,
    `${nested}rec.onerror = function (e) {`,
    `${deeper}if (session.stopping) return;`,
    `${deeper}var name = (e && e.error) || 'unknown';`,
    `${deeper}if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].indexOf(name) >= 0) {`,
    `${deeper}  finishError(T('err.localError', { err: name }));`,
    `${deeper}  return;`,
    `${deeper}}`,
    `${deeper}session.lastError = name;`,
    `${nested}};`,
    `${nested}rec.onend = function () {`,
    `${deeper}if (session.stopping) return;`,
    `${deeper}if (activeRec === rec) activeRec = null;`,
    `${deeper}var segment = (instanceFinal || '').trim();`,
    `${deeper}if (segment) session.finalText = (session.finalText ? session.finalText + ' ' : '') + segment;`,
    `${deeper}session.instanceFinal = '';`,
    `${deeper}applyText(inputActions, base, session.finalText);`,
    `${deeper}scheduleRestart();`,
    `${nested}};`,
    `${nested}try { rec.start(); } catch (e) {`,
    `${deeper}if (e && e.name === 'InvalidStateError') { scheduleRestart(); return; }`,
    `${deeper}finishError(T('err.startFailed', { err: ((e && e.message) || String(e)) }));`,
    `${nested}}`,
    `${inner}}`,
    `${inner}session.stop = function () {`,
    `${nested}if (session.stopping) return;`,
    `${nested}session.stopping = true;`,
    `${nested}clearRestart();`,
    `${nested}if (activeRec === session.rec) activeRec = null;`,
    `${nested}var rec = session.rec;`,
    `${nested}session.rec = null;`,
    `${nested}activeBrowserStop = null;`,
    `${nested}var segment = (session.instanceFinal || '').trim();`,
    `${nested}if (segment) session.finalText = (session.finalText ? session.finalText + ' ' : '') + segment;`,
    `${nested}applyText(inputActions, base, session.finalText);`,
    `${nested}setStatus({ kind: 'idle' });`,
    `${nested}try { if (rec && typeof rec.stop === 'function') rec.stop(); } catch (e) { /* already ended */ }`,
    `${inner}};`,
    `${inner}activeBrowserStop = session.stop;`,
    `${inner}setStatus({ kind: 'recording' });`,
    `${inner}launch();`,
    `${indent}} else {`,
  ].join(eol)
  const stopReplacement = [
    `${stopMatch[1]}function stopRecording(inputActions, base, cfg) {`,
    `${stopMatch[1]}  if (cfg.engine === 'browser' && typeof activeBrowserStop === 'function') {`,
    `${stopMatch[1]}    var stop = activeBrowserStop;`,
    `${stopMatch[1]}    activeBrowserStop = null;`,
    `${stopMatch[1]}    stop();`,
    `${stopMatch[1]}    return;`,
    `${stopMatch[1]}  }`,
    `${stopMatch[1]}  var rec = activeRec;`,
    `${stopMatch[1]}  activeRec = null;`,
    `${stopMatch[1]}  if (!rec) return;`,
    `${stopMatch[1]}  try { rec.stop(); } catch (e) {`,
    `${stopMatch[1]}    if (cfg.engine === 'api') finalizeApi(inputActions, base, cfg);`,
    `${stopMatch[1]}    else setStatus({ kind: 'error', msg: T('err.stopFailed') });`,
    `${stopMatch[1]}  }`,
    `${stopMatch[1]}}`,
  ].join(eol)
  const nextSource = source
    .replace('var activeRec = null;', 'var activeRec = null;\n    var activeBrowserStop = null;')
    .replace(DSH_STT_INPUT_BROWSER_BLOCK_PATTERN, browserReplacement)
    .replace(DSH_STT_INPUT_STOP_PATTERN, stopReplacement)
  return preserveSttResults(nextSource)
}

function preserveSttResults(source) {
  // Upgrade only our known session implementation. Keep interim recognition
  // when a service ends without a final result, and surface network failures.
  if (!source.includes("session.instanceFinal = f;") || !source.includes("var segment = (session.instanceFinal || '').trim();")) return { state: 'unrecognized', source }
  const next = source
    .replace(DSH_STT_INPUT_DESKTOP_SESSION_MARKER, `${DSH_STT_INPUT_DESKTOP_SESSION_MARKER} ${DSH_STT_INPUT_RESULT_MARKER}`)
    .replace("session.instanceFinal = f;", "session.instanceFinal = f + it;")
    .replace("var segment = (instanceFinal || '').trim();", "var segment = (session.instanceFinal || instanceFinal || '').trim();")
    .replace("['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported']", "['network', 'not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported']")
    .replace("setStatus({ kind: 'idle' });\n          try { if (rec", "setStatus(session.finalText ? { kind: 'idle' } : { kind: 'error', msg: T('err.localError', { err: 'no-result: speech service returned no text' }) });\n          try { if (rec")
    .replace("setStatus({ kind: 'idle' });\r\n          try { if (rec", "setStatus(session.finalText ? { kind: 'idle' } : { kind: 'error', msg: T('err.localError', { err: 'no-result: speech service returned no text' }) });\r\n          try { if (rec")
  return { state: 'patched', source: next }
}

/**
 * Apply the audited browser-session repair only to the exact dsh-stt-input
 * release. A later upstream layout is rejected rather than silently replaced;
 * the release transaction then keeps the previous last-known-good profile.
 */
export async function ensureCandidateDshSttInputRuntimeCompatibility(
  candidateDir,
  physicalProfilePath,
  options = {},
) {
  const candidateRoot = resolve(candidateDir)
  const profileRoot = resolve(physicalProfilePath)
  if (!isWithin(candidateRoot, profileRoot)) throw new Error('dsh-stt-input candidate profile escapes its release directory')
  const packageRoot = join(profileRoot, 'node_modules', DSH_STT_INPUT_PACKAGE)
  if (!isWithin(profileRoot, packageRoot)) throw new Error('dsh-stt-input compatibility package escapes its profile')

  try {
    const [details, packageRealPath] = await Promise.all([lstat(packageRoot), realpath(packageRoot)])
    if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isDirectory()) {
      throw new Error('dsh-stt-input compatibility package is not a regular directory')
    }
    if (!isWithin(candidateRoot, packageRealPath)) throw new Error('dsh-stt-input compatibility package escapes its release')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({ packageName: DSH_STT_INPUT_PACKAGE, required: true, state: 'absent', targets: Object.freeze([]) })
    }
    throw error
  }

  const packageJsonPath = join(packageRoot, 'package.json')
  const targetPath = join(packageRoot, 'lib', 'client.js')
  if (!isWithin(packageRoot, targetPath)) throw new Error('dsh-stt-input compatibility target escapes its package')
  let version
  try {
    version = JSON.parse(await readFile(packageJsonPath, 'utf8'))?.version
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const targets = options.targets ?? DSH_STT_INPUT_COMPATIBILITY_TARGETS
  const target = targets?.[version]

  try {
    const [details, targetRealPath, source, currentSha256] = await Promise.all([
      lstat(targetPath),
      realpath(targetPath),
      readFile(targetPath, 'utf8'),
      sha256File(targetPath),
    ])
    if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isFile()) {
      throw new Error('dsh-stt-input compatibility target is not a regular file')
    }
    if (!isWithin(candidateRoot, targetRealPath) || !isWithin(packageRoot, targetRealPath)) {
      throw new Error('dsh-stt-input compatibility target escapes its release')
    }

    const patched = patchDshSttInputBrowserSession(source)
    if (patched.state === 'compatible') {
      const alreadyVerified = target === undefined || currentSha256 === target.patchedSha256
      return Object.freeze({
        packageName: DSH_STT_INPUT_PACKAGE,
        required: true,
        version: typeof version === 'string' ? version : null,
        state: alreadyVerified ? 'compatible' : 'unrecognized',
        targets: Object.freeze([{ id: 'resilient-browser-session', state: alreadyVerified ? 'compatible' : 'unrecognized', path: targetPath }]),
      })
    }
    if (target === undefined
      || typeof target.upstreamSha256 !== 'string'
      || typeof target.patchedSha256 !== 'string'
      || (currentSha256 !== target.upstreamSha256 && currentSha256 !== target.previousPatchedSha256)
      || patched.state !== 'patched') {
      return Object.freeze({
        packageName: DSH_STT_INPUT_PACKAGE,
        required: true,
        version: typeof version === 'string' ? version : null,
        state: 'unrecognized',
        targets: Object.freeze([{ id: 'resilient-browser-session', state: 'unrecognized', path: targetPath }]),
      })
    }
    const patchedSha256 = createHash('sha256').update(patched.source).digest('hex')
    if (patchedSha256 !== target.patchedSha256) {
      throw new Error('dsh-stt-input compatibility output failed its audited integrity check')
    }
    if (options.write !== false) await writeTextAtomic(targetPath, patched.source)
    return Object.freeze({
      packageName: DSH_STT_INPUT_PACKAGE,
      required: true,
      version,
      state: 'patched',
      targets: Object.freeze([{ id: 'resilient-browser-session', state: 'patched', path: targetPath, patchedSha256 }]),
    })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return Object.freeze({
      packageName: DSH_STT_INPUT_PACKAGE,
      required: true,
      version: typeof version === 'string' ? version : null,
      state: 'unrecognized',
      targets: Object.freeze([{ id: 'resilient-browser-session', state: 'unrecognized', path: targetPath }]),
    })
  }
}

/**
 * Signal 0.5.10 observes the entire document and queues a microtask after every
 * DOM mutation. In Electron that observer can form a feedback loop with the
 * desktop integration and starve the renderer. Patch only the audited release;
 * later upstream versions are accepted when they either carry this marker or no
 * longer contain the known unbounded observer shape.
 */
export async function ensureCandidateDshSignalRuntimeCompatibility(
  candidateDir,
  physicalProfilePath,
  options = {},
) {
  const candidateRoot = resolve(candidateDir)
  const profileRoot = resolve(physicalProfilePath)
  if (!isWithin(candidateRoot, profileRoot)) throw new Error('dsh-signal candidate profile escapes its release directory')
  const packageRoot = join(profileRoot, 'node_modules', DSH_SIGNAL_PACKAGE)
  if (!isWithin(profileRoot, packageRoot)) throw new Error('dsh-signal compatibility package escapes its profile')

  try {
    const [details, packageRealPath] = await Promise.all([lstat(packageRoot), realpath(packageRoot)])
    if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isDirectory()) {
      throw new Error('dsh-signal compatibility package is not a regular directory')
    }
    if (!isWithin(candidateRoot, packageRealPath)) throw new Error('dsh-signal compatibility package escapes its release')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({ packageName: DSH_SIGNAL_PACKAGE, required: true, state: 'absent', targets: Object.freeze([]) })
    }
    throw error
  }

  const packageJsonPath = join(packageRoot, 'package.json')
  const targetPath = join(packageRoot, 'lib', 'client.js')
  if (!isWithin(packageRoot, targetPath)) throw new Error('dsh-signal compatibility target escapes its package')
  let version
  try {
    version = JSON.parse(await readFile(packageJsonPath, 'utf8'))?.version
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const targets = options.targets ?? DSH_SIGNAL_COMPATIBILITY_TARGETS
  const target = targets?.[version]

  try {
    const [details, targetRealPath, source, currentSha256] = await Promise.all([
      lstat(targetPath),
      realpath(targetPath),
      readFile(targetPath, 'utf8'),
      sha256File(targetPath),
    ])
    if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isFile()) {
      throw new Error('dsh-signal compatibility target is not a regular file')
    }
    if (!isWithin(candidateRoot, targetRealPath) || !isWithin(packageRoot, targetRealPath)) {
      throw new Error('dsh-signal compatibility target escapes its release')
    }

    const patched = patchDshSignalDesktopBrandObserver(source)
    if (patched.state === 'compatible') {
      return Object.freeze({
        packageName: DSH_SIGNAL_PACKAGE,
        required: true,
        version: typeof version === 'string' ? version : null,
        state: 'compatible',
        targets: Object.freeze([{ id: 'bounded-brand-reconcile', state: 'compatible', path: targetPath }]),
      })
    }
    if (patched.state === 'unrecognized' && target === undefined) {
      const knownUnboundedShape = source.includes('let reconcileQueued = false')
        || source.includes('new MutationObserver(scheduleReconcile)')
      return Object.freeze({
        packageName: DSH_SIGNAL_PACKAGE,
        required: true,
        version: typeof version === 'string' ? version : null,
        state: knownUnboundedShape ? 'unrecognized' : 'compatible',
        targets: Object.freeze([{
          id: 'bounded-brand-reconcile',
          state: knownUnboundedShape ? 'unrecognized' : 'compatible-upstream',
          path: targetPath,
        }]),
      })
    }
    if (target === undefined
      || typeof target.upstreamSha256 !== 'string'
      || typeof target.patchedSha256 !== 'string'
      || currentSha256 !== target.upstreamSha256
      || patched.state !== 'patched') {
      return Object.freeze({
        packageName: DSH_SIGNAL_PACKAGE,
        required: true,
        version: typeof version === 'string' ? version : null,
        state: 'unrecognized',
        targets: Object.freeze([{ id: 'bounded-brand-reconcile', state: 'unrecognized', path: targetPath }]),
      })
    }
    const patchedSha256 = createHash('sha256').update(patched.source).digest('hex')
    if (patchedSha256 !== target.patchedSha256) {
      throw new Error('dsh-signal compatibility output failed its audited integrity check')
    }
    if (options.write !== false) await writeTextAtomic(targetPath, patched.source)
    return Object.freeze({
      packageName: DSH_SIGNAL_PACKAGE,
      required: true,
      version,
      state: 'patched',
      targets: Object.freeze([{ id: 'bounded-brand-reconcile', state: 'patched', path: targetPath, patchedSha256 }]),
    })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return Object.freeze({
      packageName: DSH_SIGNAL_PACKAGE,
      required: true,
      version: typeof version === 'string' ? version : null,
      state: 'unrecognized',
      targets: Object.freeze([{ id: 'bounded-brand-reconcile', state: 'unrecognized', path: targetPath }]),
    })
  }
}

/**
 * The pi-ai catalog is shipped as generated data, but OpenCode Go changes its
 * roster independently of the DSH release. Reconcile each candidate against
 * the live official model endpoint and protocol documentation so newly
 * advertised models are not missing and moved wire protocols do not fail at
 * request time. A live probe failure keeps the candidate's last-known-good
 * catalog; it never invents a static roster or mutates the active release.
 */
export async function ensureCandidateDshPiAiOpenCodeGoRuntimeCompatibility(
  candidateDir,
  physicalProfilePath,
  options = {},
) {
  const candidateRoot = resolve(candidateDir)
  const profileRoot = resolve(physicalProfilePath)
  if (!isWithin(candidateRoot, profileRoot)) throw new Error('pi-ai candidate profile escapes its release directory')
  const packageRoots = [profileRoot]
  let runtimeVersion
  try {
    runtimeVersion = JSON.parse(await readFile(join(candidateRoot, 'manifest.json'), 'utf8'))?.dsh?.version
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (typeof runtimeVersion === 'string' && runtimeVersion.trim() !== '') {
    packageRoots.push(join(candidateRoot, 'runtime', 'versions', runtimeVersion))
  } else {
    try {
      const entries = await readdir(join(candidateRoot, 'runtime', 'versions'), { withFileTypes: true })
      for (const entry of entries) if (entry.isDirectory()) packageRoots.push(join(candidateRoot, 'runtime', 'versions', entry.name))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  let referenceSource
  for (const packageBase of packageRoots) {
    const targetPath = join(resolve(packageBase), 'node_modules', '@earendil-works', 'pi-ai', ...DSH_PI_AI_OPEN_CODE_GO_CATALOG_PATH)
    try {
      referenceSource = await readFile(targetPath, 'utf8')
      break
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  const liveSync = referenceSource === undefined
    ? { status: 'no-package', catalog: null, liveModelCount: null, appliedModelCount: null, unknownModelIds: [], reason: '', documentationStatus: 'not-requested' }
    : await resolveLiveOpenCodeGoCatalog(candidateRoot, { ...options, currentSource: referenceSource })

  const seenRoots = new Set()
  const reports = []
  for (const packageBase of packageRoots) {
    const baseRoot = resolve(packageBase)
    if (seenRoots.has(baseRoot)) continue
    seenRoots.add(baseRoot)
    const packageRoot = join(baseRoot, 'node_modules', '@earendil-works', 'pi-ai')
    if (!isWithin(baseRoot, packageRoot) || !isWithin(candidateRoot, packageRoot)) {
      throw new Error('pi-ai compatibility package escapes its release')
    }
    const targetPath = join(packageRoot, ...DSH_PI_AI_OPEN_CODE_GO_CATALOG_PATH)
    if (!isWithin(packageRoot, targetPath)) throw new Error('pi-ai compatibility target escapes its package')

    let version
    try {
      const details = await lstat(packageRoot)
      const packageRealPath = await realpath(packageRoot)
      if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isDirectory()) {
        throw new Error('pi-ai compatibility package is not a regular directory')
      }
      if (!isWithin(candidateRoot, packageRealPath)) throw new Error('pi-ai compatibility package escapes its release')
      version = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))?.version
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }

    const id = baseRoot === profileRoot
      ? 'official-go-catalog'
      : `official-go-catalog-${baseRoot.split(/[\\/]/u).pop()}`

    try {
      const [details, targetRealPath, source, currentSha256] = await Promise.all([
        lstat(targetPath),
        realpath(targetPath),
        readFile(targetPath, 'utf8'),
        sha256File(targetPath),
      ])
      if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isFile()) {
        throw new Error('pi-ai compatibility target is not a regular file')
      }
      if (!isWithin(candidateRoot, targetRealPath) || !isWithin(packageRoot, targetRealPath)) {
        throw new Error('pi-ai compatibility target escapes its release')
      }

      if (liveSync.catalog === null) {
        reports.push({
          required: false,
          version,
          state: 'compatible',
          targets: [{
            id,
            state: 'stale-cache',
            path: targetPath,
            liveSyncStatus: liveSync.status,
          }],
        })
        continue
      }

      let currentCatalog
      try { currentCatalog = JSON.parse(source) } catch {
        currentCatalog = undefined
      }
      if (!isDshOpenCodeGoCatalog(currentCatalog)) {
        reports.push({ required: true, version, state: 'unrecognized', targets: [{ id, state: 'unrecognized', path: targetPath }] })
        continue
      }

      const patched = patchDshOpenCodeGoModelCatalog(source, liveSync.catalog)
      if (patched.state === 'compatible') {
        reports.push({
          required: true,
          version,
          state: 'compatible',
          targets: [{
            id,
            state: 'compatible',
            path: targetPath,
            liveSyncStatus: liveSync.status,
            liveModelCount: liveSync.liveModelCount,
            appliedModelCount: liveSync.appliedModelCount,
          }],
        })
        continue
      }
      if (patched.state !== 'patched') {
        reports.push({ required: true, version, state: 'unrecognized', targets: [{ id, state: 'unrecognized', path: targetPath }] })
        continue
      }
      const patchedSha256 = createHash('sha256').update(patched.source).digest('hex')
      if (!isDshOpenCodeGoCatalog(JSON.parse(patched.source))) throw new Error('pi-ai OpenCode Go live catalog failed validation')
      if (options.write !== false) await writeTextAtomic(targetPath, patched.source)
      reports.push({
        required: true,
        version,
        state: 'patched',
        targets: [{
          id,
          state: 'patched',
          path: targetPath,
          patchedSha256,
          liveSyncStatus: liveSync.status,
          liveModelCount: liveSync.liveModelCount,
          appliedModelCount: liveSync.appliedModelCount,
          unknownModelIds: liveSync.unknownModelIds,
          documentationStatus: liveSync.documentationStatus,
        }],
      })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      reports.push({ required: true, version: typeof version === 'string' ? version : null, state: 'unrecognized', targets: [{ id, state: 'unrecognized', path: targetPath }] })
    }
  }

  if (reports.length === 0) {
    return Object.freeze({
      packageName: DSH_PI_AI_PACKAGE,
      required: false,
      version: null,
      state: 'absent',
      targets: Object.freeze([]),
    })
  }
  const versions = [...new Set(reports.map(report => report.version).filter(value => typeof value === 'string' && value !== ''))]
  const state = reports.some(report => report.state === 'unrecognized')
    ? 'unrecognized'
    : reports.some(report => report.state === 'patched') ? 'patched' : 'compatible'
  return Object.freeze({
    packageName: DSH_PI_AI_PACKAGE,
    required: reports.some(report => report.required === true),
    version: versions.length === 1 ? versions[0] : versions.join(','),
    state,
    targets: Object.freeze(reports.flatMap(report => report.targets).map(target => Object.freeze(target))),
    liveSync: Object.freeze({
      status: liveSync.status,
      endpoint: OPEN_CODE_GO_MODEL_ENDPOINT,
      documentationEndpoint: OPEN_CODE_GO_DOCUMENTATION_ENDPOINT,
      liveModelCount: liveSync.liveModelCount,
      appliedModelCount: liveSync.appliedModelCount,
      unknownModelIds: Object.freeze([...(liveSync.unknownModelIds ?? [])]),
      documentationStatus: liveSync.documentationStatus,
      reason: liveSync.reason,
    }),
  })
}

export function patchDshFreeSearchDesktopUpdate(source) {
  if (typeof source !== 'string') return { state: 'unrecognized', source }
  if (source.includes(DSH_FREE_SEARCH_DESKTOP_UPDATE_MARKER)) return { state: 'compatible', source }
  const matches = [...source.matchAll(DSH_FREE_SEARCH_UPDATE_PATTERN)]
  if (matches.length !== 1) return { state: 'unrecognized', source }
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  return {
    state: 'patched',
    source: source.replace(DSH_FREE_SEARCH_UPDATE_PATTERN, [
      'async updatePlugin() {',
      `      // ${DSH_FREE_SEARCH_DESKTOP_UPDATE_MARKER}`,
      '      if (process.env.DSH_DESKTOP === "1") {',
      '        return {',
      '          ok: false,',
      '          code: "desktop-managed-update",',
      '          message: "请在插件市场中更新此插件；桌面端会先验证候选版本，失败时自动保留当前版本。",',
      '        };',
      '      }',
      '      const mode = detectInstallMode();',
    ].join(eol)),
  }
}

export async function ensureCandidateDshFreeSearchRuntimeCompatibility(
  candidateDir,
  physicalProfilePath,
  options = {},
) {
  const candidateRoot = resolve(candidateDir)
  const profileRoot = resolve(physicalProfilePath)
  if (!isWithin(candidateRoot, profileRoot)) throw new Error('dsh-free-search candidate profile escapes its release directory')
  const packageRoot = join(profileRoot, 'node_modules', DSH_FREE_SEARCH_PACKAGE)
  if (!isWithin(profileRoot, packageRoot)) throw new Error('dsh-free-search compatibility package escapes its profile')

  try {
    const [details, packageRealPath] = await Promise.all([lstat(packageRoot), realpath(packageRoot)])
    if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isDirectory()) {
      throw new Error('dsh-free-search compatibility package is not a regular directory')
    }
    if (!isWithin(candidateRoot, packageRealPath)) throw new Error('dsh-free-search compatibility package escapes its release')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({ packageName: DSH_FREE_SEARCH_PACKAGE, required: true, state: 'absent', targets: Object.freeze([]) })
    }
    throw error
  }

  const packageJsonPath = join(packageRoot, 'package.json')
  const targetPath = join(packageRoot, 'lib', 'index.js')
  let version
  try {
    version = JSON.parse(await readFile(packageJsonPath, 'utf8'))?.version
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const target = (options.targets ?? DSH_FREE_SEARCH_COMPATIBILITY_TARGETS)?.[version]
  if (target === undefined && options.targets === undefined) {
    // New releases are accepted by capability rather than by another version
    // table entry: if the plugin still exposes the audited update hook, apply
    // the same Desktop-managed guard and verify the resulting source shape.
    // An unrelated future layout remains unrecognized and is rejected inside
    // the disposable candidate, preserving the active release.
    try {
      const [details, targetRealPath, source] = await Promise.all([
        lstat(targetPath),
        realpath(targetPath),
        readFile(targetPath, 'utf8'),
      ])
      if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isFile()) {
        throw new Error('dsh-free-search future compatibility target is not a regular file')
      }
      if (!isWithin(candidateRoot, targetRealPath) || !isWithin(packageRoot, targetRealPath)) {
        throw new Error('dsh-free-search future compatibility target escapes its release')
      }
      if (source.includes(DSH_FREE_SEARCH_DESKTOP_UPDATE_MARKER)) {
        return Object.freeze({
          packageName: DSH_FREE_SEARCH_PACKAGE,
          required: true,
          version: typeof version === 'string' ? version : null,
          state: 'compatible',
          targets: Object.freeze([{ id: 'desktop-managed-update', state: 'compatible-upstream', path: targetPath }]),
        })
      }
      const patched = patchDshFreeSearchDesktopUpdate(source)
      if (patched.state !== 'patched') {
        return Object.freeze({
          packageName: DSH_FREE_SEARCH_PACKAGE,
          required: true,
          version: typeof version === 'string' ? version : null,
          state: 'unrecognized',
          targets: Object.freeze([{ id: 'desktop-managed-update', state: 'unrecognized', path: targetPath }]),
        })
      }
      if (options.write !== false) await writeTextAtomic(targetPath, patched.source)
      return Object.freeze({
        packageName: DSH_FREE_SEARCH_PACKAGE,
        required: true,
        version: typeof version === 'string' ? version : null,
        state: 'patched',
        targets: Object.freeze([{ id: 'desktop-managed-update', state: 'patched', path: targetPath }]),
      })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return Object.freeze({
        packageName: DSH_FREE_SEARCH_PACKAGE,
        required: true,
        version: typeof version === 'string' ? version : null,
        state: 'unrecognized',
        targets: Object.freeze([{ id: 'desktop-managed-update', state: 'unrecognized', path: targetPath }]),
      })
    }
  }
  if (target === undefined || typeof target.upstreamSha256 !== 'string' || typeof target.patchedSha256 !== 'string') {
    return Object.freeze({
      packageName: DSH_FREE_SEARCH_PACKAGE,
      required: true,
      version: typeof version === 'string' ? version : null,
      state: 'unrecognized',
      targets: Object.freeze([]),
    })
  }

  try {
    const [details, targetRealPath, source, currentSha256] = await Promise.all([
      lstat(targetPath),
      realpath(targetPath),
      readFile(targetPath, 'utf8'),
      sha256File(targetPath),
    ])
    if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isFile()) {
      throw new Error('dsh-free-search compatibility target is not a regular file')
    }
    if (!isWithin(candidateRoot, targetRealPath) || !isWithin(packageRoot, targetRealPath)) {
      throw new Error('dsh-free-search compatibility target escapes its release')
    }
    if (currentSha256 === target.patchedSha256) {
      return Object.freeze({
        packageName: DSH_FREE_SEARCH_PACKAGE,
        required: true,
        version,
        state: 'compatible',
        targets: Object.freeze([{ id: 'desktop-managed-update', state: 'compatible', path: targetPath }]),
      })
    }
    if (currentSha256 !== target.upstreamSha256) {
      return Object.freeze({
        packageName: DSH_FREE_SEARCH_PACKAGE,
        required: true,
        version,
        state: 'unrecognized',
        targets: Object.freeze([{ id: 'desktop-managed-update', state: 'unrecognized', path: targetPath }]),
      })
    }
    const patched = patchDshFreeSearchDesktopUpdate(source)
    if (patched.state !== 'patched') {
      return Object.freeze({
        packageName: DSH_FREE_SEARCH_PACKAGE,
        required: true,
        version,
        state: 'unrecognized',
        targets: Object.freeze([{ id: 'desktop-managed-update', state: 'unrecognized', path: targetPath }]),
      })
    }
    const patchedSha256 = createHash('sha256').update(patched.source).digest('hex')
    if (patchedSha256 !== target.patchedSha256) {
      throw new Error('dsh-free-search compatibility output failed its audited integrity check')
    }
    if (options.write !== false) await writeTextAtomic(targetPath, patched.source)
    return Object.freeze({
      packageName: DSH_FREE_SEARCH_PACKAGE,
      required: true,
      version,
      state: 'patched',
      targets: Object.freeze([{ id: 'desktop-managed-update', state: 'patched', path: targetPath, patchedSha256 }]),
    })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return Object.freeze({
      packageName: DSH_FREE_SEARCH_PACKAGE,
      required: true,
      version,
      state: 'unrecognized',
      targets: Object.freeze([{ id: 'desktop-managed-update', state: 'unrecognized', path: targetPath }]),
    })
  }
}

export function patchDshAgyLinkWindowsCredential(source, compatibilityAsset) {
  if (typeof source !== 'string' || typeof compatibilityAsset !== 'string') {
    return { state: 'unrecognized', source }
  }
  if (source.includes(DSH_AGY_LINK_WINDOWS_CREDENTIAL_MARKER)) return { state: 'compatible', source }
  const readerMatches = [...source.matchAll(DSH_AGY_LINK_READER_PATTERN)]
  const insertionMatches = source.split(DSH_AGY_LINK_INSERTION_MARKER).length - 1
  if (readerMatches.length !== 1 || insertionMatches !== 1 || !compatibilityAsset.includes(DSH_AGY_LINK_WINDOWS_CREDENTIAL_MARKER)) {
    return { state: 'unrecognized', source }
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const asset = compatibilityAsset.replaceAll('\r\n', '\n').replaceAll('\n', eol).trimEnd()
  return {
    state: 'patched',
    source: source
      .replace(DSH_AGY_LINK_INSERTION_MARKER, `${asset}${eol}${eol}${DSH_AGY_LINK_INSERTION_MARKER}`)
      .replace(DSH_AGY_LINK_READER_PATTERN, [
        'readSystemKeychainToken() {',
        '\t\treturn process.platform === "win32" ? readWindowsCredentialToken() : readMacKeychainToken();',
        '\t}',
      ].join(eol)),
  }
}

export function upgradeLegacyDshAgyLinkWindowsCredential(source, compatibilityAsset) {
  if (typeof source !== 'string' || typeof compatibilityAsset !== 'string') {
    return { state: 'unrecognized', source }
  }
  const blockMarker = 'const DSH_DESKTOP_WINDOWS_CREDENTIAL_COMPAT'
  const blockMarkerMatches = source.split(blockMarker).length - 1
  const insertionMatches = source.split(DSH_AGY_LINK_INSERTION_MARKER).length - 1
  if (
    blockMarkerMatches !== 1
    || insertionMatches !== 1
    || !source.includes('using System.Runtime.InteropServices.ComTypes;')
    || !source.includes('public FILETIME LastWritten;')
    || !source.includes('"-Command"')
    || !compatibilityAsset.includes(DSH_AGY_LINK_WINDOWS_CREDENTIAL_MARKER)
  ) {
    return { state: 'unrecognized', source }
  }
  const blockStart = source.lastIndexOf(blockMarker, source.indexOf(DSH_AGY_LINK_INSERTION_MARKER))
  const blockEnd = source.indexOf(DSH_AGY_LINK_INSERTION_MARKER, blockStart)
  if (blockStart < 0 || blockEnd <= blockStart) return { state: 'unrecognized', source }
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const asset = compatibilityAsset.replaceAll('\r\n', '\n').replaceAll('\n', eol).trimEnd()
  return {
    state: 'patched',
    source: `${source.slice(0, blockStart)}${asset}${eol}${eol}${source.slice(blockEnd)}`,
  }
}

/**
 * agy stores its primary Windows OAuth credential in Credential Manager under
 * gemini:antigravity. dsh-agy-link 0.4.22-0.4.24 read the equivalent macOS
 * Keychain slot but omit Windows, leaving quota cards blank despite a valid
 * login. Patch only audited package bytes inside the disposable candidate.
 */
export async function ensureCandidateDshAgyLinkRuntimeCompatibility(
  candidateDir,
  physicalProfilePath,
  repositoryRoot,
  options = {},
) {
  const candidateRoot = resolve(candidateDir)
  const profileRoot = resolve(physicalProfilePath)
  if (!isWithin(candidateRoot, profileRoot)) throw new Error('dsh-agy-link candidate profile escapes its release directory')
  const packageRoot = join(profileRoot, 'node_modules', DSH_AGY_LINK_PACKAGE)
  if (!isWithin(profileRoot, packageRoot)) throw new Error('dsh-agy-link compatibility package escapes its profile')

  try {
    const [details, packageRealPath] = await Promise.all([lstat(packageRoot), realpath(packageRoot)])
    if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isDirectory()) {
      throw new Error('dsh-agy-link compatibility package is not a regular directory')
    }
    if (!isWithin(candidateRoot, packageRealPath)) throw new Error('dsh-agy-link compatibility package escapes its release')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({ packageName: DSH_AGY_LINK_PACKAGE, required: true, state: 'absent', targets: Object.freeze([]) })
    }
    throw error
  }

  const packageJsonPath = join(packageRoot, 'package.json')
  const targetPath = join(packageRoot, 'dist', 'index.js')
  const assetPath = options.assetPath ?? join(repositoryRoot, 'src', 'plugins', 'dsh-agy-link-desktop-compat', 'windows-credential.js.txt')
  if (!isWithin(packageRoot, targetPath)) throw new Error('dsh-agy-link compatibility target escapes its package')
  let version
  try {
    version = JSON.parse(await readFile(packageJsonPath, 'utf8'))?.version
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const compatibilityTargets = options.targets ?? DSH_AGY_LINK_COMPATIBILITY_TARGETS
  const target = compatibilityTargets?.[version]
  if (target === undefined || typeof target.upstreamSha256 !== 'string' || typeof target.patchedSha256 !== 'string') {
    return Object.freeze({
      packageName: DSH_AGY_LINK_PACKAGE,
      required: true,
      version: typeof version === 'string' ? version : null,
      state: 'unrecognized',
      targets: Object.freeze([]),
    })
  }

  try {
    const [targetDetails, targetRealPath, assetDetails, assetRealPath, source, compatibilityAsset, currentSha256, assetSha256] = await Promise.all([
      lstat(targetPath),
      realpath(targetPath),
      lstat(assetPath),
      realpath(assetPath),
      readFile(targetPath, 'utf8'),
      readFile(assetPath, 'utf8'),
      sha256File(targetPath),
      sha256File(assetPath),
    ])
    if (targetDetails.isSymbolicLink?.() === true || targetDetails.isReparsePoint?.() === true || !targetDetails.isFile()) {
      throw new Error('dsh-agy-link compatibility target is not a regular file')
    }
    if (assetDetails.isSymbolicLink?.() === true || assetDetails.isReparsePoint?.() === true || !assetDetails.isFile()) {
      throw new Error('dsh-agy-link compatibility asset is not a regular file')
    }
    if (!isWithin(candidateRoot, targetRealPath) || !isWithin(packageRoot, targetRealPath)) {
      throw new Error('dsh-agy-link compatibility target escapes its release')
    }
    const assetRoot = resolve(options.assetRoot ?? join(repositoryRoot, 'src', 'plugins', 'dsh-agy-link-desktop-compat'))
    if (!isWithin(assetRoot, assetRealPath)) throw new Error('dsh-agy-link compatibility asset escapes its bundle')
    if (assetSha256 !== (options.assetSha256 ?? DSH_AGY_LINK_COMPATIBILITY_ASSET_SHA256)) {
      throw new Error('dsh-agy-link compatibility asset failed its bundled integrity check')
    }
    if (target.patchedSha256 !== '' && currentSha256 === target.patchedSha256) {
      return Object.freeze({
        packageName: DSH_AGY_LINK_PACKAGE,
        required: true,
        version,
        state: 'compatible',
        targets: Object.freeze([{ id: 'windows-credential-manager', state: 'compatible', path: targetPath }]),
      })
    }
    const isLegacyPatched = typeof target.legacyPatchedSha256 === 'string'
      && currentSha256 === target.legacyPatchedSha256
    if (!isLegacyPatched && currentSha256 !== target.upstreamSha256) {
      return Object.freeze({
        packageName: DSH_AGY_LINK_PACKAGE,
        required: true,
        version,
        state: 'unrecognized',
        targets: Object.freeze([{ id: 'windows-credential-manager', state: 'unrecognized', path: targetPath }]),
      })
    }

    const patched = isLegacyPatched
      ? upgradeLegacyDshAgyLinkWindowsCredential(source, compatibilityAsset)
      : patchDshAgyLinkWindowsCredential(source, compatibilityAsset)
    if (patched.state !== 'patched') {
      return Object.freeze({
        packageName: DSH_AGY_LINK_PACKAGE,
        required: true,
        version,
        state: 'unrecognized',
        targets: Object.freeze([{ id: 'windows-credential-manager', state: 'unrecognized', path: targetPath }]),
      })
    }
    const patchedSha256 = createHash('sha256').update(patched.source).digest('hex')
    if (target.patchedSha256 !== '' && patchedSha256 !== target.patchedSha256) {
      throw new Error('dsh-agy-link compatibility output failed its audited integrity check')
    }
    if (options.write !== false) await writeTextAtomic(targetPath, patched.source)
    return Object.freeze({
      packageName: DSH_AGY_LINK_PACKAGE,
      required: true,
      version,
      state: 'patched',
      targets: Object.freeze([{ id: 'windows-credential-manager', state: 'patched', path: targetPath, patchedSha256 }]),
    })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return Object.freeze({
      packageName: DSH_AGY_LINK_PACKAGE,
      required: true,
      version,
      state: 'unrecognized',
      targets: Object.freeze([{ id: 'windows-credential-manager', state: 'unrecognized', path: targetPath }]),
    })
  }
}

/**
 * DSH Doctor's upstream launcher is written for a normal Node process. The
 * desktop host runs DSH through Electron's Node mode, so the Doctor service
 * needs a package-scoped compatibility layer for process spawning, lifecycle
 * ownership and its recovery capsule. Only the audited upstream 0.3.6 bytes
 * (or our already-patched bytes) are accepted. A future upstream layout fails
 * closed inside the disposable candidate instead of silently overwriting the
 * last-known-good desktop repair.
 */
export async function ensureCandidateDshDoctorRuntimeCompatibility(
  candidateDir,
  physicalProfilePath,
  repositoryRoot,
  options = {},
) {
  const candidateRoot = resolve(candidateDir)
  const profileRoot = resolve(physicalProfilePath)
  if (!isWithin(candidateRoot, profileRoot)) throw new Error('Candidate plugin profile escapes its release directory')
  const packageRoot = join(profileRoot, 'node_modules', '@linxin666', 'dsh-doctor')
  if (!isWithin(profileRoot, packageRoot)) throw new Error('DSH Doctor compatibility package escapes its profile')

  try {
    const [details, packageRealPath] = await Promise.all([lstat(packageRoot), realpath(packageRoot)])
    if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isDirectory()) {
      throw new Error('DSH Doctor compatibility package is not a regular directory')
    }
    if (!isWithin(candidateRoot, packageRealPath)) throw new Error('DSH Doctor compatibility package escapes its release')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({ packageName: DSH_DOCTOR_PACKAGE, required: true, state: 'absent', targets: Object.freeze([]) })
    }
    throw error
  }

  const packageJsonPath = join(packageRoot, 'package.json')
  let version
  let packageManifest
  try {
    const [details, packageJsonRealPath, rawPackage] = await Promise.all([
      lstat(packageJsonPath),
      realpath(packageJsonPath),
      readFile(packageJsonPath, 'utf8'),
    ])
    if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isFile()) {
      throw new Error('DSH Doctor package manifest is not a regular file')
    }
    if (!isWithin(packageRoot, packageJsonRealPath)) throw new Error('DSH Doctor package manifest escapes its package')
    packageManifest = JSON.parse(rawPackage)
    version = packageManifest?.version
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const defaultCompatibility = DSH_DOCTOR_COMPATIBILITY_RELEASES.find(release => release.acceptedVersions.includes(version))
  if (defaultCompatibility === undefined && options.targets === undefined) {
    // New Doctor releases advertise their DSH engine range and keep the same
    // two public entry files. Let the generic candidate runtime gate validate
    // those releases instead of requiring a new byte-hash adapter for every
    // upstream version. The legacy hash-pinned path below remains responsible
    // for older releases that need Desktop-specific process repairs.
    let candidateDshVersion
    try {
      candidateDshVersion = JSON.parse(await readFile(join(candidateRoot, 'manifest.json'), 'utf8'))?.dsh?.version
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const requiredRange = packageManifest?.dsh?.engines?.dsh
    const range = typeof requiredRange === 'string'
      ? semver.validRange(requiredRange, { includePrerelease: true })
      : null
    const engineCompatible = requiredRange === undefined
      || (typeof candidateDshVersion === 'string'
        && range !== null
        && semver.satisfies(candidateDshVersion, range, { includePrerelease: true }))
    const genericTargets = []
    for (const path of [['lib', 'cli.mjs'], ['lib', 'index.js']]) {
      const targetPath = join(packageRoot, ...path)
      try {
        const details = await lstat(targetPath)
        const targetRealPath = await realpath(targetPath)
        if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isFile()) {
          throw new Error('DSH Doctor future compatibility target is not a regular file')
        }
        if (!isWithin(candidateRoot, targetRealPath) || !isWithin(packageRoot, targetRealPath)) {
          throw new Error('DSH Doctor future compatibility target escapes its release')
        }
        genericTargets.push({ id: path.join('-'), state: 'compatible-upstream', path: targetPath })
      } catch (error) {
        if (error?.code === 'ENOENT') {
          genericTargets.length = 0
          break
        }
        throw error
      }
    }
    if (engineCompatible && genericTargets.length === 2) {
      const cliPath = join(packageRoot, 'lib', 'cli.mjs')
      const servicePatch = patchDshDoctorFutureServiceInstall(await readFile(cliPath, 'utf8'))
      if (servicePatch.state === 'unrecognized') {
        return Object.freeze({
          packageName: DSH_DOCTOR_PACKAGE,
          required: true,
          version: typeof version === 'string' ? version : null,
          state: 'unrecognized',
          targets: Object.freeze([
            ...genericTargets.map(target => Object.freeze(target)),
            Object.freeze({ id: 'cli-service-install', state: 'unrecognized', path: cliPath }),
          ]),
        })
      }
      if (servicePatch.state === 'patched' && options.write !== false) await writeTextAtomic(cliPath, servicePatch.source)
      return Object.freeze({
        packageName: DSH_DOCTOR_PACKAGE,
        required: true,
        version: typeof version === 'string' ? version : null,
        state: servicePatch.state === 'patched' ? 'patched' : 'compatible',
        targets: Object.freeze([
          ...genericTargets.map(target => Object.freeze(target)),
          Object.freeze({ id: 'cli-service-install', state: servicePatch.state, path: cliPath }),
        ]),
      })
    }
  }
  const customVersions = [options.upstreamVersion, options.patchedVersion].filter(value => typeof value === 'string')
  const acceptedVersions = options.targets === undefined
    ? defaultCompatibility?.acceptedVersions ?? []
    : customVersions
  const targets = options.targets ?? defaultCompatibility?.targets
  const assetRoot = options.assetRoot ?? (
    defaultCompatibility !== undefined && typeof repositoryRoot === 'string' && repositoryRoot.trim() !== ''
      ? join(repositoryRoot, 'src', 'plugins', 'dsh-doctor-desktop-compat', defaultCompatibility.assetDirectory)
      : undefined
  )
  if (!acceptedVersions.includes(version) || !Array.isArray(targets) || targets.length === 0 || assetRoot === undefined) {
    return Object.freeze({
      packageName: DSH_DOCTOR_PACKAGE,
      required: true,
      version: typeof version === 'string' ? version : null,
      state: 'unrecognized',
      targets: Object.freeze([]),
    })
  }

  const resolvedAssetRoot = resolve(assetRoot)
  const targetResults = []
  for (const target of targets) {
    const targetPath = join(packageRoot, ...target.path)
    const assetPath = join(resolvedAssetRoot, ...target.path)
    if (!isWithin(packageRoot, targetPath)) throw new Error('DSH Doctor compatibility target escapes its package')
    if (!isWithin(resolvedAssetRoot, assetPath)) throw new Error('DSH Doctor compatibility asset escapes its bundle')

    try {
      const [targetDetails, targetRealPath, assetDetails, assetRealPath, currentSha256, assetSha256] = await Promise.all([
        lstat(targetPath),
        realpath(targetPath),
        lstat(assetPath),
        realpath(assetPath),
        sha256File(targetPath),
        sha256File(assetPath),
      ])
      if (targetDetails.isSymbolicLink?.() === true || targetDetails.isReparsePoint?.() === true || !targetDetails.isFile()) {
        throw new Error('DSH Doctor compatibility target is not a regular file')
      }
      if (assetDetails.isSymbolicLink?.() === true || assetDetails.isReparsePoint?.() === true || !assetDetails.isFile()) {
        throw new Error('DSH Doctor compatibility asset is not a regular file')
      }
      if (!isWithin(candidateRoot, targetRealPath) || !isWithin(packageRoot, targetRealPath)) {
        throw new Error('DSH Doctor compatibility target escapes its release')
      }
      if (!isWithin(resolvedAssetRoot, assetRealPath)) throw new Error('DSH Doctor compatibility asset escapes its bundle')
      if (assetSha256 !== target.patchedSha256) {
        throw new Error(`DSH Doctor compatibility asset ${target.id} failed its bundled integrity check`)
      }
      const legacyPatchedSha256 = Array.isArray(target.legacyPatchedSha256)
        ? target.legacyPatchedSha256
        : typeof target.legacyPatchedSha256 === 'string'
          ? [target.legacyPatchedSha256]
          : []
      const state = currentSha256 === target.patchedSha256
        ? 'compatible'
        : currentSha256 === target.upstreamSha256 || legacyPatchedSha256.includes(currentSha256)
          ? 'patchable'
          : 'unrecognized'
      targetResults.push({
        id: target.id,
        state,
        path: targetPath,
        assetPath,
        currentSha256,
      })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      targetResults.push({ id: target.id, state: 'unrecognized', path: targetPath })
    }
  }

  // Preflight every target before writing any file. An unknown upstream layout
  // therefore leaves the candidate untouched and lets the normal transaction
  // retirement path preserve the active last-known-good release.
  if (targetResults.some(target => target.state === 'unrecognized')) {
    return Object.freeze({
      packageName: DSH_DOCTOR_PACKAGE,
      required: true,
      version,
      state: 'unrecognized',
      targets: Object.freeze(targetResults.map(({ assetPath: _assetPath, ...target }) => Object.freeze(target))),
    })
  }

  for (const target of targetResults) {
    if (target.state === 'patchable' && options.write !== false) await copyFileAtomicIfChanged(target.assetPath, target.path)
  }
  const state = targetResults.some(target => target.state === 'patchable') ? 'patched' : 'compatible'
  return Object.freeze({
    packageName: DSH_DOCTOR_PACKAGE,
    required: true,
    version,
    state,
    targets: Object.freeze(targetResults.map(target => Object.freeze({
      id: target.id,
      state: target.state === 'patchable' ? 'patched' : target.state,
      path: target.path,
    }))),
  })
}

export async function ensureCandidatePluginRuntimeCompatibility(candidateDir, physicalProfilePath, repositoryRoot, options = {}) {
  const adapters = [
    opts => ensureCandidateDshSettingsRuntimeCompatibility(candidateDir, physicalProfilePath, opts),
    opts => ensureCandidateBetterDshPetRuntimeCompatibility(candidateDir, physicalProfilePath, opts),
    opts => ensureCandidateDshSignalRuntimeCompatibility(candidateDir, physicalProfilePath, opts),
    opts => ensureCandidateDshPiAiOpenCodeGoRuntimeCompatibility(candidateDir, physicalProfilePath, opts),
    opts => ensureCandidateDshSttInputRuntimeCompatibility(candidateDir, physicalProfilePath, opts),
    opts => ensureCandidateDshFreeSearchRuntimeCompatibility(candidateDir, physicalProfilePath, opts),
    opts => ensureCandidateDshAgyLinkRuntimeCompatibility(candidateDir, physicalProfilePath, repositoryRoot, opts),
    opts => ensureCandidateDshDoctorRuntimeCompatibility(candidateDir, physicalProfilePath, repositoryRoot, opts),
  ]
  const checks = []
  // Audit the entire recipe before permitting writes. An unrecognized late
  // target must never leave a partially patched package in the native path.
  for (const adapter of adapters) checks.push(await adapter({ ...options, write: false }))
  if (options.write !== false) {
    for (let index = 0; index < adapters.length; index++) {
      if (checks[index].state !== 'patched') continue
      const applied = await adapters[index](options)
      if (applied.state !== 'patched' && applied.state !== 'compatible') throw new Error(`Plugin ${applied.packageName} changed during compatibility preparation`)
      checks[index] = applied
    }
  }
  return Object.freeze({ ...checks[1], checks: Object.freeze(checks) })
}

/**
 * Compose the process-owned Harness transaction and every operation that can
 * mutate its runtime/profile. The owner deliberately has no Electron import:
 * `window`, `effects`, `plugins`, and `runtime` are adapters supplied by main.
 *
 * Adapters are callback-friendly so a long-running startup transaction always
 * observes the current window/runtime state:
 *
 * - window: the createWindowHost surface
 * - effects: logging, diagnostics, state notification, and workspace context
 * - plugins: optional plugin-management implementations (all default to the
 *   production owners)
 * - runtime: app/process values plus DSH home/runtime/entry resolvers
 */
export function createDesktopRuntimeController({
  window: windowAdapter,
  windowHost,
  effects = {},
  effect,
  plugins = {},
  plugin,
  runtime = {},
  owners = {},
  modeSupervisor: suppliedModeSupervisor,
  runtimeModeSupervisor: suppliedRuntimeModeSupervisor,
  createModeSupervisor: modeSupervisorFactory,
  createRuntimeModeSupervisor: runtimeModeSupervisorFactory,
  copy = DEFAULT_COPY,
  isChinese = false,
  initialRuntime,
  initialDshRuntime,
  dshHome,
  dataRoot: configuredDataRoot,
  runtimeRoot,
  releaseStateRoot: configuredReleaseStateRoot,
  snapshotRoot: configuredSnapshotRoot,
  snapshotExcludedRelativePaths: configuredSnapshotExcludedRelativePaths,
  releaseStateStore: suppliedReleaseStateStore,
  releaseOwnership: suppliedReleaseOwnership,
  snapshotStore: suppliedSnapshotStore,
  releaseSwitcher: suppliedReleaseSwitcher,
  env,
  app,
  process: processAdapter = process,
  dialog,
  net,
  shell,
  createLifecycleOwner = createHarnessLifecycleOwner,
  createReadinessOwner = createWorkspaceReadinessOwner,
  createCoordinator = createOperationCoordinator,
  createInstallerUpdate = createInstallerUpdateController,
  createDshUpdate = createDshUpdateController,
  createServer = options => new HarnessServer(options),
  createHarnessLifecycleOwner: lifecycleOwnerFactory,
  createWorkspaceReadinessOwner: readinessOwnerFactory,
  createOperationCoordinator: operationCoordinatorFactory,
  createInstallerUpdateController: installerUpdateFactory,
  createDshUpdateController: dshUpdateFactory,
  createCandidateBuilder: candidateBuilderFactory,
  createReleaseStateStore: releaseStateStoreFactory,
  createSnapshotStore: snapshotStoreFactory,
  createReleaseSwitcher: releaseSwitcherFactory,
  pluginTransactionService: suppliedPluginTransactionService,
  createPluginTransaction: pluginTransactionFactory,
  createHarnessServer: harnessServerFactory,
  observeRelease: suppliedObserveRelease,
  observeDuration: suppliedObserveDuration,
  observePollInterval: suppliedObservePollInterval,
  releaseNow: suppliedReleaseNow,
  now = () => (globalThis.performance?.now?.() ?? Date.now()),
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  const windows = windowAdapter ?? windowHost
  const ownerAdapters = owners ?? {}
  const serverFactory = harnessServerFactory ?? ownerAdapters.createServer ?? ownerAdapters.HarnessServer ?? createServer
  const lifecycleFactory = lifecycleOwnerFactory ?? ownerAdapters.createLifecycleOwner ?? ownerAdapters.createHarnessLifecycleOwner ?? createLifecycleOwner
  const readinessFactory = readinessOwnerFactory ?? ownerAdapters.createReadinessOwner ?? ownerAdapters.createWorkspaceReadinessOwner ?? createReadinessOwner
  const coordinatorFactory = operationCoordinatorFactory ?? ownerAdapters.createCoordinator ?? ownerAdapters.createOperationCoordinator ?? createCoordinator
  const installerFactory = installerUpdateFactory ?? ownerAdapters.createInstallerUpdate ?? ownerAdapters.createInstallerUpdateController ?? createInstallerUpdate
  const dshFactory = dshUpdateFactory ?? ownerAdapters.createDshUpdate ?? ownerAdapters.createDshUpdateController ?? createDshUpdate
  const candidateFactory = candidateBuilderFactory ?? ownerAdapters.createCandidateBuilder ?? createCandidateBuilder
  // The profile-preserving DSH update path below is an integration owned by
  // the production candidate builder. Test owners and embedding integrations
  // intentionally provide their own candidate contract; do not run the
  // production-only disk reconciliation against those fakes.
  const usesBuiltInCandidateBuilder = candidateBuilderFactory === undefined
    && ownerAdapters.createCandidateBuilder === undefined
  const compatibilityRecipeApplier = ownerAdapters.applyCompatibilityRecipe ?? applyCompatibilityRecipe
  const pluginRuntimeCompatibilityEnsurer = ownerAdapters.ensureCandidatePluginRuntimeCompatibility
    ?? ensureCandidatePluginRuntimeCompatibility
  const runtimeInventoryCreator = ownerAdapters.createRuntimeInventory ?? createRuntimeInventory
  const stateFactory = releaseStateStoreFactory ?? ownerAdapters.createReleaseStateStore ?? (root => new ReleaseStateStore(root))
  const snapshotFactory = snapshotStoreFactory ?? ownerAdapters.createSnapshotStore ?? ((options, root) => new SnapshotStore(options, root))
  const switcherFactory = releaseSwitcherFactory ?? ownerAdapters.createReleaseSwitcher ?? createReleaseSwitcher
  const transactionFactory = pluginTransactionFactory ?? ownerAdapters.createPluginTransaction ?? createPluginTransactionService
  const releaseOwnership = suppliedReleaseOwnership ?? ownerAdapters.releaseOwnership
  if (windows === undefined || typeof windows.getWindow !== 'function') throw new TypeError('Invalid desktop window adapter')
  if (typeof serverFactory !== 'function') throw new TypeError('Invalid Harness server factory')
  if (typeof lifecycleFactory !== 'function') throw new TypeError('Invalid Harness lifecycle factory')
  if (typeof readinessFactory !== 'function') throw new TypeError('Invalid workspace readiness factory')
  if (typeof coordinatorFactory !== 'function') throw new TypeError('Invalid operation coordinator factory')
  if (typeof installerFactory !== 'function') throw new TypeError('Invalid installer update factory')
  if (typeof dshFactory !== 'function') throw new TypeError('Invalid DSH update factory')
  if (typeof candidateFactory !== 'function') throw new TypeError('Invalid candidate builder factory')
  if (typeof pluginRuntimeCompatibilityEnsurer !== 'function') throw new TypeError('Invalid plugin compatibility adapter')
  if (releaseOwnership !== undefined && (releaseOwnership === null || typeof releaseOwnership.release !== 'function')) {
    throw new TypeError('Invalid release ownership lease')
  }
  if (typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function') throw new TypeError('Invalid timer adapters')

  const effectAdapters = effect ?? effects ?? {}
  const notify = asFunction(effectAdapters.notify ?? effectAdapters.onStateChange)
  const writeLogAdapter = asFunction(effectAdapters.writeLog ?? effectAdapters.log)
  const writeLog = (source, text) => writeLogAdapter(source, diagnosticLogText(text))
  const pluginCompatibilityWarnings = new Map()
  function nativePluginPolicy(report, releaseId) {
    const resolved = resolvePluginCompatibilityPolicy(report)
    for (const check of resolved.checks) {
      if (check.state !== 'native') pluginCompatibilityWarnings.delete(`${releaseId}:${check.packageName}`)
    }
    for (const warning of resolved.warnings) {
      const key = `${releaseId}:${warning.packageName}`
      if (pluginCompatibilityWarnings.get(key)?.version !== warning.version) {
        writeLog('desktop', `[plugin-native] ${warning.message}\n`)
      }
      pluginCompatibilityWarnings.set(key, { ...warning, releaseId })
      if (pluginCompatibilityWarnings.size > 512) pluginCompatibilityWarnings.delete(pluginCompatibilityWarnings.keys().next().value)
    }
    return resolved
  }
  const reportDetachedFailure = asFunction(effectAdapters.reportDetachedFailure, (label, error) => writeLog('stderr', `${label} failed: ${errorDetail(error)}\n`))
  const clearWorkspaceContext = asFunction(effectAdapters.clearWorkspaceContext)
  const getLogPath = asFunction(effectAdapters.getLogPath, () => undefined)
  const getLanguage = asFunction(effectAdapters.getLanguage, () => isChinese ? 'zh' : 'en')
  const getThemePreference = asFunction(effectAdapters.getThemePreference, () => 'system')
  const preserveLoadingSurface = asFunction(effectAdapters.preserveLoadingSurface, () => false)
  const showDialog = effectAdapters.showDialog ?? dialog
  const getApp = runtime.app ?? app
  const getProcess = runtime.process ?? processAdapter
  const runtimeEnvironment = resolveAdapter(runtime.env, env ?? getProcess.env)
  const doctorOwnerPid = Number.isSafeInteger(Number(getProcess?.pid)) && Number(getProcess.pid) > 0
    ? Number(getProcess.pid)
    : process.pid
  const doctorOwnerStartedAt = (() => {
    const uptime = typeof getProcess?.uptime === 'function' ? Number(getProcess.uptime()) : Number(process.uptime())
    return Number.isFinite(uptime) && uptime >= 0
      ? Math.max(0, Math.floor(Date.now() - uptime * 1000))
      : undefined
  })()
  const activeHome = resolveAdapter(runtime.dshHome, dshHome)
  const activeRoot = resolveAdapter(runtime.runtimeRoot, runtimeRoot)
  const repositoryRoot = resolveAdapter(runtime.repositoryRoot, getApp?.getAppPath?.())
  const desktopReleaseSource = resolveAdapter(
    runtime.desktopReleaseSource ?? runtime.desktopReleaseRepository,
    undefined,
  )
  const hiddenChildProcess = resolveAdapter(
    runtime.hiddenChildProcess,
    repositoryRoot === undefined ? undefined : join(repositoryRoot, 'src', 'runtime', 'windows-hidden-child-process.cjs'),
  )
  const candidateRoot = resolveAdapter(runtime.candidateRoot, activeRoot === undefined ? undefined : join(activeRoot, 'candidates'))
  let managedDataRecoveryPending = activeRoot !== undefined && existsSync(join(activeRoot, 'data-home.journal.json'))
  let managedDataHome
  try {
    managedDataHome = activeRoot === undefined ? undefined : readManagedDataHome(activeRoot)?.dataHome
  } catch (error) {
    if (!managedDataRecoveryPending || error?.code !== 'MANAGED_DATA_TRANSACTION_PENDING') throw error
    // Keep the control center available; recovery runs under the operation
    // owner before any program or snapshot owner can use a data directory.
  }
  let dataHomeWasMigrated = false
  let dataRoot = resolveAdapter(runtime.dataRoot, configuredDataRoot ?? managedDataHome ?? activeHome)
  const releaseStateRoot = resolveAdapter(
    runtime.releaseStateRoot,
    configuredReleaseStateRoot ?? (activeRoot === undefined ? undefined : join(activeRoot, 'release-state')),
  )
  let snapshotRoot = resolveAdapter(
    runtime.snapshotRoot,
    configuredSnapshotRoot ?? (dataRoot === undefined ? undefined : defaultDesktopSnapshotRoot(dataRoot)),
  )
  let snapshotExcludedRelativePaths = resolveAdapter(
    runtime.snapshotExcludedRelativePaths,
    configuredSnapshotExcludedRelativePaths
      ?? (dataRoot === undefined ? [] : defaultDesktopSnapshotExclusions(dataRoot, activeRoot)),
  )
  if (managedDataHome !== undefined) snapshotExcludedRelativePaths = [...new Set([...snapshotExcludedRelativePaths, 'profiles'])]
  const activeInitialRuntime = resolveAdapter(runtime.initialRuntime, initialDshRuntime ?? initialRuntime)
  const configuredStableMode = runtime.stableConfig ?? runtime.stable ?? runtime.modeRecipes?.stable
  const configuredDevMode = runtime.devConfig ?? runtime.dev ?? runtime.modeRecipes?.dev
  const resolvePnpm = asResolver(runtime.resolvePnpmEntry)
  const resolveDsh = asResolver(runtime.resolveDshEntry, active => active?.entry)
  const resolveParentWatch = asResolver(runtime.resolveParentWatch, () => join(import.meta.dirname, 'parent-watch.cjs'))
  const resolveHarnessPatch = asResolver(runtime.resolveHarnessPatch, () => join(import.meta.dirname, 'dsh-desktop.patch.yml'))
  const withDesktopHarnessPatch = (mode, recipe) => {
    if ((mode !== 'stable' && mode !== 'dev')
      || recipe === undefined
      || recipe === null
      || typeof recipe !== 'object'
      || typeof recipe.start === 'function') return recipe

    // Candidate recipes are immutable release data and intentionally do not
    // carry machine-specific PATH values. Inject the desktop-owned toolchain as
    // the trusted base at the activation boundary so Stable/Dev children use
    // the same Node and pnpm versions as candidate preparation.
    const desktopRecipe = { ...recipe, trustedBaseEnv: runtimeEnvironment }
    if (mode !== 'stable') return Object.freeze(desktopRecipe)

    const patchPath = resolveHarnessPatch()
    if (typeof patchPath !== 'string' || patchPath.length === 0 || !isAbsolute(patchPath)) {
      throw new Error('Managed Harness desktop patch path is unavailable')
    }
    const inheritedPatches = Array.isArray(recipe.patches)
      ? recipe.patches
      : (typeof recipe.patch === 'string' ? [recipe.patch] : [])
    const patches = inheritedPatches.includes(patchPath)
      ? [...inheritedPatches]
      : [...inheritedPatches, patchPath]
    return Object.freeze({ ...desktopRecipe, patches })
  }
  const pluginAllowedRoots = resolveAdapter(runtime.pluginAllowedRoots, repositoryRoot === undefined ? [] : [repositoryRoot])
  const bundledPnpmEntry = () => resolvePnpm()
  const getDownloadsDirectory = asResolver(runtime.getDownloadsDirectory, () => getApp?.getPath?.('downloads'))
  const getHomeDirectory = asResolver(runtime.getHomeDirectory, () => getApp?.getPath?.('home'))
  const appVersion = asResolver(runtime.getVersion, () => getApp?.getVersion?.() ?? '0.0.0')
  const isPackaged = asResolver(runtime.isPackaged, () => getApp?.isPackaged === true)
  const observeDuration = runtime.observeDuration ?? suppliedObserveDuration ?? DEFAULT_OBSERVE_DURATION
  const observePollInterval = runtime.observePollInterval ?? suppliedObservePollInterval ?? 100
  const releaseNow = asResolver(runtime.releaseNow, suppliedReleaseNow ?? (() => new Date()))
  const observeReleaseAdapter = runtime.observeRelease ?? suppliedObserveRelease
  const runDoctorServiceCommandAdapter = asFunction(
    runtime.runDoctorServiceCommand ?? ownerAdapters.runDoctorServiceCommand,
    request => runOwnedCommand(request),
  )
  const notifyState = () => {
    try { notify() } catch (error) { reportDetachedFailure('Desktop runtime status', error) }
  }

  function waitForDoctorService(delayMs, signal) {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    return new Promise((resolvePromise, rejectPromise) => {
      let timer
      const onAbort = () => {
        if (timer !== undefined) clearTimeoutImpl(timer)
        signal?.removeEventListener?.('abort', onAbort)
        rejectPromise(abortReason(signal))
      }
      timer = setTimeoutImpl(() => {
        signal?.removeEventListener?.('abort', onAbort)
        resolvePromise()
      }, delayMs)
      signal?.addEventListener?.('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  async function runDoctorServiceCli({ executable, cliPath, candidateRoot: doctorCandidateRoot, command, cwd, dshEntry, dshHome, signal, timeoutMs }) {
    const scope = doctorCleanupScope({
      candidateRoot: doctorCandidateRoot,
      cliPath,
      ownerPid: doctorOwnerPid,
      ownerStartedAt: doctorOwnerStartedAt,
    })
    const environment = {
      ...runtimeEnvironment,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_DESKTOP: '1',
      DSH_DOCTOR_REAL_DSH: dshEntry,
      DSH_DOCTOR_DSH_SCRIPT: dshEntry,
      ...(dshHome === undefined ? {} : { DSH_HOME: dshHome }),
      ...(scope?.environment ?? {}),
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    }
    return runDoctorServiceCommandAdapter({
      command: executable,
      args: [cliPath, command],
      cwd,
      env: environment,
      signal,
      platform: getProcess.platform,
      ...(typeof getProcess.kill === 'function' ? { processKill: getProcess.kill.bind(getProcess) } : {}),
      taskkillPath: runtime.taskkillPath,
      terminationTimeoutMs: 5_000,
      timeoutMs,
      windowsHide: true,
      shell: false,
      outputLabel: `DSH Doctor ${command}`,
      errorForSpawn: error => new Error(`Unable to start DSH Doctor ${command}`, { cause: error }),
      errorForExit: (code, exitSignal) => `DSH Doctor ${command} exited with code ${String(code)} and signal ${String(exitSignal)}`,
    })
  }

  async function stopManagedDoctorSupervisors({ executable, cliPath, candidateRoot: doctorCandidateRoot, cwd, signal } = {}) {
    const scope = doctorCleanupScope({
      candidateRoot: doctorCandidateRoot,
      cliPath,
      ownerPid: doctorOwnerPid,
      ownerStartedAt: doctorOwnerStartedAt,
    })
    if (scope === undefined) return Object.freeze({ status: 'skipped', reason: 'scope-unavailable' })
    const cleanupEnvironment = { ...runtimeEnvironment, ...scope.environment }
    if (typeof runtime.stopDoctorSupervisors === 'function') {
      return runtime.stopDoctorSupervisors({
        executable,
        cliPath,
        candidateRoot: scope.candidateRoot,
        ownerPid: scope.ownerPid,
        ownerStartedAt: scope.ownerStartedAt,
        cwd,
        env: cleanupEnvironment,
        signal,
      })
    }
    if (getProcess.platform !== 'win32') return Object.freeze({ status: 'skipped', reason: 'unsupported-runtime' })
    if (typeof executable !== 'string' || !isAbsolute(executable)) throw new Error('DSH Doctor supervisor executable is unavailable')
    const configuredPowerShell = runtime.powershellPath ?? runtime.windowsPowerShellPath
    const systemRoot = Object.entries(runtimeEnvironment ?? {})
      .find(([key, value]) => key.toLowerCase() === 'systemroot' && typeof value === 'string' && value.trim() !== '')?.[1]
      ?? process.env.SystemRoot
    const powershellPath = typeof configuredPowerShell === 'string' && isAbsolute(configuredPowerShell)
      ? configuredPowerShell
      : typeof systemRoot === 'string' && isAbsolute(systemRoot)
        ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : undefined
    if (powershellPath === undefined) throw new Error('Trusted Windows PowerShell path is unavailable')
    const cleanupCommand = buildWindowsDoctorSupervisorCleanupCommand(executable, powershellPath, scope)
    if (cleanupCommand === undefined) return Object.freeze({ status: 'skipped', reason: 'scope-unavailable' })
    const result = await runOwnedCommand({
      ...cleanupCommand,
      cwd,
      env: cleanupEnvironment,
      signal,
      platform: getProcess.platform,
      ...(typeof getProcess.kill === 'function' ? { processKill: getProcess.kill.bind(getProcess) } : {}),
      taskkillPath: runtime.taskkillPath,
      terminationTimeoutMs: 5_000,
      timeoutMs: 15_000,
      windowsHide: true,
      shell: false,
      onOutput: (source, text) => writeLog(source, text),
      outputLabel: 'DSH Doctor stale supervisor cleanup',
      errorForSpawn: error => new Error('Unable to clean up stale DSH Doctor supervisors', { cause: error }),
      errorForExit: (code, exitSignal) => `DSH Doctor supervisor cleanup exited with code ${String(code)} and signal ${String(exitSignal)}`,
    })
    const statusMatch = String(result?.stdout ?? '').match(/DSH_DOCTOR_CLEANUP_STATUS=(skipped|stopped);count=(\d+)/u)
    if (statusMatch === null) {
      writeLog('stderr', '[plugin-compatibility] DSH Doctor stale supervisor cleanup returned no verifiable match count.\n')
      return Object.freeze({ status: 'unverified', reason: 'cleanup-status-unavailable' })
    }
    const matched = Number(statusMatch[2])
    if (!Number.isSafeInteger(matched)) {
      writeLog('stderr', '[plugin-compatibility] DSH Doctor stale supervisor cleanup returned an invalid match count.\n')
      return Object.freeze({ status: 'unverified', reason: 'cleanup-status-invalid' })
    }
    return Object.freeze({
      status: statusMatch[1] === 'stopped' && matched > 0 ? 'stopped' : 'skipped',
      matched,
      ...(matched === 0 ? { reason: 'no-matching-supervisor' } : {}),
    })
  }

  /**
   * Re-home Doctor only after the exact immutable profile has started. Plugin
   * candidates are copied to new directories, so a detached supervisor from a
   * temporary/runtime-gate candidate otherwise keeps serving the shared pipe
   * from obsolete bytes. The audited Doctor CLI owns the process-scoped cleanup
   * and hidden relaunch; a failed status handshake aborts the release switch so
   * the normal last-known-good rollback can re-home the previous candidate.
   */
  async function reconcileManagedDoctorService(recipe, { signal, forceReinstall = false } = {}) {
    if (getProcess.platform !== 'win32' || recipe?.mode !== 'stable') {
      return Object.freeze({ status: 'skipped', reason: 'unsupported-runtime' })
    }
    if (signal?.aborted) throw abortReason(signal)
    const candidateValue = recipe.profileHome
    const profileValue = recipe.profilePath
    const entryValue = recipe.entry
    if (![candidateValue, profileValue, entryValue].every(value => (
      typeof value === 'string' && value.trim() !== '' && isAbsolute(value)
    ))) {
      throw new Error('DSH Doctor service paths are unavailable')
    }
    const candidateDir = resolve(candidateValue)
    const profilePath = resolve(profileValue)
    const dshEntry = resolve(entryValue)
    if (profilePath === candidateDir || dshEntry === candidateDir
      || !isWithin(candidateDir, profilePath) || !isWithin(candidateDir, dshEntry)) {
      throw new Error('DSH Doctor service paths escape the managed release')
    }

    const packageRoot = join(profilePath, 'node_modules', '@linxin666', 'dsh-doctor')
    try {
      const details = await lstat(packageRoot)
      if (details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true || !details.isDirectory()) {
        throw new Error('DSH Doctor service package is not a regular directory')
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ status: 'skipped', reason: 'plugin-absent' })
      throw error
    }

    const compatibility = await ensureCandidateDshDoctorRuntimeCompatibility(candidateDir, profilePath, repositoryRoot, { write: false })
    if (compatibility.state !== 'compatible' && compatibility.state !== 'patched') {
      nativePluginPolicy({ checks: [compatibility] }, recipe.releaseId)
      return Object.freeze({ status: 'native', reason: 'service-integration-not-applicable' })
    }
    const cliPath = join(packageRoot, 'lib', 'cli.mjs')
    const packageJsonPath = join(packageRoot, 'package.json')
    const [packageRealPath, cliDetails, cliRealPath, packageJson] = await Promise.all([
      realpath(packageRoot),
      lstat(cliPath),
      realpath(cliPath),
      readFile(packageJsonPath, 'utf8').then(value => JSON.parse(value)),
    ])
    if (!isWithin(candidateDir, packageRealPath) || !isWithin(packageRoot, cliRealPath)
      || cliDetails.isSymbolicLink?.() === true || cliDetails.isReparsePoint?.() === true || !cliDetails.isFile()) {
      throw new Error('DSH Doctor service entry escapes the managed plugin package')
    }
    const version = packageJson?.version
    const genericCapabilityAccepted = (compatibility.state === 'compatible' || compatibility.state === 'patched')
      && typeof version === 'string'
    if (typeof version !== 'string'
      || (!DSH_DOCTOR_COMPATIBILITY_RELEASES.some(item => item.acceptedVersions.includes(version)) && !genericCapabilityAccepted)) {
      throw new Error('DSH Doctor service version is not audited for this desktop')
    }
    const executable = getProcess.execPath
    if (typeof executable !== 'string' || !isAbsolute(executable)) throw new Error('DSH Doctor desktop executable is unavailable')

    const readStatus = async () => {
      const result = await runDoctorServiceCli({
        executable,
        cliPath,
        candidateRoot: candidateDir,
        command: 'status',
        cwd: profilePath,
        dshEntry,
        dshHome: recipe.dataHome ?? recipe.profileHome,
        signal,
        timeoutMs: 5_000,
      })
      const status = JSON.parse(result.stdout)
      if (status?.ok !== true || status?.snapshot?.version !== version) {
        throw new Error(`DSH Doctor ${version} returned an invalid status handshake`)
      }
      return status
    }

    if (!forceReinstall) {
      try {
        const status = await readStatus()
        writeLog('desktop', `[plugin-compatibility] DSH Doctor ${version} supervisor is already ready for ${String(recipe.releaseId)}.\n`)
        return Object.freeze({ status: 'ready', version, phase: status.snapshot.phase ?? null, reinstalled: false })
      } catch (error) {
        if (signal?.aborted) throw error
        writeLog('desktop', `[plugin-compatibility] DSH Doctor ${version} needs service reconciliation: ${errorDetail(error)}\n`)
      }
    }

    await stopManagedDoctorSupervisors({ executable, cliPath, candidateRoot: candidateDir, cwd: profilePath, signal })
    await runDoctorServiceCli({
      executable,
      cliPath,
      candidateRoot: candidateDir,
      command: 'service-install',
      cwd: profilePath,
      dshEntry,
      dshHome: recipe.dataHome ?? recipe.profileHome,
      signal,
      timeoutMs: 45_000,
    })

    let lastError
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (attempt > 0) await waitForDoctorService(250, signal)
      try {
        const status = await readStatus()
        writeLog('desktop', `[plugin-compatibility] Reconciled DSH Doctor ${version} supervisor for ${String(recipe.releaseId)}.\n`)
        return Object.freeze({ status: 'ready', version, phase: status.snapshot.phase ?? null, reinstalled: true })
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(`DSH Doctor ${version} supervisor did not become ready`, { cause: lastError })
  }

  const createMode = runtimeModeSupervisorFactory
    ?? modeSupervisorFactory
    ?? ownerAdapters.createRuntimeModeSupervisor
    ?? ownerAdapters.createModeSupervisor
    ?? createModeSupervisor
  if (typeof createMode !== 'function') throw new TypeError('Invalid runtime mode supervisor factory')
  const modeSupervisor = suppliedRuntimeModeSupervisor
    ?? suppliedModeSupervisor
    ?? createMode({
      stable: configuredStableMode,
      dev: configuredDevMode,
      stableConfig: configuredStableMode,
      devConfig: configuredDevMode,
      createStable: runtime.createStableSupervisor ?? runtime.createStable,
      createDev: runtime.createDevSupervisor ?? runtime.createDev,
      initialMode: 'legacy',
      onStatus: notifyState,
    })
  if (modeSupervisor === undefined || typeof modeSupervisor.start !== 'function' || typeof modeSupervisor.stop !== 'function') {
    throw new TypeError('Invalid runtime mode supervisor')
  }
  modeSupervisor.on?.('status', notifyState)
  modeSupervisor.on?.('cleanup-error', notifyState)
  modeSupervisor.on?.('output', event => {
    const source = event?.source === 'stderr' ? 'stderr' : 'desktop'
    const text = typeof event?.text === 'string' ? event.text : ''
    if (text !== '') writeLog(source, text)
  })

  const pluginAdapters = plugin ?? plugins ?? {}
  const pluginOwners = {
    readPluginCatalog: pluginAdapters.readPluginCatalog ?? readPluginCatalog,
    loadPluginCatalog: pluginAdapters.loadPluginCatalog ?? loadPluginCatalog,
    resolveMarketSource: pluginAdapters.resolveMarketSource ?? resolveMarketSource,
  }
  const inspectMarketPluginMetadata = pluginAdapters.inspectMarketPluginMetadata ?? (async ({ name, target, signal }) => {
    const result = await (pluginAdapters.runPnpm ?? runPnpm)({
      args: ['view', `${name}@${target}`, 'version', 'dsh.engines.dsh', '--json'],
      env: runtimeEnvironment,
      execPath: getProcess.execPath,
      pnpmEntry: bundledPnpmEntry(),
      ...(hiddenChildProcess === undefined ? {} : { hiddenChildProcess }),
      profileDir: candidateRoot,
      signal,
      onOutput: (source, text) => writeLog(source, text),
    })
    const output = typeof result?.stdout === 'string'
      ? result.stdout.trim()
      : (typeof result?.output === 'string' ? result.output.trim() : '')
    let metadata
    try { metadata = JSON.parse(output) } catch (error) {
      throw new Error(`Plugin ${name}@${target} returned invalid registry compatibility metadata`, { cause: error })
    }
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.version !== target) {
      throw new Error(`Plugin ${name}@${target} registry metadata did not preserve the requested identity`)
    }
    return {
      pluginVersion: metadata.version,
      requiredRange: metadata['dsh.engines.dsh'],
    }
  })
  const legacyPluginCatalogLocation = activeHome === undefined
    ? undefined
    : Object.freeze({ dshHome: activeHome, profile: 'web' })
  let pluginCatalogLocation = legacyPluginCatalogLocation
  let quitting = false
  let server
  let harnessOrigin
  let publishedGeneration
  let activeDshRuntime = activeInitialRuntime
  let loadingProgress = 0
  let startupPhase = 'idle'
  let startupMessage = ''
  let startupError
  let pluginOperationRunning = false
  let pluginOperationController
  let installerUpdateController
  let dualUpdates
  function ensureDualUpdates() {
    dualUpdates ??= createDualUpdateManager({
      getDesktop: () => installerUpdateController,
      getDshVersion: () => activeDshRuntime?.version ?? null,
      probeDsh: options => {
        let channel = 'stable'
        const active = releaseStateStore?.readActive?.()
        if (active?.releaseId && active.releaseId !== BOOTSTRAP_RELEASE_ID && candidateRoot && RELEASE_ID_PATTERN.test(active.releaseId)) {
          const manifest = JSON.parse(readFileSync(join(candidateRoot, active.releaseId, 'manifest.json'), 'utf8'))
          if (manifest.channel === 'next') channel = 'next'
        }
        return checkDshUpdateAvailability({ ...options, channel })
      },
      isPackaged,
      notify: notifyState,
      setTimer: setTimeoutImpl, clearTimer: clearTimeoutImpl,
      updateDsh: async ({ version, channel, onProgress }) => {
        const prepared = await prepareCandidate(channel, { onProgress })
        if (!prepared?.releaseId) throw new Error('DSH 候选准备未完成')
        if (prepared.manifest?.dsh?.version !== version) throw new Error('DSH 目标版本已变化，请重新检查后选择')
        const switched = await switchCandidate(prepared.releaseId)
        if (switched?.status !== 'switched') throw new Error('DSH 切换未确认成功')
      },
    })
    return dualUpdates
  }
  let dshUpdateController
  let dshUpdateProbeResult
  let candidateBuilder
  let releaseStateStore = suppliedReleaseStateStore ?? runtime.releaseStateStore
  let snapshotStore = suppliedSnapshotStore ?? runtime.snapshotStore
  let releaseSwitcher = suppliedReleaseSwitcher ?? runtime.releaseSwitcher
  let pluginTransactionService = suppliedPluginTransactionService ?? runtime.pluginTransactionService
  let pluginTransactionInfrastructureError
  let pluginTransactionGateAvailable = suppliedPluginTransactionService !== undefined || runtime.pluginTransactionGateAvailable === true
  let pendingPluginCandidateId
  let pendingPluginParentReleaseId
  let pendingPluginManifestSha256
  let pendingPluginCandidateHydrated = false
  let releaseInfrastructureError
  let releaseOperationRunning = false
  let candidateOperationRunning = false
  let candidateResult
  let candidateState = candidateRoot === undefined || repositoryRoot === undefined ? 'unavailable' : 'idle'
  let candidateReason = candidateState === 'unavailable' ? 'Candidate preparation paths are unavailable.' : null
  let installerUpdateTimer
  let backgroundInstallerUpdateTimer
  let backgroundInstallerUpdateAbortController
  let dshUpdateTimer
  let updatesInitialized = false
  let shutdownPromise

  function managedDshRuntimeFromRelease(release) {
    const runtimeValue = release?.candidate?.runtime
    if (runtimeValue === null || typeof runtimeValue !== 'object'
      || typeof runtimeValue.version !== 'string'
      || typeof runtimeValue.integrity !== 'string'
      || typeof runtimeValue.directory !== 'string'
      || typeof runtimeValue.entry !== 'string') return undefined
    const bundled = activeInitialRuntime?.bundled ?? activeInitialRuntime
    return Object.freeze({
      source: 'managed',
      version: runtimeValue.version,
      integrity: runtimeValue.integrity,
      directory: runtimeValue.directory,
      entry: runtimeValue.entry,
      ...(bundled === undefined ? {} : { bundled }),
    })
  }

  function syncManagedDshRuntime(release) {
    const runtimeValue = managedDshRuntimeFromRelease(release)
    if (runtimeValue === undefined) return false
    activeDshRuntime = runtimeValue
    dshUpdateController?.setRuntime?.(runtimeValue)
    return true
  }
  let pluginCatalogSnapshot
  let pluginRecoveryInFlight = false
  let pluginRecoveryAttempted = false
  let activePluginRecovery
  let compatibilityRepairPromise
  let operationCoordinator
  if (pluginTransactionService === undefined) {
    pluginTransactionService = pluginAdapters.pluginTransactionService ?? pluginAdapters.transactionService
  }

  function freezeSnapshot(value, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return value
    seen.add(value)
    if (Array.isArray(value)) {
      for (const child of value) freezeSnapshot(child, seen)
    } else {
      for (const child of Object.values(value)) freezeSnapshot(child, seen)
    }
    return Object.freeze(value)
  }

  function catalogSnapshot(value) {
    if (value === null || typeof value !== 'object' || !Array.isArray(value.plugins)) return undefined
    const snapshot = {
      profile: value.profile,
      profileDir: value.profileDir,
      plugins: value.plugins.map(plugin => ({
        ...plugin,
        ...(plugin?.description !== null && typeof plugin?.description === 'object'
          ? { description: { ...plugin.description } }
          : {}),
      })),
      system: Array.isArray(value.system) ? value.system.map(bundle => ({ ...bundle })) : [],
      initialized: value.initialized,
    }
    return freezeSnapshot(snapshot)
  }

  function cachePluginCatalog(value) {
    const snapshot = catalogSnapshot(value?.catalog ?? value)
    if (snapshot === undefined) return false
    pluginCatalogSnapshot = snapshot
    return true
  }

  function emptyPluginCatalog() {
    const location = pluginCatalogLocation
    return {
      profile: location?.profile ?? 'web',
      profileDir: location === undefined ? undefined : join(location.dshHome, 'profiles', location.profile),
      plugins: [],
      system: [],
      initialized: false,
    }
  }

  function pluginCatalogLocationForRecipe(recipe, managedMode) {
    if (!managedMode) return legacyPluginCatalogLocation
    const dshHome = recipe?.profileHome
    const profile = recipe?.physicalProfileName
    if (typeof dshHome !== 'string' || dshHome.length === 0
      || typeof profile !== 'string' || !RELEASE_ID_PATTERN.test(profile)) {
      throw new Error('Managed Harness started without an immutable plugin catalog owner')
    }
    return Object.freeze({ dshHome, profile })
  }

  function publishPluginCatalogLocation(recipe, managedMode) {
    const next = pluginCatalogLocationForRecipe(recipe, managedMode)
    const changed = next?.dshHome !== pluginCatalogLocation?.dshHome
      || next?.profile !== pluginCatalogLocation?.profile
    pluginCatalogLocation = next
    if (changed) pluginCatalogSnapshot = undefined
  }

  function readPluginCatalogIfIdle({ swallow = false } = {}) {
    const location = pluginCatalogLocation
    if (location === undefined) return undefined
    if (operationCoordinator?.busy) return pluginCatalogSnapshot ?? emptyPluginCatalog()
    try {
      const catalog = pluginOwners.readPluginCatalog(location)
      cachePluginCatalog(catalog)
      return pluginCatalogSnapshot ?? catalog
    } catch (error) {
      if (swallow) return pluginCatalogSnapshot
      throw error
    }
  }

  // Establish the first stable snapshot before any controller-owned writer can
  // start. Later reads are lazy and never parse profile state while busy.
  if (pluginCatalogLocation !== undefined) readPluginCatalogIfIdle({ swallow: true })

  async function preparePluginRecoveryPatch(runtimeValue, signal) {
    const recoveryRoot = activeRoot ?? dataRoot
    if (typeof recoveryRoot !== 'string' || recoveryRoot.length === 0) return undefined
    if (typeof activeHome !== 'string' || activeHome.length === 0) return undefined
    try {
      if (!(await stat(activeHome)).isDirectory()) return undefined
    } catch {
      // A test/runtime without an existing profile root has no user plugin
      // tree to quarantine. Keep the normal managed-runtime fallback intact.
      return undefined
    }

    const catalog = pluginCatalogSnapshot ?? readPluginCatalogIfIdle({ swallow: true })
    const packageNames = new Set(Object.keys(RECOVERY_PLUGIN_ROW_IDS))
    for (const plugin of catalog?.plugins ?? []) {
      const name = plugin?.name ?? plugin?.npm
      if (typeof name === 'string' && name.length > 0) packageNames.add(name)
    }

    let dumpOutput = ''
    try {
      const entry = resolveDsh(runtimeValue)
      const result = await (pluginAdapters.runCommand ?? runOwnedCommand)({
        command: getProcess.execPath,
        args: [entry, 'web', '--dump-config'],
        cwd: activeHome ?? getHomeDirectory() ?? recoveryRoot,
        env: {
          ...runtimeEnvironment,
          ELECTRON_RUN_AS_NODE: '1',
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
        signal,
        platform: getProcess.platform,
        onOutput: (source, text) => writeLog(source, text),
        outputLabel: 'DSH plugin recovery inspection',
        timeoutMs: 30_000,
        terminationTimeoutMs: 1_000,
      })
      dumpOutput = result?.output ?? ''
    } catch (error) {
      writeLog('stderr', `[plugin-recovery] Unable to inspect the composed plugin rows: ${errorDetail(error)}\n`)
    }

    const rowIds = userPluginRowsFromDump(dumpOutput, packageNames)
    for (const name of packageNames) {
      for (const id of RECOVERY_PLUGIN_ROW_IDS[name] ?? []) rowIds.add(id)
    }
    if (rowIds.size === 0) return undefined

    const directory = join(recoveryRoot, 'recovery')
    await mkdir(directory, { recursive: true })
    const path = join(directory, `disable-user-plugins-${String(Date.now())}-${String(getProcess.pid)}.yml`)
    await writeTextAtomic(path, recoveryPatchText(rowIds))
    writeLog('desktop', `[plugin-recovery] Prepared a temporary overlay for ${String(rowIds.size)} user plugin row(s); plugin files and the active profile were not modified.\n`)
    return Object.freeze({ path, rowCount: rowIds.size })
  }

  let workspaceReadiness
  const lifecycleOwner = lifecycleFactory({
    isQuitting: () => quitting,
    onPublish: publication => {
      if (!lifecycleOwner.isCurrent(publication.generation)) return
      server = publication.server
      harnessOrigin = publication.origin
      workspaceReadiness?.reset()
      publishedGeneration = publication.generation
      notifyState()
    },
    onClear: publication => {
      if (server === publication.server && publishedGeneration === publication.generation) {
        server = undefined
        harnessOrigin = undefined
        workspaceReadiness?.reset()
        publishedGeneration = undefined
        notifyState()
      }
    },
  })

  modeSupervisor.on?.('cleanup-error', event => {
    const cleanupError = event?.cleanupError ?? event?.error
    if (cleanupError !== undefined) lifecycleOwner.markUnsafe?.(cleanupError)
    notifyState()
  })

  operationCoordinator = coordinatorFactory({ onStateChange: notifyState })
  workspaceReadiness = readinessFactory({
    isCurrent: generation => lifecycleOwner.isCurrent(generation),
    isPublished: (generation, harnessServer) => lifecycleOwner.isPublished(generation, harnessServer),
    isWindowOpen: () => windows.isOpen?.('workspace') === true,
    onChange: notifyState,
  })

  function stagedPluginStateStoreComplete() {
    if (releaseStateStore === undefined || releaseStateStore === null) return false
    const methods = ['readStagedPluginCandidate', 'writeStagedPluginCandidate', 'clearStagedPluginCandidate']
    const available = methods.filter(method => typeof releaseStateStore[method] === 'function')
    if (available.length !== 0 && available.length !== methods.length) {
      throw new TypeError('Invalid staged plugin candidate state store')
    }
    return available.length === methods.length
  }

  function clearStagedPluginCandidateState(label = 'staged plugin candidate') {
    if (!stagedPluginStateStoreComplete()) return false
    try {
      releaseStateStore.clearStagedPluginCandidate()
      return true
    } catch (error) {
      writeLog('stderr', `[plugin-transaction] Unable to clear ${label}: ${errorDetail(error)}\n`)
      return false
    }
  }

  function hydrateStagedPluginCandidate() {
    if (pendingPluginCandidateHydrated || !stagedPluginStateStoreComplete()) return
    const staged = releaseStateStore.readStagedPluginCandidate()
    pendingPluginCandidateHydrated = true
    if (staged === undefined) return

    const active = releaseStateStore.readActive()
    const pendingRelease = releaseStateStore.readPending?.()
    if (active?.releaseId === staged.candidateId) {
      if (active.manifestSha256 !== staged.manifestSha256) {
        throw new Error(`Active plugin candidate ${staged.candidateId} does not match its staged manifest`)
      }
      const activationIsUnsettled = pendingRelease?.operation === 'switch'
        && (pendingRelease.targetActive?.releaseId === staged.candidateId
          || (pendingRelease.phase === 'restoring'
            && pendingRelease.targetActive === null
            && pendingRelease.previousActive?.releaseId === staged.parentReleaseId))
      if (!activationIsUnsettled) {
        clearStagedPluginCandidateState('already activated plugin candidate')
        return
      }

      // The active pointer is published before the release observation and
      // durable switch journal are completed. A crash in that window must not
      // make the staged candidate look committed: recovery may still restore
      // the parent release and needs this identity to retire the failed child.
      pendingPluginCandidateId = staged.candidateId
      pendingPluginParentReleaseId = staged.parentReleaseId
      pendingPluginManifestSha256 = staged.manifestSha256
      writeLog('desktop', `[plugin-transaction] Preserved staged candidate ${staged.candidateId} while its release switch is still ${pendingRelease.phase}.\n`)
      return
    }
    if (active?.releaseId !== undefined && active.releaseId !== staged.parentReleaseId) {
      clearStagedPluginCandidateState('obsolete plugin candidate')
      writeLog('desktop', `[plugin-transaction] Ignored staged candidate ${staged.candidateId} because ${active.releaseId} is active instead of ${staged.parentReleaseId}.\n`)
      return
    }

    pendingPluginCandidateId = staged.candidateId
    pendingPluginParentReleaseId = staged.parentReleaseId
    pendingPluginManifestSha256 = staged.manifestSha256
    writeLog('desktop', `[plugin-transaction] Recovered staged candidate ${staged.candidateId} for activation.\n`)
  }

  function ensureReleaseOwners() {
    if (managedDataRecoveryPending) return false
    if (releaseInfrastructureError !== undefined) return false
    try {
      if (releaseStateStore === undefined && typeof releaseStateRoot === 'string' && releaseStateRoot !== '') {
        releaseStateStore = stateFactory(releaseStateRoot, { stateRoot: releaseStateRoot })
      }
      if (snapshotStore === undefined && typeof dataRoot === 'string' && dataRoot !== ''
        && typeof snapshotRoot === 'string' && snapshotRoot !== '') {
        snapshotStore = snapshotFactory({
          sourceRoot: dataRoot,
          dataRoot,
          snapshotRoot,
          excludedRelativePaths: snapshotExcludedRelativePaths,
        }, snapshotRoot)
      }
      if (releaseSwitcher === undefined && releaseStateStore !== undefined && snapshotStore !== undefined
        && typeof dataRoot === 'string' && dataRoot !== '') {
        releaseSwitcher = switcherFactory({
          stateStore: releaseStateStore,
          snapshotStore,
          dataRoot,
          snapshotRoot,
          excludedRelativePaths: snapshotExcludedRelativePaths,
          candidateResolver: resolveCandidateRelease,
          stopOwned: stopOwnedRelease,
          startRelease: startOwnedRelease,
          observeRelease,
          preserveDataOnSwitch: activeRoot !== undefined && readManagedDataHome(activeRoot) !== undefined,
          onProgress: event => {
            const stage = typeof event?.stage === 'string' ? event.stage : 'unknown'
            writeLog('desktop', `[release/recovery] ${stage}.\n`)
          },
          now: () => releaseTimestamp(releaseNow()),
          observeDuration,
        })
      }
      if (releaseStateStore !== undefined && !releaseStoreComplete(releaseStateStore, [
        'readActive', 'readLastKnownGood', 'writeActive', 'writeLastKnownGood', 'readPending', 'writePending', 'clearPending',
      ])) throw new TypeError('Invalid release state store')
      hydrateStagedPluginCandidate()
      if (snapshotStore !== undefined && !releaseStoreComplete(snapshotStore, ['create', 'list', 'restore'])) {
        throw new TypeError('Invalid snapshot store')
      }
      if (releaseSwitcher !== undefined && !releaseStoreComplete(releaseSwitcher, ['switch', 'recoverPending'])) {
        throw new TypeError('Invalid release switcher')
      }
      return true
    } catch (error) {
      releaseInfrastructureError = releaseError(error)
      return false
    }
  }

  function generationIsCurrent(generation) {
    return generation === undefined ? !quitting : lifecycleOwner.isCurrent(generation)
  }

  function setStartupState(phase, message, progress, error, generation) {
    if (!generationIsCurrent(generation)) return false
    startupPhase = phase
    startupMessage = diagnosticStatusText(message)
    loadingProgress = normalizeProgress(progress)
    startupError = error === undefined ? undefined : diagnosticStatusText(error)
    notifyState()
    return true
  }

  function clearTimers() {
    if (installerUpdateTimer !== undefined) {
      clearTimeoutImpl(installerUpdateTimer)
      installerUpdateTimer = undefined
    }
    abortBackgroundInstallerUpdate(new Error('Desktop shutdown'))
    if (dshUpdateTimer !== undefined) {
      clearTimeoutImpl(dshUpdateTimer)
      dshUpdateTimer = undefined
    }
  }

  function coordinatorOwnsDshOperation() {
    return operationCoordinator.active?.label?.startsWith('dsh-') === true
  }

  function coordinatorBlocksExternalOperation() {
    return operationCoordinator.busy && !coordinatorOwnsDshOperation()
  }

  function enqueueDshOperation(label, action, { signal } = {}) {
    return operationCoordinator.enqueue(`dsh-${label}`, ({ signal: operationSignal }) => action(operationSignal), { signal })
  }

  function abortBackgroundInstallerUpdate(reason = new Error('Background installer update superseded')) {
    if (backgroundInstallerUpdateTimer !== undefined) {
      clearTimeoutImpl(backgroundInstallerUpdateTimer)
      backgroundInstallerUpdateTimer = undefined
    }
    const controller = backgroundInstallerUpdateAbortController
    backgroundInstallerUpdateAbortController = undefined
    if (controller !== undefined && !controller.signal.aborted) controller.abort(reason)
  }

  function runBackgroundDesktopUpdate({ signal } = {}) {
    if (installerUpdateController === undefined || quitting) return Promise.resolve()
    abortBackgroundInstallerUpdate(new Error('Background installer update superseded'))
    const controller = new AbortController()
    backgroundInstallerUpdateAbortController = controller
    const forwardAbort = () => controller.abort(signal.reason)
    if (signal?.aborted) controller.abort(signal.reason)
    else signal?.addEventListener?.('abort', forwardAbort, { once: true })
    backgroundInstallerUpdateTimer = setTimeoutImpl(() => {
      backgroundInstallerUpdateTimer = undefined
      if (!controller.signal.aborted) controller.abort(new Error('Background installer update timed out'))
    }, 12_000)
    backgroundInstallerUpdateTimer?.unref?.()
    return Promise.resolve()
      .then(() => installerUpdateController.probe ? installerUpdateController.probe({ signal: controller.signal }) : installerUpdateController.check(false, { signal: controller.signal }))
      .catch(error => {
        if (!controller.signal.aborted && !signal?.aborted) {
          writeUpdaterLog('info', `Background installer update check skipped: ${errorDetail(error)}`)
        }
      })
      .finally(() => {
        if (backgroundInstallerUpdateTimer !== undefined) {
          clearTimeoutImpl(backgroundInstallerUpdateTimer)
          backgroundInstallerUpdateTimer = undefined
        }
        signal?.removeEventListener?.('abort', forwardAbort)
        if (backgroundInstallerUpdateAbortController === controller) backgroundInstallerUpdateAbortController = undefined
      })
  }

  function enqueueDesktopUpdate(manual = false, { signal } = {}) {
    if (installerUpdateController === undefined) return Promise.resolve()
    if (!manual) return runBackgroundDesktopUpdate({ signal })
    abortBackgroundInstallerUpdate(new Error('Manual installer update requested'))
    return operationCoordinator.enqueue('desktop-update', ({ signal: operationSignal }) => {
      if (operationSignal.aborted) throw abortReason(operationSignal)
      return installerUpdateController.probe ? installerUpdateController.probe({ signal: operationSignal }) : installerUpdateController.check(manual, { signal: operationSignal })
    }, { signal })
  }

  function enqueueHarnessRestart(label = 'restart', { message = copy.restarting, signal } = {}) {
    const options = arguments[1] ?? {}
    return operationCoordinator.enqueue(label, ({ signal: operationSignal }) => start(message, {
      [DATA_MIGRATION_OPERATION_OWNER]: true,
      signal: operationSignal,
      mode: options.mode,
      modeRecipe: options.modeRecipe,
      restart: true,
      harnessPatches: options.harnessPatches,
      pluginRecovery: options.pluginRecovery === true,
      pluginRecoveryDetails: options.pluginRecoveryDetails,
    }), { signal })
  }

  function ensureCandidateBuilder() {
    if (candidateBuilder !== undefined) return candidateBuilder
    if (candidateRoot === undefined) return undefined
    const customCandidateFactory = candidateBuilderFactory !== undefined
      || ownerAdapters.createCandidateBuilder !== undefined
    if (repositoryRoot === undefined && !customCandidateFactory) return undefined
    candidateBuilder = candidateFactory({
      candidateRoot,
      repositoryRoot,
      recipePath: repositoryRoot === undefined ? undefined : join(repositoryRoot, 'profiles', 'ricardo-stable.json'),
      profileMode: 'stable',
      desktopVersion: appVersion(),
      pnpmEntry: bundledPnpmEntry(),
      execPath: getProcess.execPath,
      env: runtimeEnvironment,
      ...(hiddenChildProcess === undefined ? {} : { hiddenChildProcess }),
      onOutput: (source, text) => writeLog(source, text),
      compatibilityRecipeForVersion,
      applyCompatibilityRecipeImpl: compatibilityRecipeApplier,
      resolveProfileOptionsImpl: usesBuiltInCandidateBuilder
        ? request => resolveDshCandidateProfileOptions({
            channel: request?.channel,
            releaseId: request?.releaseId,
            dshVersion: request?.runtime?.version,
            signal: request?.signal,
          })
        : undefined,
    })
    if (candidateBuilder === undefined || typeof candidateBuilder.prepare !== 'function' || typeof candidateBuilder.verify !== 'function') {
      throw new TypeError('Invalid candidate builder owner')
    }
    return candidateBuilder
  }

  function readPendingRelease() {
    if (!releaseStoreComplete(releaseStateStore, ['readPending'])) return { pending: undefined }
    try {
      return { pending: releaseStateStore.readPending() }
    } catch (error) {
      return { pending: undefined, error: releaseError(error, 'Unable to read release pending state') }
    }
  }

  function releaseOwnersAvailable() {
    if (!ensureReleaseOwners()) return false
    return releaseStoreComplete(releaseStateStore, [
      'readActive', 'readLastKnownGood', 'writeActive', 'writeLastKnownGood', 'readPending', 'writePending', 'clearPending',
    ])
      && releaseStoreComplete(snapshotStore, ['create', 'list', 'restore'])
      && releaseStoreComplete(releaseSwitcher, ['switch', 'recoverPending'])
  }

  function snapshotStatus() {
    const available = releaseStoreComplete(snapshotStore, ['create', 'list', 'restore'])
      && typeof dataRoot === 'string'
      && dataRoot !== ''
      && typeof snapshotRoot === 'string'
      && snapshotRoot !== ''
    const reason = releaseInfrastructureError?.message
      ?? (!available ? 'Snapshot store is unavailable.' : null)
    return sanitizeDiagnosticValue({
      state: available ? 'available' : 'unavailable',
      available,
      busy: releaseOperationRunning || operationCoordinator.busy,
      reason,
    })
  }

  function releaseStatus() {
    const pendingState = readPendingRelease()
    const available = releaseOwnersAvailable()
    return sanitizeDiagnosticValue({
      state: pendingState.error !== undefined ? 'error' : pendingState.pending === undefined ? 'idle' : 'pending',
      available,
      busy: releaseOperationRunning || operationCoordinator.busy,
      pending: pendingState.pending ?? null,
      reason: pendingState.error?.message ?? releaseInfrastructureError?.message ?? null,
    })
  }

  function getCandidateStatus() {
    const available = candidateRoot !== undefined
      && (repositoryRoot !== undefined || candidateBuilderFactory !== undefined || ownerAdapters.createCandidateBuilder !== undefined)
    const pendingState = readPendingRelease()
    let previousProgram
    try { previousProgram = releaseStateStore?.readPrevious?.() } catch { /* damaged optional history cannot block the workspace */ }
    const currentProgram = releaseStateStore?.readActive?.()
    const codeRollbackAvailable = previousProgram !== undefined && previousProgram.releaseId !== currentProgram?.releaseId
      && !managedDataRecoveryPending && managedDataHome !== undefined
      && pendingState.error === undefined && pendingState.pending === undefined && releaseOwnersAvailable()
      && !candidateOperationRunning && !releaseOperationRunning && !operationCoordinator.busy && !quitting
    const candidateReady = candidateState === 'ready'
      && candidateResult !== undefined
      && candidateResult?.manifest?.releaseId === (candidateResult?.releaseId ?? candidateResult?.manifest?.releaseId)
    const switchAvailable = available
      && candidateReady
      && pendingState.error === undefined
      && pendingState.pending === undefined
      && releaseOwnersAvailable()
      && !candidateOperationRunning
      && !releaseOperationRunning
      && !operationCoordinator.busy
      && !quitting
    return sanitizeDiagnosticValue({
      state: available ? candidateState : 'unavailable',
      available,
      busy: candidateOperationRunning || releaseOperationRunning || operationCoordinator.busy,
      previousReleaseId: previousProgram?.releaseId ?? null,
      codeRollbackAvailable,
      prepareAvailable: available && !candidateOperationRunning && !releaseOperationRunning && !operationCoordinator.busy && !quitting,
      switchAvailable,
      channel: candidateResult?.channel ?? null,
      id: candidateResult?.releaseId ?? candidateResult?.manifest?.releaseId ?? null,
      version: candidateResult?.manifest?.dsh?.version ?? null,
      physicalProfileName: candidateResult?.manifest?.profile?.physicalName ?? null,
      reason: candidateReason ?? pendingState.error?.message ?? (switchAvailable ? null : releaseInfrastructureError?.message),
    })
  }

  function prepareCandidate(channel = 'stable', { signal, onProgress } = {}) {
    if (!['stable', 'next'].includes(channel)) return Promise.reject(new TypeError('Invalid candidate channel'))
    if (candidateOperationRunning) return Promise.resolve(false)
    let builder
    try {
      builder = ensureCandidateBuilder()
    } catch (error) {
      candidateState = 'error'
      candidateReason = errorDetail(error)
      notifyState()
      return Promise.reject(error)
    }
    if (builder === undefined || quitting) return Promise.resolve(false)

    candidateOperationRunning = true
    candidateResult = undefined
    candidateState = 'preparing'
    candidateReason = null
    notifyState()
    const releaseId = `${channel}-${randomUUID()}`
    let preparedCandidatePath
    return operationCoordinator.enqueue('candidate-prepare', async ({ signal: operationSignal }) => {
      if (operationSignal.aborted) throw abortReason(operationSignal)
      const result = await builder.prepare({
        channel,
        releaseId,
        signal: operationSignal,
        onProgress: typeof onProgress === 'function' ? onProgress : undefined,
      })
      preparedCandidatePath = result?.candidateDir
      if (operationSignal.aborted) throw abortReason(operationSignal)
      if (usesBuiltInCandidateBuilder) {
        await reconcilePreparedCandidateCompatibility(result.candidateDir, {
          signal: operationSignal,
          onProgress,
        })
        // A candidate is not ready merely because its files and hashes are
        // valid. Boot the exact DSH + profile pair in a disposable isolated
        // home and exercise its HTTP/terminal surface before exposing the
        // switch action. This is the generic compatibility boundary for new
        // DSH/plugin combinations; no release-specific patch is required for
        // an update to be considered safe.
        await runPluginCandidateRuntimeGate({
          candidateId: releaseId,
          signal: operationSignal,
        })
      }
      if (operationSignal.aborted) throw abortReason(operationSignal)
      const verified = await builder.verify({
        candidateDir: result.candidateDir,
        expectedReleaseId: releaseId,
        expectedChannel: channel,
        signal: operationSignal,
        onProgress: typeof onProgress === 'function' ? onProgress : undefined,
      })
      candidateResult = { ...result, ...verified, releaseId, channel }
      candidateState = 'ready'
      candidateReason = null
      writeDshUpdaterLog('info', `Prepared verified ${channel} candidate ${releaseId} with DSH ${verified.manifest.dsh.version}; active release unchanged.`)
      return candidateResult
    }, { signal }).catch(async error => {
      // The candidate builder owns cleanup for failures during its own
      // prepare() call. Once it has returned, however, the generic
      // compatibility/runtime gate below is also allowed to reject the
      // candidate. Retire that exact disposable directory so a failed
      // preflight cannot accumulate an apparently-ready orphan.
      if (typeof preparedCandidatePath === 'string'
        && typeof candidateRoot === 'string'
        && isWithin(candidateRoot, preparedCandidatePath)
        && resolve(candidateRoot) !== resolve(preparedCandidatePath)) {
        try {
          await rm(resolve(preparedCandidatePath), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        } catch (cleanupError) {
          try { error.cleanupError ??= cleanupError } catch { /* preserve the primary failure */ }
          writeLog('stderr', `[dsh-updater] Unable to retire failed candidate ${releaseId}: ${errorDetail(cleanupError)}\n`)
        }
      }
      candidateState = signal?.aborted ? (candidateResult === undefined ? 'idle' : 'ready') : 'error'
      candidateReason = signal?.aborted ? 'Candidate preparation was cancelled.' : errorDetail(error)
      throw error
    }).finally(() => {
      candidateOperationRunning = false
      notifyState()
    })
  }

  function runReleaseOperation(label, action, options = {}) {
    if (typeof label !== 'string' || label.length === 0) throw new TypeError('Invalid release operation label')
    if (typeof action !== 'function') throw new TypeError('Invalid release operation')
    if (!releaseOwnersAvailable()) throw releaseError(releaseInfrastructureError, 'Release operations are unavailable')
    if (quitting) return false
    const signal = options?.signal
    if (signal?.aborted) throw abortReason(signal)
    return operationCoordinator.enqueue(`release-${label}`, async ({ signal: operationSignal }) => {
      releaseOperationRunning = true
      notifyState()
      try {
        return await action(operationSignal)
      } finally {
        releaseOperationRunning = false
        notifyState()
      }
    }, { signal })
  }

  function releaseOperationOptions(options) {
    if (options === undefined) return {}
    if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Release operation options must be an object')
    return options
  }

  async function switchCandidate(candidateId, options = {}) {
    if (typeof candidateId !== 'string' || !RELEASE_ID_PATTERN.test(candidateId)) throw new TypeError('Invalid candidate release id')
    const operationOptions = releaseOperationOptions(options)
    return runReleaseOperation('switch', async signal => {
      ensureBootstrapActiveRelease()
      const expectedParentReleaseId = operationOptions.expectedParentReleaseId
      if (expectedParentReleaseId !== undefined) {
        if (typeof expectedParentReleaseId !== 'string' || !RELEASE_ID_PATTERN.test(expectedParentReleaseId)) {
          throw new TypeError('Invalid expected parent release id')
        }
        const active = releaseStateStore.readActive()
        if (active?.releaseId !== expectedParentReleaseId) {
          const error = new Error(`Plugin candidate ${candidateId} was built from ${expectedParentReleaseId}, but ${String(active?.releaseId ?? 'no release')} is active`)
          error.code = 'PLUGIN_CANDIDATE_PARENT_CHANGED'
          throw error
        }
      }
      const switchOptions = { ...operationOptions }
      delete switchOptions.expectedParentReleaseId
      const result = await releaseSwitcher.switch(candidateId, { ...switchOptions, signal })
      if (result?.status !== 'switched' || result?.pointer?.releaseId !== candidateId) {
        throw new Error(`Release switch did not confirm activation of ${candidateId}`)
      }
      if (usesBuiltInCandidateBuilder) {
        // ReleaseSwitcher has already verified the candidate and activated its
        // pointer. Read the verified release once more to hydrate the in-memory
        // updater status; this is read-only and prevents the management route
        // from showing the bundled version after a successful candidate switch.
        const activeRelease = await resolveCandidateRelease(candidateId, {
          signal,
          verifyRuntime: false,
          writePluginCompatibility: false,
        })
        syncManagedDshRuntime(activeRelease)
      }
      candidateState = 'active'
      candidateReason = null
      return result
    }, operationOptions).catch(error => {
      candidateState = candidateResult === undefined ? 'idle' : 'error'
      candidateReason = errorDetail(error)
      throw error
    })
  }

  async function listSnapshots(options = {}) {
    const operationOptions = releaseOperationOptions(options)
    return runReleaseOperation('snapshot-list', signal => snapshotStore.list({
      ...operationOptions,
      sourceRoot: operationOptions.sourceRoot ?? dataRoot,
      dataRoot: operationOptions.dataRoot ?? dataRoot,
      snapshotRoot: operationOptions.snapshotRoot ?? snapshotRoot,
      signal,
    }), operationOptions)
  }

  async function createSnapshot(options = {}) {
    const operationOptions = releaseOperationOptions(options)
    return runReleaseOperation('snapshot-create', signal => snapshotStore.create({
      ...operationOptions,
      sourceRoot: operationOptions.sourceRoot ?? dataRoot,
      dataRoot: operationOptions.dataRoot ?? dataRoot,
      snapshotRoot: operationOptions.snapshotRoot ?? snapshotRoot,
      signal,
    }), operationOptions)
  }

  async function restoreSnapshot(snapshotId, options = {}) {
    if (typeof snapshotId !== 'string' || !RELEASE_ID_PATTERN.test(snapshotId)) throw new TypeError('Invalid snapshot id')
    const operationOptions = releaseOperationOptions(options)
    return runReleaseOperation('snapshot-restore', async signal => {
      ensureBootstrapActiveRelease()
      if (typeof releaseSwitcher.manualRollback === 'function') {
        return releaseSwitcher.manualRollback(snapshotId, { ...operationOptions, signal })
      }
      if (typeof releaseSwitcher.rollback === 'function') {
        return releaseSwitcher.rollback(snapshotId, { ...operationOptions, signal })
      }
      return snapshotStore.restore({
        ...operationOptions,
        snapshotId,
        id: snapshotId,
        sourceRoot: operationOptions.sourceRoot ?? dataRoot,
        dataRoot: operationOptions.dataRoot ?? dataRoot,
        snapshotRoot: operationOptions.snapshotRoot ?? snapshotRoot,
        signal,
      })
    }, operationOptions)
  }

  async function recoverPendingRelease(options = {}) {
    const operationOptions = releaseOperationOptions(options)
    if (managedDataRecoveryPending) {
      await operationCoordinator.enqueue('recover-data-home', ({ signal }) => recoverManagedDataHome(signal, true), operationOptions)
    }
    const result = await runReleaseOperation(
      'recover-pending',
      signal => releaseSwitcher.recoverPending({ ...operationOptions, signal }),
      operationOptions,
    )
    if (result?.status === 'recovered' && result?.operation === 'switch' && pendingPluginCandidateId !== undefined) {
      try {
        await abandonPendingPluginCandidate('recovered failed plugin candidate')
        writeLog('desktop', '[plugin-transaction] Retired the failed staged candidate after release recovery.\n')
      } catch (error) {
        writeLog('stderr', `[plugin-transaction] Unable to discard the recovered failed candidate: ${errorDetail(error)}\n`)
      }
    }
    return result
  }

  async function recoverManagedDataHome(signal, allowBusyMigration = false) {
    if (!managedDataRecoveryPending) return
    if (runtime.dataRoot !== undefined || configuredDataRoot !== undefined
      || suppliedSnapshotStore !== undefined || runtime.snapshotStore !== undefined
      || suppliedReleaseSwitcher !== undefined || runtime.releaseSwitcher !== undefined) {
      throw new Error('Pending managed-data migration cannot be recovered with custom data owners')
    }
    const state = releaseStateStore ?? stateFactory(releaseStateRoot, { stateRoot: releaseStateRoot })
    const active = state.readActive()
    if (!active || active.releaseId === BOOTSTRAP_RELEASE_ID || state.readPending() !== undefined) {
      throw new Error('Managed-data recovery requires an unchanged active candidate and no pending program switch')
    }
    const adopted = await migrateManagedDataHome({
      runtimeRoot: activeRoot,
      sourceHome: join(activeRoot, 'candidates', active.releaseId),
      sourceReleaseId: active.releaseId,
      signal,
      assertStopped: () => lifecycleOwner.published === undefined && lifecycleOwner.unsafe !== true && !modeIsUnsafe()
        && (!operationCoordinator.busy || allowBusyMigration),
    })
    const current = state.readActive()
    if (current?.releaseId !== active.releaseId || current.manifestSha256 !== active.manifestSha256) {
      throw new Error('Active release changed during managed-data recovery')
    }
    dataRoot = managedDataHome = adopted.dataHome
    dataHomeWasMigrated = true
    snapshotRoot = resolveAdapter(runtime.snapshotRoot, configuredSnapshotRoot ?? defaultDesktopSnapshotRoot(dataRoot))
    snapshotExcludedRelativePaths = [...new Set([...snapshotExcludedRelativePaths, 'profiles'])]
    snapshotStore = undefined
    releaseSwitcher = undefined
    managedDataRecoveryPending = false
    if (!ensureReleaseOwners()) throw releaseInfrastructureError ?? new Error('Recovered data owners are unavailable')
    writeLog('desktop', '[data-home] Resumed and verified interrupted user-data migration.\n')
  }

  function writeUpdaterLog(level, message) {
    writeLog(level === 'error' ? 'stderr' : 'desktop', `[updater/${level}] ${message}\n`)
  }

  function writeDshUpdaterLog(level, message) {
    writeLog(level === 'error' ? 'stderr' : 'desktop', `[dsh-updater/${level}] ${message}\n`)
  }

  function scheduleDshUpdateProbe(delay = 15_000, attemptsRemaining = 4) {
    if (quitting || dshUpdateController === undefined || dshUpdateTimer !== undefined) return
    dshUpdateTimer = setTimeoutImpl(() => {
      dshUpdateTimer = undefined
      if (quitting) return
      // Startup and plugin transactions can temporarily occupy the operation
      // coordinator. Retry only a few times; a manual check remains available
      // in the Update route and never installs anything by itself.
      void checkDshUpdateAvailability().then(result => {
        if (result?.busy === true && attemptsRemaining > 0) scheduleDshUpdateProbe(15_000, attemptsRemaining - 1)
      }).catch(() => {})
    }, delay)
    dshUpdateTimer?.unref?.()
  }

  function initializeUpdates() {
    if (updatesInitialized) return getUpdateAdapters()
    updatesInitialized = true

    if (getApp !== undefined && typeof getApp.getPath === 'function') {
      installerUpdateController = installerFactory({
        isPackaged: isPackaged(),
        platform: getProcess.platform,
        arch: getProcess.arch,
        isChinese,
        currentVersion: appVersion(),
        downloadsDirectory: getDownloadsDirectory(),
        releaseSource: desktopReleaseSource,
        flavor: runtime.desktopDistributionFlavor,
        fetchImpl: (url, options) => net?.fetch?.(url, options),
        dialog,
        getWindow: () => windows.getWindow('workspace'),
        openReleasePage: url => shell?.openExternal?.(url),
        openDownloadedFile: path => getProcess.platform === 'linux'
          ? Promise.resolve(shell?.showItemInFolder?.(path))
          : shell?.openPath?.(path),
        onStateChange: notifyState,
        log: writeUpdaterLog,
      })
      if (!installerUpdateController.initialize()) {
        writeUpdaterLog('info', desktopReleaseSource === undefined
          ? 'Desktop release source is not configured; the packaged desktop version remains the only version authority.'
          : 'No installer is published for this package/platform; the desktop release source remains available for manual inspection.')
      } else if (typeof installerUpdateController.probe !== 'function') {
        installerUpdateTimer = setTimeoutImpl(() => {
          installerUpdateTimer = undefined
          if (!quitting) detached(enqueueDesktopUpdate(false), 'Background installer update check')
        }, 10_000)
        installerUpdateTimer?.unref?.()
      }
    }

    if (activeDshRuntime !== undefined && activeRoot !== undefined) {
      dshUpdateController = dshFactory({
        initialRuntime: activeDshRuntime,
        runtimeRoot: activeRoot,
        pnpmEntry: bundledPnpmEntry(),
        execPath: getProcess.execPath,
        env: runtimeEnvironment,
        ...(hiddenChildProcess === undefined ? {} : { hiddenChildProcess }),
        isChinese,
        dialog,
        getWindow: () => windows.getWindow('management') ?? windows.getWindow('workspace'),
        onRuntimeChanged: async (runtimeValue, { signal } = {}) => {
          const previousRuntime = activeDshRuntime
          writeDshUpdaterLog('info', `Staging DSH ${runtimeValue.version} from the ${runtimeValue.source} runtime.`)
          let started = false
          try {
            started = await start(copy.restarting, { signal, runtime: runtimeValue, provisional: true })
          } catch (error) {
            reportDetachedFailure('Provisional DSH startup', error)
          }
          if (started !== true || signal?.aborted) {
            // The candidate was never committed to the controller's runtime
            // snapshot. Restore the previous in-memory owner on every failed or
            // canceled generation, including a late abort after readiness.
            activeDshRuntime = previousRuntime
            return false
          }
          return true
        },
        onRuntimeCommitted: runtimeValue => {
          activeDshRuntime = runtimeValue
          writeDshUpdaterLog('info', `Activated DSH ${runtimeValue.version} from the ${runtimeValue.source} runtime.`)
        },
        onRuntimeRollback: async (runtimeValue, { signal } = {}) => {
          let restored = false
          try {
            restored = await start(copy.restarting, { signal, runtime: runtimeValue, provisional: true })
          } catch (error) {
            reportDetachedFailure('DSH runtime rollback startup', error)
          }
          if (restored !== true || signal?.aborted) {
            activeDshRuntime = runtimeValue
            return false
          }
          activeDshRuntime = runtimeValue
          return true
        },
        onStateChange: notifyState,
        onOutput: writeLog,
        log: writeDshUpdaterLog,
        isOperationBlocked: () => coordinatorBlocksExternalOperation() || pluginOperationRunning,
      })
      // Runtime-only online activation is retired. Candidate preparation is
      // explicit and non-activating; Task 7 owns the later switch transaction.
      if (typeof installerUpdateController?.probe !== 'function') scheduleDshUpdateProbe()
    }
    if (typeof installerUpdateController?.probe === 'function') ensureDualUpdates().start()
    notifyState()
    return getUpdateAdapters()
  }

  function getUpdateAdapters() {
    return Object.freeze({
      desktop: installerUpdateController,
      dsh: dshUpdateController,
    })
  }

  function detached(promiseOrAction, label) {
    const run = typeof promiseOrAction === 'function' ? promiseOrAction : () => promiseOrAction
    try {
      Promise.resolve(run()).catch(error => reportDetachedFailure(label, error))
    } catch (error) {
      reportDetachedFailure(label, error)
    }
  }

  async function showLoading(message = copy.preparing, progress = 8, generation) {
    if (!generationIsCurrent(generation)) return false
    const safeMessage = diagnosticStatusText(message)
    clearWorkspaceContext()
    setStartupState('loading', safeMessage, progress, undefined, generation)
    if (preserveLoadingSurface()) {
      const loadingWindow = windows.currentLoadingWindow?.()
      if (loadingWindow === undefined || !windows.isOpen?.(loadingWindow)) return false
      loadingProgress = normalizeProgress(progress)
      if (!windows.isVisible?.(loadingWindow)) windows.show?.(loadingWindow)
      return true
    }
    const management = windows.getWindow('management')
    if (windows.isOpen?.(management) && windows.managementRendererAvailable?.()) {
      const loaded = await windows.loadManagementRoute('loading', { lang: getLanguage(), message: safeMessage, progress }, {
        canContinue: () => generationIsCurrent(generation),
      })
      if (!loaded || !generationIsCurrent(generation)) return false
      if (!windows.isVisible?.(management)) windows.show?.(management)
      return true
    }
    const loadingWindow = windows.currentLoadingWindow?.()
    if (loadingWindow === undefined) return false
    await windows.loadFallbackPage(loadingWindow, 'loading.html', {
      lang: getLanguage(), message: safeMessage, progress: String(progress), stage: 'preparing', theme: getThemePreference(),
    })
    if (!generationIsCurrent(generation) || !windows.isOpen?.(loadingWindow)) return false
    loadingProgress = normalizeProgress(progress)
    if (!windows.isVisible?.(loadingWindow)) windows.show?.(loadingWindow)
    return true
  }

  async function updateLoading(message, progress, stage, generation) {
    const nextProgress = normalizeProgress(progress)
    if (!generationIsCurrent(generation) || nextProgress < loadingProgress) return false
    loadingProgress = nextProgress
    startupPhase = stage
    startupMessage = diagnosticStatusText(message)
    startupError = undefined
    writeLog('desktop', `Startup stage ${stage} (${String(nextProgress)}%).\n`)
    notifyState()
    if (preserveLoadingSurface()) {
      const loadingWindow = windows.currentLoadingWindow?.()
      if (loadingWindow === undefined || !windows.isOpen?.(loadingWindow)) return false
      if (!windows.isVisible?.(loadingWindow)) windows.show?.(loadingWindow)
      return generationIsCurrent(generation)
    }
    if (windows.isOpen?.('management') && windows.managementRendererAvailable?.()) return true
    const loadingWindow = windows.currentLoadingWindow?.()
    if (loadingWindow === undefined) return false
    try {
      await windows.executeLoadingScript(loadingStateScript(diagnosticStatusText(message), nextProgress, stage), loadingWindow)
    } catch (error) {
      if (windows.isOpen?.(loadingWindow) && generationIsCurrent(generation)) {
        writeLog('stderr', `Unable to update startup progress: ${errorDetail(error)}\n`)
      }
    }
    return generationIsCurrent(generation)
  }

  function revealMainWindow(generation, harnessServer) {
    return windows.reveal({
      canReveal: () => generationIsCurrent(generation)
        && (harnessServer === undefined || lifecycleOwner.isPublished(generation, harnessServer)),
    })
  }

  async function showError(title, error, generation, harnessServer) {
    if (!generationIsCurrent(generation)) return false
    workspaceReadiness.reset()
    if (harnessServer !== undefined) lifecycleOwner.clearPublished(generation, harnessServer)
    clearWorkspaceContext()
    const safeTitle = diagnosticStatusText(title)
    const detail = diagnosticDialogDetail(errorDetail(error))
    setStartupState('error', safeTitle, loadingProgress, detail, generation)
    writeLog('desktop', `${safeTitle}: ${detail}\n`)
    const management = windows.getWindow('management')
    if (windows.isOpen?.(management) && windows.managementRendererAvailable?.()) {
      try {
        if (await windows.loadManagementRoute('error', {
          lang: getLanguage(),
          title: safeTitle,
          detail,
          logs: diagnosticStatusText(getLogPath() ?? ''),
        }, { canContinue: () => generationIsCurrent(generation) })) {
          if (!generationIsCurrent(generation) || !windows.isOpen?.(management)) return false
          return revealMainWindow(generation)
        }
      } catch (renderError) {
        if (generationIsCurrent(generation)) reportDetachedFailure('Management error view', renderError)
        return false
      }
    }
    if (!generationIsCurrent(generation)) return false
    if (!windows.isOpen?.('workspace')) windows.create?.('workspace')
    const workspace = windows.getWindow('workspace')
    await windows.loadFallbackPage(workspace, 'error.html', {
      lang: getLanguage(), title: safeTitle, detail, logs: diagnosticStatusText(getLogPath() ?? ''),
    })
    if (!generationIsCurrent(generation) || !windows.isOpen?.(workspace)) return false
    return revealMainWindow(generation)
  }

  async function stopHarnessServer(target, generation) {
    if (target === undefined) return lifecycleOwner.stopAll()
    const publication = lifecycleOwner.published
    const ownerGeneration = generation ?? (publication?.server === target ? publication.generation : undefined)
    if (ownerGeneration === undefined) return false
    return lifecycleOwner.stopLocal(ownerGeneration, target)
  }

  function modeStatus() {
    try {
      return modeSupervisor.statusSnapshot?.() ?? modeSupervisor.status?.() ?? {}
    } catch {
      return {}
    }
  }

  function requestedMode(options = {}) {
    const requested = options.mode ?? runtime.mode ?? runtime.defaultMode ?? runtime.preferredMode
    if (requested === 'legacy' || requested === 'stable' || requested === 'dev') return requested
    const status = modeStatus()
    if (status.active === 'stable' || status.active === 'dev') return status.active
    if (status.stable?.configured === true || configuredStableMode !== undefined) return 'stable'
    if (status.dev?.configured === true || configuredDevMode !== undefined) return 'dev'
    return 'legacy'
  }

  function normalizeModeReady(value) {
    const url = typeof value === 'string' ? value : value?.url ?? value?.origin
    if (typeof url !== 'string' || url.length === 0) throw new Error('Runtime mode supervisor returned no readiness URL')
    return url
  }

  function modeIsUnsafe() {
    const status = modeStatus()
    return status.unsafe === true || status.cleanupError !== undefined
  }

  async function recoverUnexpectedHostExit({ generation, target, code, signal: exitSignal, output, pluginRecovery }) {
    if (quitting || !lifecycleOwner.isCurrent(generation) || !lifecycleOwner.isPublished(generation, target)) return false
    if (pluginRecoveryInFlight) return false
    if (pluginRecovery || pluginRecoveryAttempted) {
      try {
        await showError(copy.stopped, new Error(`Harness exited after recovery (code: ${String(code)}, signal: ${String(exitSignal)}).`), generation, target)
      } catch (error) {
        reportDetachedFailure('Recovered Harness error renderer', error)
      }
      return false
    }

    pluginRecoveryAttempted = true
    pluginRecoveryInFlight = true
    try {
      const recovery = await preparePluginRecoveryPatch(activeDshRuntime)
      if (recovery === undefined) {
        await showError(copy.stopped, new Error(`Harness exited (code: ${String(code)}, signal: ${String(exitSignal)}).`), generation, target)
        return false
      }
      if (typeof output === 'string' && output.trim() !== '') {
        writeLog('stderr', `[plugin-recovery] Host output before exit:\n${output}\n`)
      }
      writeLog('desktop', '[plugin-recovery] Restarting Harness with user plugin rows temporarily disabled. The installed plugin files remain untouched.\n')
      const recovered = await enqueueHarnessRestart('plugin-recovery', {
        message: '正在隔离故障插件并恢复 Harness…',
        harnessPatches: [recovery.path],
        pluginRecovery: true,
        pluginRecoveryDetails: {
          reason: 'unexpected-host-exit',
          rowCount: recovery.rowCount,
          patchPath: recovery.path,
        },
      })
      if (recovered === true) {
        writeLog('desktop', '[plugin-recovery] Harness recovered in compatibility mode.\n')
        return true
      }
      return false
    } catch (error) {
      reportDetachedFailure('Plugin compatibility recovery', error)
      return false
    } finally {
      pluginRecoveryInFlight = false
    }
  }

  function releaseTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) throw new TypeError('Invalid release timestamp')
    return date.toISOString()
  }

  function bootstrapPointer() {
    const identity = JSON.stringify({
      releaseId: BOOTSTRAP_RELEASE_ID,
      runtime: activeDshRuntime ?? null,
      dataRoot: typeof dataRoot === 'string' ? dataRoot : null,
    })
    return {
      schemaVersion: 1,
      releaseId: BOOTSTRAP_RELEASE_ID,
      manifestSha256: createHash('sha256').update(identity).digest('hex'),
      activatedAt: releaseTimestamp(releaseNow()),
    }
  }

  function bootstrapRelease() {
    const pointer = bootstrapPointer()
    return {
      candidate: {
        status: 'ready',
        releaseId: BOOTSTRAP_RELEASE_ID,
        channel: 'local',
        manifestSha256: pointer.manifestSha256,
      },
      pointer,
      recipe: {
        mode: 'legacy',
        releaseId: BOOTSTRAP_RELEASE_ID,
        runtime: activeDshRuntime,
      },
    }
  }

  function ensureBootstrapActiveRelease() {
    if (!releaseStoreComplete(releaseStateStore, ['readActive', 'readLastKnownGood', 'writeActive', 'writeLastKnownGood'])) return
    if (releaseSwitcher?.stateStore !== undefined && releaseSwitcher.stateStore !== releaseStateStore) return
    const active = releaseStateStore.readActive()
    const lastKnownGood = releaseStateStore.readLastKnownGood()
    if (active === undefined && lastKnownGood === undefined) {
      const pointer = bootstrapPointer()
      releaseStateStore.writeActive(pointer)
      releaseStateStore.writeLastKnownGood(pointer)
    } else if (active === undefined && lastKnownGood !== undefined) {
      releaseStateStore.writeActive(lastKnownGood)
    } else if (lastKnownGood === undefined && active !== undefined) {
      releaseStateStore.writeLastKnownGood(active)
    }
  }

  async function resolveCandidateRelease(candidateId, {
    signal,
    verifyRuntime = true,
    writePluginCompatibility = false,
  } = {}) {
    if (typeof candidateId !== 'string' || !RELEASE_ID_PATTERN.test(candidateId)) throw new TypeError('Invalid candidate release id')
    if (signal?.aborted) throw abortReason(signal)
    if (candidateId === BOOTSTRAP_RELEASE_ID) return bootstrapRelease()
    const builder = ensureCandidateBuilder()
    if (builder === undefined || candidateRoot === undefined) throw new Error('Candidate verification is unavailable')
    const candidateDir = join(candidateRoot, candidateId)
    if (!isWithin(candidateRoot, candidateDir) || candidateDir === candidateRoot) throw new TypeError('Candidate directory escapes candidate root')
    const verified = await builder.verify({
      candidateDir,
      expectedReleaseId: candidateId,
      signal,
      verifyRuntime,
    })
    if (signal?.aborted) throw abortReason(signal)
    const manifest = verified?.manifest
    const version = manifest?.dsh?.version
    if (typeof version !== 'string' || version.length === 0) throw new Error('Verified candidate has no DSH version')
    if (verified?.descriptor?.version !== undefined && verified.descriptor.version !== version) {
      throw new Error('Verified candidate runtime descriptor version does not match the manifest')
    }
    const profileSourcePath = join(candidateDir, 'profile')
    const runtimeDirectory = join(candidateDir, 'runtime', 'versions', version)
    const runtimeEntry = join(runtimeDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (!isWithin(candidateDir, profileSourcePath) || !isWithin(candidateDir, runtimeEntry)) throw new Error('Verified candidate runtime path escapes its directory')
    const [profileStats, entryStats] = await Promise.all([stat(profileSourcePath), stat(runtimeEntry)])
    if (!profileStats.isDirectory()) throw new Error('Verified candidate profile is not a directory')
    if (!entryStats.isFile()) throw new Error('Verified candidate DSH entry is not a regular file')
    const manifestSha256 = verified?.manifestSha256
    if (typeof manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifestSha256)) throw new Error('Verified candidate has no manifest hash')
    const physicalProfileName = manifest?.profile?.physicalName
    if (typeof physicalProfileName !== 'string' || !RELEASE_ID_PATTERN.test(physicalProfileName)) throw new Error('Verified candidate has no physical profile name')
    await ensureCandidateDesktopIntegration(candidateDir, repositoryRoot)
    const profilePath = await ensureCandidatePhysicalProfile(candidateDir, profileSourcePath, physicalProfileName)
    const hostServicesPatch = await prepareLegacyHostServicePatch(candidateDir, profilePath)
    const pluginCompatibility = nativePluginPolicy(await pluginRuntimeCompatibilityEnsurer(
      candidateDir,
      profilePath,
      repositoryRoot,
      { write: writePluginCompatibility },
    ), candidateId)
    for (const compatibility of pluginCompatibility.checks ?? [pluginCompatibility]) {
      if (compatibility.state === 'patched') {
        const action = writePluginCompatibility ? 'Applied' : 'Detected pending'
        writeLog('desktop', `[plugin-compatibility] ${action} ${compatibility.packageName} desktop compatibility in ${candidateId}.\n`)
      }
    }
    const pointer = {
      schemaVersion: 1,
      releaseId: candidateId,
      manifestSha256,
      activatedAt: releaseTimestamp(releaseNow()),
    }
    const candidate = {
      ...verified,
      releaseId: candidateId,
      channel: manifest.channel,
      runtime: {
        version,
        integrity: manifest.dsh.integrity,
        directory: runtimeDirectory,
        entry: runtimeEntry,
      },
      profile: {
        ...manifest.profile,
        directory: profilePath,
      },
    }
    const recipe = Object.freeze({
      mode: 'stable',
      releaseId: candidateId,
      expectedReleaseId: candidateId,
      entry: runtimeEntry,
      ...(hostServicesPatch ? { patches: [hostServicesPatch] } : {}),
      runtimeArgs: [
        '--expose-internals',
        '--require',
        join(repositoryRoot, 'src', 'runtime', 'windows-hidden-child-process.cjs'),
      ],
      profilePath,
      physicalProfileName,
      profileHome: candidateDir,
      ...(activeRoot !== undefined && readManagedDataHome(activeRoot)?.dataHome
        ? { dataHome: readManagedDataHome(activeRoot).dataHome, managedRuntimeRoot: activeRoot }
        : {}),
      cwd: profilePath,
    })
    return { candidate, pointer, recipe, pluginCompatibility }
  }

  async function resolvePersistedStartupRelease({ signal, allowBusyMigration = false } = {}) {
    if (!ensureReleaseOwners()) {
      throw releaseInfrastructureError ?? new Error('Release state is unavailable')
    }
    if (!releaseStoreComplete(releaseStateStore, ['readActive'])) return undefined

    ensureBootstrapActiveRelease()
    const active = releaseStateStore.readActive()
    if (active === undefined || active.releaseId === BOOTSTRAP_RELEASE_ID) return undefined
    if (signal?.aborted) throw abortReason(signal)

    // Candidate activation already performs the expensive full runtime
    // inventory comparison. Normal startup re-validates the persisted
    // pointer, canonical manifest, profile inputs, descriptor, and signed
    // inventory artifact without blocking on tens of thousands of runtime
    // file hashes again.
    let release = await resolveCandidateRelease(active.releaseId, {
      signal,
      verifyRuntime: false,
      writePluginCompatibility: false,
    })
    if (release?.pointer?.releaseId !== active.releaseId) {
      throw new Error(`Persisted active release ${active.releaseId} resolved as ${String(release?.pointer?.releaseId)}`)
    }
    if (release.pointer.manifestSha256 !== active.manifestSha256) {
      throw new Error(`Persisted active release ${active.releaseId} does not match its verified manifest`)
    }
    if (release?.recipe?.mode !== 'stable') {
      throw new Error(`Persisted active release ${active.releaseId} has no stable startup recipe`)
    }

    // Only cold, quiescent startup may adopt legacy candidate-owned data.
    // Read-only candidate inspection and disposable preflight never migrate it.
    if (activeRoot !== undefined && runtime.dataRoot === undefined && configuredDataRoot === undefined
      && suppliedSnapshotStore === undefined && runtime.snapshotStore === undefined
      && suppliedReleaseSwitcher === undefined && runtime.releaseSwitcher === undefined
      && readManagedDataHome(activeRoot) === undefined && releaseStateStore.readPending?.() === undefined) {
      writeLog('desktop', '[data-home] Preparing independent user data; the original candidate data will be retained.\n')
      const adopted = await migrateManagedDataHome({
        runtimeRoot: activeRoot,
        sourceHome: release.recipe.profileHome,
        sourceReleaseId: active.releaseId,
        signal,
        assertStopped: () => lifecycleOwner.published === undefined && lifecycleOwner.unsafe !== true && !modeIsUnsafe()
          && (!operationCoordinator.busy || allowBusyMigration),
      })
      const stillActive = releaseStateStore.readActive()
      if (stillActive?.releaseId !== active.releaseId || stillActive.manifestSha256 !== active.manifestSha256) {
        throw new Error('Active release changed during user-data adoption')
      }
      dataRoot = adopted.dataHome
      managedDataHome = adopted.dataHome
      dataHomeWasMigrated = true
      snapshotRoot = resolveAdapter(runtime.snapshotRoot, configuredSnapshotRoot ?? defaultDesktopSnapshotRoot(dataRoot))
      snapshotExcludedRelativePaths = [...new Set([...snapshotExcludedRelativePaths, 'profiles'])]
      snapshotStore = undefined
      releaseSwitcher = undefined
      if (!ensureReleaseOwners()) throw releaseInfrastructureError ?? new Error('Independent data recovery owners are unavailable')
      release = { ...release, recipe: Object.freeze({ ...release.recipe, dataHome: dataRoot, managedRuntimeRoot: activeRoot }) }
      writeLog('desktop', '[data-home] Verified independent user data; version changes will retain this data home.\n')
    }

    syncManagedDshRuntime(release)
    writeLog('desktop', `[release/startup] Restoring active release ${active.releaseId} from verified state.\n`)
    return release
  }

  async function resolveActivePluginRelease({ signal } = {}) {
    if (!releaseStoreComplete(releaseStateStore, ['readActive'])) {
      throw new Error('Plugin transactions require a release state owner')
    }
    const active = releaseStateStore.readActive()
    if (active === undefined || active.releaseId === BOOTSTRAP_RELEASE_ID) {
      throw new Error('Plugin transactions are unavailable while the bootstrap/live profile is active')
    }
    // The active pointer was already accepted only after candidate activation
    // completed the expensive full runtime inventory verification. Repeating
    // every file hash before each plugin transaction can freeze the market for
    // minutes on Windows. Re-validate the immutable pointer, manifest, profile
    // receipts, descriptor, and signed inventory artifact here; the child
    // candidate still receives the complete runtime verification before it can
    // be staged or activated.
    const release = await resolveCandidateRelease(active.releaseId, {
      signal,
      verifyRuntime: false,
      writePluginCompatibility: false,
    })
    if (release?.pointer?.manifestSha256 !== active.manifestSha256) {
      throw new Error(`Active plugin release ${active.releaseId} does not match its verified manifest`)
    }
    if (release?.recipe?.mode === 'legacy' || release?.recipe?.profileHome === undefined) {
      throw new Error('Plugin transactions require an active immutable candidate release')
    }
    return release
  }

  async function resolveDshCandidateProfileOptions({ channel, releaseId, dshVersion, signal } = {}) {
    if (channel !== 'stable' || candidateRoot === undefined || repositoryRoot === undefined) return {}
    if (!releaseStoreComplete(releaseStateStore, ['readActive'])) return {}
    const active = releaseStateStore.readActive()
    if (active === undefined || active.releaseId === BOOTSTRAP_RELEASE_ID) return {}

    const release = await resolveActivePluginRelease({ signal })
    const sourceRoot = resolve(release.recipe.profileHome)
    const sourceProfile = resolve(join(sourceRoot, 'profile'))
    const sourcePhysicalProfile = resolve(release.recipe.profilePath)
    if (!isWithin(candidateRoot, sourceRoot)
      || !isWithin(sourceRoot, sourceProfile)
      || !isWithin(sourceRoot, sourcePhysicalProfile)) {
      throw new Error('Active DSH profile escapes the managed candidate root')
    }

    const [sourcePackage, sourceLock, activeManifest] = await Promise.all([
      readFile(join(sourceProfile, 'package.json'), 'utf8').then(JSON.parse),
      readFile(join(sourceProfile, 'pnpm-lock.yaml'), 'utf8'),
      readFile(join(sourceRoot, 'manifest.json'), 'utf8').then(JSON.parse),
    ])
    const dependencies = sourcePackage?.dependencies
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) return {}

    // A DSH update is a compatibility event for the whole profile, not just
    // one runtime package. Refresh registry-managed plugins against the target
    // DSH only after their live metadata says the release accepts that DSH.
    // GitHub pins and local packages stay at their exact audited sources; their
    // normal market update path remains the explicit owner for those sources.
    const activeDshVersion = activeManifest?.dsh?.version ?? release.candidate?.manifest?.dsh?.version
    const refreshPlugins = semver.valid(dshVersion) === dshVersion
      && semver.valid(activeDshVersion) === activeDshVersion
      && semver.gt(dshVersion, activeDshVersion)
    const nextDependencies = { ...dependencies }
    const refreshedPlugins = new Map()
    if (refreshPlugins) {
      for (const [name, current] of Object.entries(dependencies)) {
        if (semver.valid(current) !== current) continue
        try {
          const latest = await fetchLatestRegistryPluginRelease(name, { signal })
          if (!semver.gt(latest.version, current)) continue
          const engineCheck = inspectPluginDshEngine({
            name,
            pluginVersion: latest.version,
            requiredRange: latest.requiredRange,
            dshVersion,
            engineCompatibilityOverrides: PLUGIN_ENGINE_COMPATIBILITY_OVERRIDES,
          })
          if (engineCheck.status === 'invalid' || engineCheck.status === 'incompatible') {
            writeLog('desktop', `[plugin-compatibility] Kept ${name}@${current}; latest ${latest.version} does not accept DSH ${dshVersion}.\n`)
            continue
          }
          nextDependencies[name] = latest.version
          refreshedPlugins.set(name, latest)
          writeLog('desktop', `[plugin-compatibility] Selected ${name}@${latest.version} for DSH ${dshVersion}.\n`)
        } catch (error) {
          // Network metadata is advisory. Keep the last-known-good exact
          // dependency and let the later static/runtime candidate gates make
          // the final decision instead of making registry availability a hard
          // prerequisite for starting the desktop.
          writeLog('stderr', `[plugin-compatibility] Could not refresh ${name} for DSH ${dshVersion}: ${errorDetail(error)}\n`)
        }
      }
    }
    const dependencyNames = Object.keys(nextDependencies)
    const physicalName = `ricardo-stable-${releaseId}`
    const packageJson = { ...sourcePackage, name: physicalName, dependencies: nextDependencies }
    const bundles = Array.isArray(activeManifest?.bundles)
      ? activeManifest.bundles.map(bundle => ({ ...bundle }))
      : []
    for (const [name, latest] of refreshedPlugins) {
      const nextBundle = {
        name,
        resolved: latest.version,
        integrityOrCommit: latest.integrity,
      }
      const index = bundles.findIndex(bundle => bundle.name === name)
      if (index === -1) bundles.push(nextBundle)
      else bundles[index] = { ...bundles[index], ...nextBundle }
    }
    const profilePlan = {
      mode: 'stable',
      releaseId,
      logicalName: 'ricardo-stable',
      physicalName,
      packageJson,
      bundles,
    }
    const profileInputs = {
      sourcePackage: { ...sourcePackage, dependencies: nextDependencies },
      sourceLock,
      compatibility: {
        schemaVersion: 1,
        order: dependencyNames,
        defaultOrder: dependencyNames,
        localPackages: {},
      },
      evidenceDir: join(repositoryRoot, 'profiles', 'evidence', 'web-2026-08-22'),
    }

    const copyProfileEntry = async (sourcePath, targetPath, entry) => {
      if (entry.name === 'node_modules' || entry.name === '.dsh-module-fallback') return
      await cp(sourcePath, targetPath, {
        recursive: entry.isDirectory(),
        force: false,
        errorOnExist: true,
        dereference: false,
      })
    }
    const copyCandidateState = async ({ stageDir, signal: copySignal } = {}) => {
      if (release.recipe.dataHome !== undefined) return
      // Preserve user state, including the pet's candidate-owned Electron
      // runtime. The clone adapter uses bounded retries for files that can be
      // momentarily locked while the Helper restarts.
      const skipped = new Set(['artifacts', 'manifest.json', 'profile', 'profiles', 'runtime'])
      for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
        if (skipped.has(entry.name)) continue
        if (copySignal?.aborted) throw abortReason(copySignal)
        await copyProfileEntry(join(sourceRoot, entry.name), join(stageDir, entry.name), entry)
      }
    }
    const materializeProfile = async ({ outputDir, plan } = {}) => {
      for (const entry of await readdir(sourceProfile, { withFileTypes: true })) {
        await copyProfileEntry(join(sourceProfile, entry.name), join(outputDir, entry.name), entry)
      }
      // Keep the active market's small state directory without carrying its
      // derived node_modules farm into the new candidate.
      try {
        const marketState = join(sourcePhysicalProfile, '.dsh-market')
        await cp(marketState, join(outputDir, '.dsh-market'), {
          recursive: true,
          force: false,
          errorOnExist: true,
          dereference: false,
        })
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      await writeFile(join(outputDir, 'package.json'), `${JSON.stringify(plan.packageJson, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await writeFile(join(outputDir, 'profile-plan.json'), `${JSON.stringify({
        schemaVersion: 1,
        mode: plan.mode,
        releaseId: plan.releaseId,
        logicalName: plan.logicalName,
        physicalName: plan.physicalName,
        bundles: plan.bundles,
      }, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      return { profileDir: outputDir }
    }
    const hydrateProfile = async ({ profileDir, signal: hydrateSignal } = {}) => {
      if (refreshedPlugins.size > 0) {
        await runPnpm({
          args: [
            'install',
            '--lockfile-only',
            '--no-frozen-lockfile',
            '--prefer-offline',
            '--node-linker=hoisted',
            '--reporter',
            'append-only',
            '--config.strict-dep-builds=false',
          ],
          env: runtimeEnvironment,
          execPath: getProcess.execPath,
          pnpmEntry: bundledPnpmEntry(),
          profileDir,
          signal: hydrateSignal,
          ...(hiddenChildProcess === undefined ? {} : { hiddenChildProcess }),
          onOutput: (sourceName, text) => writeLog(sourceName, text),
        })
      }
      await runPnpm({
        args: ['install', '--prefer-offline', '--frozen-lockfile', '--node-linker=hoisted', '--reporter', 'append-only', '--config.strict-dep-builds=false'],
        env: runtimeEnvironment,
        execPath: getProcess.execPath,
        pnpmEntry: bundledPnpmEntry(),
        profileDir,
        signal: hydrateSignal,
        ...(hiddenChildProcess === undefined ? {} : { hiddenChildProcess }),
        onOutput: (sourceName, text) => writeLog(sourceName, text),
      })
      return {
        profileDir,
        logicalName: 'ricardo-stable',
        physicalName,
        bundles,
      }
    }

    return {
      profileInputs,
      profilePlan,
      seedCandidateStateImpl: copyCandidateState,
      materializeProfileImpl: materializeProfile,
      buildProfileImpl: hydrateProfile,
    }
  }

  async function getActiveSettingsPath({ signal } = {}) {
    if (signal?.aborted) throw abortReason(signal)
    if (managedDataRecoveryPending) throw new Error('用户数据正在恢复，请等待完成后再打开设置文件。')
    if (releaseStoreComplete(releaseStateStore, ['readActive'])) {
      const active = releaseStateStore.readActive()
      if (active !== undefined && active.releaseId !== BOOTSTRAP_RELEASE_ID) {
        const release = await resolveActivePluginRelease({ signal })
        const profileHome = resolve(release.recipe.dataHome ?? release.recipe.profileHome)
        const settingsPath = join(profileHome, 'settings.yaml')
        if (!isWithin(profileHome, settingsPath)) throw new Error('Active Harness settings path escapes its managed release')
        return settingsPath
      }
    }
    const home = activeHome ?? getHomeDirectory()
    if (typeof home !== 'string' || home.trim() === '' || !isAbsolute(home)) {
      throw new Error('Harness settings home is unavailable')
    }
    const resolvedHome = resolve(home)
    const settingsPath = join(resolvedHome, 'settings.yaml')
    if (!isWithin(resolvedHome, settingsPath)) throw new Error('Harness settings path escapes its home directory')
    return settingsPath
  }

  async function reconcilePreparedCandidateCompatibility(candidateDir, { signal, onProgress } = {}) {
    const candidateRoot = resolve(candidateDir)
    if (candidateRoot === '' || candidateRoot === resolve(candidateRoot, '..')) throw new Error('Prepared DSH candidate path is invalid')
    const manifestPath = join(candidateRoot, 'manifest.json')
    const manifest = validateReleaseManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
    const profilePath = join(candidateRoot, 'profile')
    if (!isWithin(candidateRoot, profilePath)) throw new Error('Prepared DSH candidate profile escapes its release')
    await ensureCandidateDesktopIntegration(candidateRoot, repositoryRoot)
    const physicalProfilePath = await ensureCandidatePhysicalProfile(candidateRoot, profilePath, manifest.profile.physicalName)
    const compatibility = nativePluginPolicy(await pluginRuntimeCompatibilityEnsurer(candidateRoot, physicalProfilePath, repositoryRoot, { write: true }), manifest.releaseId)
    let patched = false
    for (const check of compatibility.checks ?? [compatibility]) {
      if (check?.state === 'patched') patched = true
    }
    if (!patched) return { manifest, compatibility }

    const runtimeInventory = await runtimeInventoryCreator(candidateRoot, {
      signal,
      onProgress: typeof onProgress === 'function' ? onProgress : undefined,
    })
    const clientArtifacts = [...manifest.clientArtifacts]
    const inventoryIndex = clientArtifacts.findIndex(artifact => artifact.path === runtimeInventory.path)
    if (inventoryIndex === -1) throw new Error('Prepared DSH candidate has no runtime inventory artifact')
    clientArtifacts[inventoryIndex] = runtimeInventory
    const finalized = validateReleaseManifest({ ...manifest, clientArtifacts })
    await writeTextAtomic(manifestPath, serializeReleaseManifest(finalized))
    return { manifest: finalized, compatibility }
  }

  async function runPluginCandidateRuntimeGate(request = {}) {
    const candidateId = request.candidateId
    const release = await resolveCandidateRelease(candidateId, { signal: request.signal })
    return runIsolatedCandidateRuntimeGate({
      recipe: release.recipe,
      candidateId,
      signal: request.signal,
      env: runtimeEnvironment,
      execPath: getProcess.execPath,
      onOutput: (source, text) => writeLog(source, text),
    })
  }

  async function readAndReconcilePluginCandidateManifest({
    manifestPath,
    candidateId,
    parentReleaseId,
    phase,
  }) {
    let manifest = validateReleaseManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
    if (manifest.releaseId === candidateId) return manifest

    const active = releaseStoreComplete(releaseStateStore, ['readActive'])
      ? releaseStateStore.readActive()
      : undefined
    const recoverableParent = typeof parentReleaseId === 'string'
      && RELEASE_ID_PATTERN.test(parentReleaseId)
      && parentReleaseId !== candidateId
      && manifest.releaseId === parentReleaseId
      && active?.releaseId === parentReleaseId
    if (!recoverableParent) {
      const error = new Error(`Plugin candidate identity mismatch: directory=${candidateId}, manifest=${manifest.releaseId}, parent=${String(parentReleaseId ?? '<missing>')}`)
      error.code = 'PLUGIN_CANDIDATE_IDENTITY_MISMATCH'
      throw error
    }

    // Old candidate clones inherited the active parent's manifest identity.
    // Reconcile only that exact, still-active parent inside the already
    // canonicalized child directory. Unrelated identities continue to fail
    // closed, so this recovery cannot bless an arbitrary release.
    manifest = rebaseManagedReleaseManifest(manifest, {
      releaseId: candidateId,
      createdAt: releaseTimestamp(releaseNow()),
    })
    await writeTextAtomic(manifestPath, serializeReleaseManifest(manifest))
    const rebound = validateReleaseManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
    if (rebound.releaseId !== candidateId) {
      const error = new Error(`Plugin candidate identity rewrite did not persist for ${candidateId}`)
      error.code = 'PLUGIN_CANDIDATE_IDENTITY_REWRITE_FAILED'
      throw error
    }
    writeLog('desktop', `[plugin-transaction] Recovered stale parent manifest identity ${parentReleaseId} as ${candidateId} during ${phase ?? 'candidate processing'}.\n`)
    return rebound
  }

  async function finalizePluginCandidate({ candidateId, candidatePath, candidateRoot: transactionRoot, parentReleaseId, action, packageName, source, packages, profile: expectedProfile, signal, onProgress } = {}) {
    if (signal?.aborted) throw abortReason(signal)
    const candidateIdentity = await canonicalCandidateDirectory(transactionRoot, candidateId, candidatePath)
    const resolvedCandidatePath = candidateIdentity.candidateRealPath
    const manifestPath = join(resolvedCandidatePath, 'manifest.json')
    const profilePath = join(resolvedCandidatePath, 'profile')
    const profileStats = await lstat(profilePath)
    if (profileStats.isSymbolicLink?.() === true || profileStats.isReparsePoint?.() === true || !profileStats.isDirectory()) {
      throw new Error('Plugin candidate profile is not a regular directory')
    }
    const profileRealPath = await realpath(profilePath)
    if (!isWithin(resolvedCandidatePath, profileRealPath) || relative(profilePath, profileRealPath) !== '') {
      throw new Error('Plugin candidate profile real path escapes its release')
    }
    const manifest = await readAndReconcilePluginCandidateManifest({
      manifestPath,
      candidateId,
      parentReleaseId,
      phase: 'finalization',
    })

    const additions = packages === undefined
      ? (packageName === undefined || source === undefined ? [] : [{ packageName, source }])
      : packages
    if (!Array.isArray(additions)) throw new TypeError('Plugin candidate packages must be an array')
    const actualProfile = JSON.parse(await readFile(join(profilePath, 'package.json'), 'utf8'))
    assertPluginCandidateProfile({
      actualProfile,
      expectedProfile,
      action,
      packageName,
      additions,
    })
    if (actualProfile.name !== manifest.profile.physicalName) {
      throw candidateProfileError('Plugin candidate profile name does not match the release manifest')
    }
    let pluginCompatibilityPatched = false
    try {
      // The release manifest hashes the logical profile while DSH starts from
      // profiles/<physicalName>. Verify both copies before the manifest is
      // sealed so a partial sync can never reach activation.
      const physicalProfilePath = await ensureCandidatePhysicalProfile(resolvedCandidatePath, profilePath, manifest.profile.physicalName)
      const pluginCompatibility = nativePluginPolicy(await pluginRuntimeCompatibilityEnsurer(resolvedCandidatePath, physicalProfilePath, repositoryRoot), candidateId)
      for (const compatibility of pluginCompatibility.checks ?? [pluginCompatibility]) {
        if (compatibility.state === 'patched') {
          pluginCompatibilityPatched = true
          writeLog('desktop', `[plugin-compatibility] Applied ${compatibility.packageName} desktop compatibility before sealing ${candidateId}.\n`)
        }
      }
    } catch (error) {
      if (error?.code === undefined) error.code = 'PLUGIN_CANDIDATE_PROFILE_MISMATCH'
      throw error
    }

    let clientArtifacts = [...manifest.clientArtifacts]
    let runtimeInventoryRefreshRequired = pluginCompatibilityPatched
    if (compatibilityRecipeForVersion(manifest.dsh.version)) {
      const runtimeDirectory = join(resolvedCandidatePath, 'runtime', 'versions', manifest.dsh.version)
      const compatibility = await compatibilityRecipeApplier({
        root: runtimeDirectory,
        recipe: compatibilityRecipeForVersion(manifest.dsh.version),
        dshVersion: manifest.dsh.version,
        write: true,
        signal,
      })
      if (compatibility.targets.some(target => target.state === 'patched')) {
        runtimeInventoryRefreshRequired = true
      }
    }
    if (runtimeInventoryRefreshRequired) {
      const runtimeInventory = await runtimeInventoryCreator(resolvedCandidatePath, {
        signal,
        onProgress: typeof onProgress === 'function' ? onProgress : undefined,
      })
      const inventoryIndex = clientArtifacts.findIndex(artifact => artifact.path === runtimeInventory.path)
      if (inventoryIndex === -1) throw new Error('Plugin candidate manifest has no runtime inventory artifact')
      clientArtifacts[inventoryIndex] = runtimeInventory
      writeLog('desktop', `[plugin-transaction] Refreshed the runtime inventory after compatibility changes before sealing ${candidateId}.\n`)
    }

    const profileReceipt = {
      ...manifest.profile,
      manifestSha256: await sha256File(join(profilePath, 'package.json')),
      lockSha256: await sha256File(join(profilePath, 'pnpm-lock.yaml')),
      patchSha256: await sha256File(join(profilePath, 'cordis.patch.yml')),
    }
    let bundles = [...manifest.bundles]
    if (action !== 'remove') {
      const seen = new Set()
      for (const addition of additions) {
        const nextName = addition?.packageName
        const nextSource = addition?.source
        if (typeof nextName !== 'string' || seen.has(nextName)) throw new Error('Plugin candidate contains an invalid or duplicate package')
        seen.add(nextName)
        if (nextSource?.type === 'local-dev') throw new Error('Stable plugin candidates cannot contain local-dev sources')
        const resolved = nextSource?.specifier
        const integrityOrCommit = nextSource?.type === 'npm'
          ? nextSource.integrity
          : nextSource?.type === 'github'
            ? nextSource.commit
            : nextSource?.type === 'local-pack' && typeof nextSource.version === 'string' && typeof nextSource.sha256 === 'string'
              // The candidate profile and lockfile are sealed by hash below;
              // the manifest uses the established local-package identity while
              // requiring the packed source itself to carry a SHA-256 digest.
              ? `local-package:${nextSource.version}`
              : undefined
        if (typeof resolved !== 'string' || typeof integrityOrCommit !== 'string') {
          throw new Error('Plugin source did not resolve to an exact release')
        }
        const entry = { name: nextName, resolved, integrityOrCommit }
        const index = bundles.findIndex(bundle => bundle.name === nextName)
        if (index === -1) bundles.push(entry)
        else bundles[index] = entry
      }
    } else if (packageName !== undefined) {
      bundles = bundles.filter(bundle => bundle.name !== packageName)
    }

    const finalized = validateReleaseManifest({ ...manifest, profile: profileReceipt, bundles, clientArtifacts })
    const currentIdentity = await canonicalCandidateDirectory(transactionRoot, candidateId, candidatePath)
    if (relative(candidateIdentity.candidateRealPath, currentIdentity.candidateRealPath) !== ''
      || !sameDirectoryIdentity(candidateIdentity.directoryIdentity, currentIdentity.directoryIdentity)) {
      throw new Error('Plugin candidate directory changed during finalization')
    }
    await writeTextAtomic(manifestPath, serializeReleaseManifest(finalized))
    const verified = await ensureCandidateBuilder()?.verify?.({
      candidateDir: resolvedCandidatePath,
      expectedReleaseId: candidateId,
      expectedChannel: finalized.channel,
      signal,
      onProgress: typeof onProgress === 'function' ? onProgress : undefined,
    })
    if (verified === undefined) throw new Error('Plugin candidate verification is unavailable')
    return {
      ok: true,
      manifestSha256: releaseManifestSha256(finalized),
      profile: finalized.profile,
      bundles: finalized.bundles,
    }
  }

  function ensurePluginTransactionService() {
    if (pluginTransactionService !== undefined) {
      if (typeof pluginTransactionService.transaction !== 'function'
        || typeof pluginTransactionService.removePreview !== 'function'
        || typeof pluginTransactionService.confirmRemove !== 'function') {
        throw new TypeError('Invalid plugin transaction owner')
      }
      return pluginTransactionService
    }
    if (pluginTransactionInfrastructureError !== undefined) throw pluginTransactionInfrastructureError
    if (typeof candidateRoot !== 'string' || candidateRoot === '') {
      throw new Error('Plugin transaction candidateRoot is unavailable')
    }
    try {
      if (typeof transactionFactory !== 'function') throw new TypeError('Invalid plugin transaction factory')
      const allowedRoots = Array.isArray(pluginAllowedRoots) ? pluginAllowedRoots.filter(value => typeof value === 'string') : []
      const adapters = createDesktopPluginTransactionAdapters({
        candidateRoot,
        resolveActiveRelease: resolveActivePluginRelease,
        allowedRoots,
        pnpmEntry: bundledPnpmEntry(),
        execPath: getProcess.execPath,
        env: runtimeEnvironment,
        ...(hiddenChildProcess === undefined ? {} : { hiddenChildProcess }),
        onOutput: (source, text) => writeLog(source, text),
        runPnpmImpl: pluginAdapters.runPnpm ?? runPnpm,
        runGitImpl: pluginAdapters.runGit ?? runGit,
        runCommandImpl: pluginAdapters.runCommand ?? runOwnedCommand,
        engineCompatibilityOverrides: PLUGIN_ENGINE_COMPATIBILITY_OVERRIDES,
        runCandidateRuntimeGate: pluginAdapters.runCandidateRuntimeGate
          ?? runtime.runCandidateRuntimeGate
          ?? runPluginCandidateRuntimeGate,
      })
      pluginTransactionGateAvailable = adapters.candidateGateAvailable === true || runtime.pluginTransactionGateAvailable === true
      const created = transactionFactory({
        ...adapters,
        candidateRoot,
        mode: runtime.pluginTransactionMode ?? 'stable',
        allowedRoots,
        pnpmOptions: { profileDir: candidateRoot },
        gitOptions: { cwd: candidateRoot },
        finalizeCandidate: finalizePluginCandidate,
      })
      if (created === undefined
        || typeof created.transaction !== 'function'
        || typeof created.removePreview !== 'function'
        || typeof created.confirmRemove !== 'function') {
        throw new TypeError('Invalid plugin transaction owner')
      }
      pluginTransactionService = created
      return pluginTransactionService
    } catch (error) {
      pluginTransactionInfrastructureError = releaseError(error, 'Plugin transaction infrastructure is unavailable')
      throw pluginTransactionInfrastructureError
    }
  }

  function pluginTransactionStatus() {
    const activeCandidate = (() => {
      if (!releaseStoreComplete(releaseStateStore, ['readActive'])) return false
      try {
        const active = releaseStateStore.readActive()
        return active?.releaseId !== undefined && active.releaseId !== BOOTSTRAP_RELEASE_ID
      } catch {
        return false
      }
    })()
    if (pluginTransactionInfrastructureError !== undefined) {
      return { available: false, state: 'unavailable', activeCandidate, reason: pluginTransactionInfrastructureError.message }
    }
    if (pendingPluginCandidateId !== undefined) {
      return {
        available: true,
        state: 'candidate-ready',
        activeCandidate,
        pendingCandidateId: pendingPluginCandidateId,
        pendingParentReleaseId: pendingPluginParentReleaseId ?? null,
        reason: 'A verified plugin candidate is waiting for Harness restart.',
      }
    }
    const connectedStatus = () => {
      if (!pluginTransactionGateAvailable) {
        return {
          available: false,
          state: 'gate-pending',
          activeCandidate,
          pendingCandidateId: null,
          reason: 'The compatibility gate is not connected; plugin changes remain disabled to protect the active Harness.',
        }
      }
      return {
        available: true,
        state: 'candidate-only',
        activeCandidate,
        pendingCandidateId: null,
        pendingParentReleaseId: null,
        reason: 'Transactions are staged in a verified candidate release.',
      }
    }
    if (pluginTransactionService !== undefined) return connectedStatus()
    if (typeof candidateRoot !== 'string' || !releaseStoreComplete(releaseStateStore, ['readActive'])) {
      return { available: false, state: 'unavailable', activeCandidate, reason: 'Plugin transaction owner is unavailable.' }
    }
    try {
      const active = releaseStateStore.readActive()
      if (active === undefined || active.releaseId === BOOTSTRAP_RELEASE_ID) {
        return { available: false, state: 'unavailable', activeCandidate, reason: 'No active immutable candidate release is available.' }
      }
    } catch (error) {
      return { available: false, state: 'unavailable', activeCandidate, reason: errorDetail(error) }
    }
    try {
      // Status is the capability handshake used by every renderer before it
      // requests a transaction. Constructing the owner is side-effect free;
      // leaving it lazy until after that handshake creates a deadlock where
      // the renderer can never make the first verified candidate request.
      ensurePluginTransactionService()
      return connectedStatus()
    } catch (error) {
      return {
        available: false,
        state: 'unavailable',
        activeCandidate,
        reason: errorDetail(error),
      }
    }
  }

  async function stopOwnedRelease({ signal } = {}) {
    if (signal?.aborted) throw abortReason(signal)
    if (lifecycleOwner.unsafe === true || modeIsUnsafe()) throw new Error('Owned Harness runtime is unsafe and cannot be stopped for a switch')
    const stopped = await lifecycleOwner.stopAll()
    if (lifecycleOwner.unsafe === true) throw lifecycleOwner.cleanupError ?? new Error('Owned Harness cleanup is unsafe')
    return stopped === undefined ? true : stopped
  }

  async function startOwnedRelease(release, { signal } = {}) {
    if (signal?.aborted) throw abortReason(signal)
    const recipe = release?.recipe
    if (recipe?.mode === 'legacy') {
      return start(copy.restarting, {
        signal,
        runtime: recipe.runtime ?? activeDshRuntime,
        mode: 'legacy',
        provisional: true,
        allowLegacyFallback: false,
      })
    }
    return start(copy.restarting, {
      signal,
      mode: 'stable',
      modeRecipe: recipe,
      provisional: true,
      allowLegacyFallback: false,
    })
  }

  function releaseHealthError(release) {
    const publication = lifecycleOwner.published
    if (publication === undefined
      || !lifecycleOwner.isCurrent(publication.generation)
      || !lifecycleOwner.isPublished(publication.generation, publication.server)) {
      return new Error('Owned Harness lifecycle is not published')
    }
    if (!workspaceReadiness.isReady()) return new Error('Workspace is not ready')
    if (lifecycleOwner.unsafe === true || modeIsUnsafe()) return new Error('Owned Harness runtime reported unsafe cleanup')
    if (release?.recipe?.mode === 'legacy') return undefined
    if (publication.server !== modeSupervisor) return new Error('Stable release is not the published owned runtime')
    const status = modeStatus()
    if (status.active !== 'stable' || status.state !== 'ready' || status.unsafe === true || status.cleanupError !== undefined) {
      return new Error(`Stable release is not healthy (active=${String(status.active)}, state=${String(status.state)})`)
    }
    const reportedReleaseId = status.stable?.status?.releaseId ?? status.releaseId
    if (reportedReleaseId !== undefined && reportedReleaseId !== release.pointer.releaseId) {
      return new Error(`Stable release ${String(reportedReleaseId)} does not match ${release.pointer.releaseId}`)
    }
    return undefined
  }

  async function observeRelease(release, { signal, durationMs = observeDuration } = {}) {
    if (typeof observeReleaseAdapter === 'function') return observeReleaseAdapter(release, { signal, durationMs })
    if (signal?.aborted) throw abortReason(signal)
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) throw new TypeError('Invalid release observation duration')
    if (typeof observePollInterval !== 'number' || !Number.isFinite(observePollInterval) || observePollInterval <= 0) throw new TypeError('Invalid release observation poll interval')

    const check = () => {
      if (signal?.aborted) throw abortReason(signal)
      const failure = releaseHealthError(release)
      if (failure !== undefined) throw failure
    }
    check()
    if (durationMs === 0) return { status: 'healthy', durationMs: 0 }

    return new Promise((resolve, reject) => {
      let timer
      let remaining = durationMs
      let settled = false
      const cleanup = () => {
        if (timer !== undefined) clearTimeoutImpl(timer)
        signal?.removeEventListener?.('abort', onAbort)
        modeSupervisor.removeListener?.('status', onStatus)
      }
      const finish = (error, value) => {
        if (settled) return
        settled = true
        cleanup()
        if (error !== undefined) reject(error)
        else resolve(value)
      }
      const onAbort = () => finish(abortReason(signal))
      const onStatus = () => {
        try { check() } catch (error) { finish(error) }
      }
      const tick = () => {
        try {
          check()
          if (remaining <= 0) {
            finish(undefined, { status: 'healthy', durationMs })
            return
          }
          const delay = Math.min(observePollInterval, remaining)
          remaining -= delay
          timer = setTimeoutImpl(tick, delay)
          timer?.unref?.()
        } catch (error) {
          finish(error)
        }
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      modeSupervisor.on?.('status', onStatus)
      timer = setTimeoutImpl(tick, Math.min(observePollInterval, remaining))
      timer?.unref?.()
      if (signal?.aborted) onAbort()
    })
  }

  async function start(message = copy.preparing, { signal } = {}) {
    const options = arguments[1] ?? {}
    let runtimeOverride = options.runtime
    let provisional = options.provisional === true
    let requested = options.mode
    let modeRecipe = options.modeRecipe
    const restartMode = options.restart === true
    const pluginRecovery = options.pluginRecovery === true
    const pluginRecoveryDetails = options.pluginRecoveryDetails
    const harnessPatches = Array.isArray(options.harnessPatches)
      ? options.harnessPatches.filter(value => typeof value === 'string' && value.length > 0)
      : []
    if (!pluginRecovery) pluginRecoveryAttempted = false
    if (message !== null && typeof message === 'object') {
      signal = message.signal
      runtimeOverride = message.runtime
      provisional = message.provisional === true
      requested = message.mode
      modeRecipe = message.modeRecipe
      message = message.message ?? copy.preparing
    }
    if (signal?.aborted || quitting) return false
    const startupRuntime = runtimeOverride ?? activeDshRuntime
    let startupMode = 'legacy'
    let managedMode = false
    let effectiveModeRecipe
    let persistedStartupResolutionFailed = false
    workspaceReadiness.reset()
    const startedAt = now()
    const generation = lifecycleOwner.begin()
    let nextServer
    let abortListener
    try {
      await lifecycleOwner.stopOlder(generation)
      await recoverManagedDataHome(signal, options[DATA_MIGRATION_OPERATION_OWNER] === true)
      if (signal?.aborted || !lifecycleOwner.isCurrent(generation)) return false
      if (!await showLoading(message, 8, generation)) return false
      if (windows.getWindow('workspace') === undefined) windows.create?.('workspace')
      if (!await updateLoading(copy.loading, 24, 'launching-harness', generation)) return false
      if (signal?.aborted || !lifecycleOwner.isCurrent(generation)) return false

      if (requested === undefined && modeRecipe === undefined && runtimeOverride === undefined) {
        try {
          const persisted = await resolvePersistedStartupRelease({ signal, allowBusyMigration: options[DATA_MIGRATION_OPERATION_OWNER] === true })
          if (persisted !== undefined) {
            requested = persisted.recipe.mode
            modeRecipe = persisted.recipe
          }
        } catch (error) {
          persistedStartupResolutionFailed = true
          throw error
        }
      } else if (requested === undefined && (modeRecipe?.mode === 'stable' || modeRecipe?.mode === 'dev')) {
        requested = modeRecipe.mode
      }

      startupMode = requestedMode({ ...options, mode: requested })
      managedMode = startupMode !== 'legacy'
      effectiveModeRecipe = managedMode
        ? withDesktopHarnessPatch(
          startupMode,
          modeRecipe ?? (startupMode === 'stable' ? configuredStableMode : configuredDevMode),
        )
        : modeRecipe

      if (managedMode) {
        // Stable/dev are owned by one ModeSupervisor. The legacy HarnessServer
        // below is intentionally reachable only through an explicit legacy
        // request or this controller's safe bootstrap fallback.
        nextServer = modeSupervisor
      } else {
        nextServer = serverFactory({
          command: getProcess.execPath,
          args: buildHarnessArgs({
            entry: resolveDsh(startupRuntime),
            parentWatch: resolveParentWatch(),
            hiddenChildProcess,
            patch: resolveHarnessPatch(),
            patches: harnessPatches,
          }),
          cwd: getHomeDirectory(),
          env: {
            ...runtimeEnvironment,
            ELECTRON_RUN_AS_NODE: '1',
            DSH_DESKTOP: '1',
            FORCE_COLOR: '0',
            NO_COLOR: '1',
          },
          onOutput: (() => {
            let receivedOutput = false
            return (source, text) => {
              writeLog(source, text)
              if (receivedOutput) return
              receivedOutput = true
              detached(updateLoading(copy.loadingServices, 56, 'loading-services', generation), 'Startup progress update')
            }
          })(),
        })
      }
      // Cleanup failure belongs to the exact HarnessServer that owns this
      // generation. Latch it on the lifecycle owner before any restart or
      // fallback can publish a replacement tree.
      nextServer.on?.('cleanup-error', event => {
        const cleanupError = event?.cleanupError ?? event?.error
        if (cleanupError !== undefined) lifecycleOwner.markUnsafe?.(cleanupError)
        notifyState()
      })
      if (!lifecycleOwner.attach(generation, nextServer)) {
        try { await nextServer.stop() } catch (error) { lifecycleOwner.markUnsafe?.(error); throw error }
        return false
      }
      abortListener = () => {
        if (nextServer !== undefined) detached(stopHarnessServer(nextServer, generation), 'Aborted Harness startup cleanup')
      }
      if (signal?.aborted) {
        await stopHarnessServer(nextServer, generation)
        return false
      }
      signal?.addEventListener?.('abort', abortListener, { once: true })
      nextServer.on?.('exit', ({ code, signal: exitSignal, ready, output }) => {
        writeLog('desktop', `Harness exited (code=${String(code)}, signal=${String(exitSignal)}).\n`)
        if (ready && lifecycleOwner.isCurrent(generation) && lifecycleOwner.isPublished(generation, nextServer)) {
          if (!pluginRecoveryInFlight) {
            detached(
              recoverUnexpectedHostExit({
                generation,
                target: nextServer,
                code,
                signal: exitSignal,
                output,
                pluginRecovery,
              }),
              'Plugin compatibility recovery',
            )
          }
        }
      })
      const started = managedMode
        ? restartMode && typeof modeSupervisor.restart === 'function'
          ? await modeSupervisor.restart(startupMode, effectiveModeRecipe, { signal, generation })
          : await modeSupervisor.start(startupMode, effectiveModeRecipe, { signal, generation })
        : await nextServer.start()
      const url = normalizeModeReady(started)
      if (signal?.aborted || !lifecycleOwner.isCurrent(generation) || windows.isOpen?.('workspace') !== true) {
        await stopHarnessServer(nextServer, generation)
        return false
      }
      const origin = new URL(url).origin
      if (signal?.aborted || !lifecycleOwner.publish(generation, nextServer, origin)) {
        await stopHarnessServer(nextServer, generation)
        return false
      }
      if (!await updateLoading(copy.openingWorkspace, 82, 'harness-ready', generation)
        || signal?.aborted
        || !lifecycleOwner.isCurrent(generation)
        || !lifecycleOwner.isPublished(generation, nextServer)) {
        await stopHarnessServer(nextServer, generation)
        return false
      }
      if (!await updateLoading(copy.openingWorkspace, 92, 'loading-workspace', generation)
        || signal?.aborted
        || !lifecycleOwner.isCurrent(generation)
        || !lifecycleOwner.isPublished(generation, nextServer)) {
        await stopHarnessServer(nextServer, generation)
        return false
      }
      if (signal?.aborted
        || !lifecycleOwner.isCurrent(generation)
        || !lifecycleOwner.isPublished(generation, nextServer)
        || windows.isOpen?.('workspace') !== true) {
        await stopHarnessServer(nextServer, generation)
        return false
      }
      await windows.loadWorkspace(url)
      if (signal?.aborted || !lifecycleOwner.isCurrent(generation) || !lifecycleOwner.isPublished(generation, nextServer) || windows.isOpen?.('workspace') !== true) {
        await stopHarnessServer(nextServer, generation)
        return false
      }
      if (windows.isOpen?.('management') && windows.managementRendererAvailable?.()) {
        const overviewLoaded = await windows.loadManagementRoute('overview', { lang: getLanguage() }, {
          canContinue: () => generationIsCurrent(generation),
        })
        if (!overviewLoaded || signal?.aborted || !lifecycleOwner.isCurrent(generation) || !lifecycleOwner.isPublished(generation, nextServer)) {
          await stopHarnessServer(nextServer, generation)
          return false
        }
      }
      if (managedMode) {
        await reconcileManagedDoctorService(effectiveModeRecipe, { signal, forceReinstall: provisional || dataHomeWasMigrated })
        dataHomeWasMigrated = false
        if (signal?.aborted || !lifecycleOwner.isCurrent(generation) || !lifecycleOwner.isPublished(generation, nextServer)) {
          await stopHarnessServer(nextServer, generation)
          return false
        }
      }
      if (!await updateLoading(copy.ready, 100, 'complete', generation)
        || signal?.aborted
        || !lifecycleOwner.isCurrent(generation)
        || !lifecycleOwner.isPublished(generation, nextServer)) {
        await stopHarnessServer(nextServer, generation)
        return false
      }
      if (!setStartupState('ready', copy.ready, 100, undefined, generation)
        || signal?.aborted
        || !lifecycleOwner.isCurrent(generation)
        || !lifecycleOwner.isPublished(generation, nextServer)) {
        await stopHarnessServer(nextServer, generation)
        return false
      }
      if (signal?.aborted || !workspaceReadiness.markReady(generation, nextServer)) {
        await stopHarnessServer(nextServer, generation)
        return false
      }
      // Plugin discovery must follow the exact profile owned by the runtime
      // that just became ready. Reading the legacy `web` profile here makes
      // successfully activated candidate plugins appear to have vanished and
      // can trigger duplicate installs on the next onboarding pass.
      publishPluginCatalogLocation(effectiveModeRecipe, managedMode)
      writeLog('desktop', `Startup completed in ${String(Math.round(now() - startedAt))} ms.\n`)
      if (!revealMainWindow(generation, nextServer)) {
        await stopHarnessServer(nextServer, generation)
        return false
      }
      activePluginRecovery = pluginRecovery
        ? Object.freeze({
            reason: typeof pluginRecoveryDetails?.reason === 'string' ? pluginRecoveryDetails.reason : 'automatic',
            rowCount: Number.isInteger(pluginRecoveryDetails?.rowCount) ? pluginRecoveryDetails.rowCount : 0,
            patchPath: typeof pluginRecoveryDetails?.patchPath === 'string' ? pluginRecoveryDetails.patchPath : null,
          })
        : undefined
      notifyState()
      return true
    } catch (error) {
      // Preserve the startup failure before cleanup can mark the lifecycle
      // unsafe and short-circuit the normal error surface. This is especially
      // important on Windows, where a short-lived root process may also make
      // owned-tree cleanup report an identity-loss error.
      writeLog('stderr', `[startup/${startupMode}] ${errorDetail(error)}\n`)
      if (nextServer !== undefined) {
        try { await stopHarnessServer(nextServer, generation) } catch (cleanupError) { reportDetachedFailure('Harness cleanup', cleanupError) }
      }
      if (signal?.aborted || !lifecycleOwner.isCurrent(generation) || lifecycleOwner.unsafe === true) {
        workspaceReadiness.reset()
        return false
      }
      if (!persistedStartupResolutionFailed && !managedMode && !pluginRecovery && !provisional && !pluginRecoveryAttempted) {
        pluginRecoveryAttempted = true
        pluginRecoveryInFlight = true
        try {
          const recovery = await preparePluginRecoveryPatch(startupRuntime, signal)
          if (recovery !== undefined) {
            writeLog('desktop', '[plugin-recovery] Startup failed; retrying once with user plugin rows temporarily disabled.\n')
            const recovered = await start(copy.restarting, {
              signal,
              runtime: startupRuntime,
              mode: 'legacy',
              restart: true,
              provisional: true,
              allowLegacyFallback: false,
              harnessPatches: [recovery.path],
              pluginRecovery: true,
              pluginRecoveryDetails: {
                reason: 'startup-failure',
                rowCount: recovery.rowCount,
                patchPath: recovery.path,
              },
            })
            if (recovered === true) {
              writeLog('desktop', '[plugin-recovery] Harness recovered in compatibility mode.\n')
              return true
            }
          }
        } catch (recoveryError) {
          reportDetachedFailure('Startup plugin compatibility recovery', recoveryError)
        } finally {
          pluginRecoveryInFlight = false
        }
      }
      if (managedMode && !provisional && !modeIsUnsafe() && lifecycleOwner.unsafe !== true && options.allowLegacyFallback !== false) {
        writeLog('desktop', `The ${startupMode} runtime is unavailable; using the explicit legacy bootstrap fallback.\n`)
        try {
          return await start(copy.loading, {
            signal,
            runtime: startupRuntime,
            mode: 'legacy',
            provisional: true,
            allowLegacyFallback: false,
          })
        } catch (fallbackError) {
          reportDetachedFailure('Legacy bootstrap fallback', fallbackError)
        }
      }
      let fallbackToBundled = false
      if (!provisional && !persistedStartupResolutionFailed) {
        try { fallbackToBundled = await dshUpdateController?.useBundledFallback() === true } catch (fallbackError) {
          reportDetachedFailure('DSH bundled fallback', fallbackError)
        }
      }
      if (fallbackToBundled) {
        const failedVersion = activeDshRuntime?.version ?? 'unknown'
        activeDshRuntime = dshUpdateController.runtime
        writeDshUpdaterLog('error', `DSH ${failedVersion} failed to start; falling back to bundled ${activeDshRuntime.version}.`)
        let restored = false
        try { restored = await start(copy.dshRollback, { signal }) } catch (rollbackError) {
          reportDetachedFailure('DSH rollback startup', rollbackError)
        }
        const workspace = windows.getWindow('workspace')
        if (restored && lifecycleOwner.isCurrent(lifecycleOwner.generation) && windows.isOpen?.(workspace)) {
          detached(() => showDialog?.showMessageBox?.(workspace, {
            type: 'warning',
            title: copy.dshRollbackTitle,
            message: copy.dshRollbackMessage(diagnosticStatusText(failedVersion)),
          }), 'DSH rollback dialog')
        }
        return false
      }
      try {
        await showError(copy.startupFailed, error, generation, nextServer)
      } catch (renderError) {
        reportDetachedFailure('Startup failure renderer', renderError)
        try { setStartupState('error', copy.startupFailed, loadingProgress, errorDetail(error), generation) } catch (stateError) {
          reportDetachedFailure('Startup failure status', stateError)
        }
      }
      return false
    } finally {
      if (abortListener !== undefined) signal?.removeEventListener?.('abort', abortListener)
    }
  }

  function restart(label = 'restart', options = {}) {
    if (typeof label !== 'string') {
      options = label ?? {}
      label = options.label ?? 'restart'
    }
    return enqueueHarnessRestart(label, {
      message: options.message ?? copy.restarting,
      signal: options.signal,
      mode: options.mode,
      modeRecipe: options.modeRecipe,
    })
  }

  async function startPluginSafeMode({ signal } = {}) {
    if (signal?.aborted) throw abortReason(signal)
    if (activePluginRecovery !== undefined) {
      return Object.freeze({ recoveryMode: true, restarted: false, rowCount: activePluginRecovery.rowCount })
    }
    const recovery = await preparePluginRecoveryPatch(activeDshRuntime, signal)
    if (recovery === undefined) throw new Error('No installed user plugin rows could be isolated')
    const started = await enqueueHarnessRestart('plugin-safe-mode', {
      message: '正在安全模式中隔离第三方插件…',
      signal,
      harnessPatches: [recovery.path],
      pluginRecovery: true,
      pluginRecoveryDetails: {
        reason: 'manual',
        rowCount: recovery.rowCount,
        patchPath: recovery.path,
      },
    })
    if (started !== true) throw new Error('Harness safe mode did not become ready')
    return Object.freeze({ recoveryMode: true, restarted: true, rowCount: recovery.rowCount })
  }

  async function exitPluginSafeMode({ signal } = {}) {
    if (signal?.aborted) throw abortReason(signal)
    if (activePluginRecovery === undefined) return Object.freeze({ recoveryMode: false, restarted: false })
    const started = await enqueueHarnessRestart('plugin-safe-mode-exit', {
      message: '正在退出插件安全模式并恢复正常插件…',
      signal,
    })
    if (started !== true) throw new Error('Harness did not become ready after leaving plugin safe mode')
    return Object.freeze({ recoveryMode: false, restarted: true })
  }

  function restartPluginChanges(label = 'plugin-restart', options = {}) {
    if (typeof label !== 'string') {
      options = label ?? {}
      label = options.label ?? 'plugin-restart'
    }
    const candidateId = pendingPluginCandidateId
    if (candidateId === undefined) return restart(label, options)
    const parentReleaseId = pendingPluginParentReleaseId
    const manifestSha256 = pendingPluginManifestSha256
    return switchCandidate(candidateId, {
      ...options,
      expectedParentReleaseId: parentReleaseId,
      expectedManifestSha256: manifestSha256,
    }).then(result => {
      if (result?.status !== 'switched' || result?.pointer?.releaseId !== candidateId) {
        throw new Error(`Plugin candidate ${candidateId} was not activated`)
      }
      if (pendingPluginCandidateId === candidateId) {
        clearStagedPluginCandidateState('activated plugin candidate')
        pendingPluginCandidateId = undefined
        pendingPluginParentReleaseId = undefined
        pendingPluginManifestSha256 = undefined
        notifyState()
      }
      return result
    })
  }

  async function abandonPendingPluginCandidate(label = 'failed plugin candidate') {
    const candidateId = pendingPluginCandidateId
    if (candidateId === undefined) return { ok: true, abandoned: false }
    const candidatePath = join(candidateRoot, candidateId)
    let active
    if (releaseStoreComplete(releaseStateStore, ['readActive'])) active = releaseStateStore.readActive()

    // A completed activation may race the caller's error handling. Never
    // remove an active release; only retire its now-obsolete journal record.
    if (active?.releaseId === candidateId) {
      if (active.manifestSha256 !== pendingPluginManifestSha256) {
        throw new Error(`Active plugin candidate ${candidateId} does not match its staged manifest`)
      }
    }

    // Retire the durable hand-off first. If physical cleanup fails, the
    // inactive directory is an auditable orphan, but startup will not retry a
    // known-bad candidate forever.
    clearStagedPluginCandidateState(label)
    pendingPluginCandidateId = undefined
    pendingPluginParentReleaseId = undefined
    pendingPluginManifestSha256 = undefined
    notifyState()
    if (active?.releaseId !== candidateId) {
      const service = ensurePluginTransactionService()
      if (typeof service.discardCandidateRelease !== 'function') {
        throw new Error('Plugin candidate cleanup owner is unavailable')
      }
      try {
        await service.discardCandidateRelease({ candidateId, candidatePath, action: label })
      } catch (error) {
        writeLog('stderr', `[plugin-transaction] Retired ${candidateId} from startup recovery, but its inactive files require later cleanup: ${errorDetail(error)}\n`)
        throw error
      }
    }
    writeLog('desktop', `[plugin-transaction] Retired ${label} ${candidateId}; the active release was preserved.\n`)
    return { ok: true, abandoned: active?.releaseId !== candidateId, candidateId }
  }

  function activePluginReleaseId() {
    if (!releaseStoreComplete(releaseStateStore, ['readActive'])) throw new Error('Plugin transactions require an active release owner')
    const active = releaseStateStore.readActive()
    if (typeof active?.releaseId !== 'string' || !RELEASE_ID_PATTERN.test(active.releaseId) || active.releaseId === BOOTSTRAP_RELEASE_ID) {
      throw new Error('Plugin transactions require an active immutable candidate release')
    }
    return active.releaseId
  }

  function assertNoPendingPluginCandidate() {
    if (pendingPluginCandidateId !== undefined) {
      const error = new Error(`Plugin candidate ${pendingPluginCandidateId} is already waiting for activation`)
      error.code = 'PLUGIN_CANDIDATE_PENDING'
      throw error
    }
  }

  async function stagePendingPluginCandidate(report) {
    const candidateId = report?.candidateId ?? report?.candidate?.id
    if (typeof candidateId !== 'string' || !RELEASE_ID_PATTERN.test(candidateId)) {
      throw new Error('Plugin transaction did not return a valid candidate id')
    }
    const activeReleaseId = activePluginReleaseId()
    const parentReleaseId = report?.parentReleaseId ?? report?.candidate?.parentReleaseId
    if (typeof parentReleaseId !== 'string' || !RELEASE_ID_PATTERN.test(parentReleaseId)) {
      throw new Error('Plugin transaction did not return a valid parent release id')
    }
    if (parentReleaseId !== activeReleaseId) {
      const error = new Error(`Plugin candidate ${candidateId} was built from ${parentReleaseId}, but ${activeReleaseId} is active`)
      error.code = 'PLUGIN_CANDIDATE_PARENT_CHANGED'
      throw error
    }
    if (pendingPluginCandidateId !== undefined && pendingPluginCandidateId !== candidateId) {
      const error = new Error(`Plugin candidate ${pendingPluginCandidateId} is already waiting for activation`)
      error.code = 'PLUGIN_CANDIDATE_PENDING'
      throw error
    }

    const reportedCandidatePath = report?.candidatePath ?? report?.candidate?.path ?? join(candidateRoot, candidateId)
    const candidateIdentity = await canonicalCandidateDirectory(candidateRoot, candidateId, reportedCandidatePath)
    const manifest = await readAndReconcilePluginCandidateManifest({
      manifestPath: join(candidateIdentity.candidateRealPath, 'manifest.json'),
      candidateId,
      parentReleaseId,
      phase: 'staging',
    })
    const manifestSha256 = releaseManifestSha256(manifest)
    const finalizations = Array.isArray(report?.finalization)
      ? report.finalization
      : (report?.finalization === undefined ? [] : [report.finalization])
    for (const finalization of finalizations) {
      const finalizedSha256 = finalization?.manifestSha256
      if (finalizedSha256 !== undefined
        && (typeof finalizedSha256 !== 'string'
          || !MANIFEST_SHA256_PATTERN.test(finalizedSha256)
          || finalizedSha256.toLowerCase() !== manifestSha256)) {
        throw new Error('Plugin candidate manifest changed after finalization')
      }
    }

    const staged = {
      schemaVersion: STAGED_PLUGIN_CANDIDATE_SCHEMA_VERSION,
      candidateId,
      parentReleaseId,
      manifestSha256,
      stagedAt: releaseTimestamp(releaseNow()),
    }
    const persisted = stagedPluginStateStoreComplete()
      ? releaseStateStore.writeStagedPluginCandidate(staged)
      : staged
    pendingPluginCandidateId = persisted.candidateId
    pendingPluginParentReleaseId = persisted.parentReleaseId
    pendingPluginManifestSha256 = persisted.manifestSha256
    notifyState()
  }

  async function stagePluginTransactionReport(service, report, action, signal) {
    const candidateId = report?.candidateId ?? report?.candidate?.id
    const candidatePath = report?.candidatePath ?? report?.candidate?.path
    try {
      if (signal?.aborted) throw abortReason(signal)
      await stagePendingPluginCandidate(report)
      if (signal?.aborted) throw abortReason(signal)
    } catch (error) {
      if (typeof candidateId === 'string' && pendingPluginCandidateId === candidateId) {
        clearStagedPluginCandidateState(`${action} hand-off`)
        pendingPluginCandidateId = undefined
        pendingPluginParentReleaseId = undefined
        pendingPluginManifestSha256 = undefined
        notifyState()
      }
      if (typeof service?.discardCandidateRelease === 'function'
        && typeof candidateId === 'string'
        && RELEASE_ID_PATTERN.test(candidateId)) {
        try {
          await service.discardCandidateRelease({
            candidateId,
            candidatePath: candidatePath ?? join(candidateRoot, candidateId),
            action: `${action}-staging-failed`,
          })
          writeLog('desktop', `[plugin-transaction] Discarded unstaged candidate ${candidateId} after ${action} failed to persist.\n`)
        } catch (cleanupError) {
          try {
            Object.defineProperty(error, 'candidateCleanupError', {
              value: cleanupError,
              configurable: true,
            })
          } catch { /* preserve the staging failure */ }
          writeLog('stderr', `[plugin-transaction] Unable to discard unstaged candidate ${candidateId}: ${errorDetail(cleanupError)}\n`)
        }
      }
      throw error
    }
  }

  function runPluginTransactionOperation(action, { signal } = {}) {
    if (typeof action !== 'function') return Promise.resolve({ ok: false, error: 'Invalid plugin transaction' })
    return operationCoordinator.enqueue('plugin-transaction', async ({ signal: queueSignal }) => {
      const controller = new AbortController()
      const forwardAbort = () => controller.abort(queueSignal.reason)
      if (queueSignal.aborted) controller.abort(queueSignal.reason)
      else queueSignal.addEventListener('abort', forwardAbort, { once: true })
      if (signal?.aborted) controller.abort(signal.reason)
      else signal?.addEventListener?.('abort', forwardAbort, { once: true })
      pluginOperationController = controller
      pluginOperationRunning = true
      notifyState()
      try {
        return await action(ensurePluginTransactionService(), controller.signal)
      } finally {
        queueSignal.removeEventListener('abort', forwardAbort)
        signal?.removeEventListener?.('abort', forwardAbort)
        if (pluginOperationController === controller) pluginOperationController = undefined
        pluginOperationRunning = false
        notifyState()
      }
    }, { signal })
      .catch(error => ({ ok: false, error: errorDetail(error) }))
  }

  function pluginList() {
    return readPluginCatalogIfIdle()
  }

  function pluginDiscover() {
    return pluginOwners.loadPluginCatalog()
  }

  function structuredPluginRequest(request) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError('Plugin transaction request must be a structured object')
    }
    return Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'signal'))
  }

  function pluginTransaction(request, { signal } = {}) {
    return runPluginTransactionOperation(async (service, operationSignal) => {
      assertNoPendingPluginCandidate()
      const report = await service.transaction({ ...structuredPluginRequest(request), signal: operationSignal })
      await stagePluginTransactionReport(service, report, request?.action ?? 'transaction', operationSignal)
      return { ok: true, report }
    }, { signal })
  }

  async function pluginMarketUpdate(request, { signal } = {}) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      return { ok: false, error: 'Invalid managed market update request' }
    }
    const updates = Array.isArray(request.updates) ? request.updates : [request]
    if (updates.length === 0 || updates.length > 256
      || updates.some(update => update === null || typeof update !== 'object' || Array.isArray(update)
        || typeof update.name !== 'string' || typeof update.target !== 'string' || !['npm', 'github'].includes(update.kind))
      || new Set(updates.map(update => update.name)).size !== updates.length) {
      return { ok: false, error: 'Invalid managed market update request' }
    }

    try {
      const release = await resolveActivePluginRelease({ signal })
      const manifestPath = join(release.recipe.profileHome, 'profile', 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const dshVersion = release?.candidate?.manifest?.dsh?.version
      if (typeof dshVersion !== 'string') throw new Error('Active managed release has no verified DSH version')
      const enabledBundles = updates.length > 1 ? new Set(pluginBundleOrder(manifest)) : undefined
      const batchSources = []
      const buildPermissions = {}
      const skipped = []
      for (const { name, kind, target } of updates) {
        const current = manifest?.dependencies?.[name]
        if (typeof current !== 'string') throw new Error(`Plugin ${name} is not installed in the active managed profile`)

        let source
        if (kind === 'npm') {
          const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i
          const isBundledDoctor = name === DSH_DOCTOR_PACKAGE && DSH_DOCTOR_LOCAL_SPEC_PATTERN.test(current)
          if (!exactVersion.test(current) && !isBundledDoctor) {
            throw new Error(`Plugin ${name} is not registry-managed and cannot use an npm market update`)
          }
          if (!exactVersion.test(target)) throw new Error(`Plugin ${name} market target is not an exact semantic version`)
          const metadata = await inspectMarketPluginMetadata({ name, target, signal })
          const engineCheck = inspectPluginDshEngine({
            name,
            pluginVersion: metadata?.pluginVersion,
            requiredRange: metadata?.requiredRange,
            dshVersion,
            engineCompatibilityOverrides: PLUGIN_ENGINE_COMPATIBILITY_OVERRIDES,
          })
          if (engineCheck.status === 'invalid' || engineCheck.status === 'incompatible') {
            const skippedEntry = Object.freeze({
              name,
              target,
              status: engineCheck.status,
              reason: engineCheck.message,
            })
            skipped.push(skippedEntry)
            writeLog('desktop', `[plugin-compatibility] Skipped market update ${name}@${target}: ${engineCheck.message}\n`)
            continue
          }
          source = { type: 'npm', package: name, versionOrTag: target }
        } else {
          const match = /^github:([^/]+\/[^#]+)#[a-f0-9]{40}(?:&path:(\/.*))?$/i.exec(current)
          if (match === null || !/^[a-f0-9]{40}$/i.test(target)) {
            throw new Error(`Plugin ${name} is not pinned to a managed GitHub source`)
          }
          source = {
            type: 'github',
            repository: match[1],
            ref: target,
            ...(match[2] === undefined ? {} : { path: match[2] }),
          }
        }
        batchSources.push({ name, source, ...(enabledBundles === undefined ? {} : { enabled: enabledBundles.has(name) }) })
        // An explicit market install/update is authorization for that exact
        // package's lifecycle script inside the disposable candidate. No
        // unrelated dependency receives a build grant, and activation still
        // requires compatibility plus isolated runtime verification.
        buildPermissions[name] = true
        if (name === DSH_DOCTOR_PACKAGE) Object.assign(buildPermissions, DSH_DOCTOR_BUILD_PERMISSIONS)
      }

      if (batchSources.length === 0) {
        throw new Error(`No compatible plugin update can run on DSH ${dshVersion}: ${skipped.map(entry => entry.reason).join('; ')}`)
      }
      const attachSkipped = result => skipped.length === 0
        ? result
        : {
            ...result,
            report: {
              ...(result?.report ?? {}),
              skipped,
            },
          }
      if (batchSources.length > 1) {
        return attachSkipped(await pluginInstallMany({
          sources: batchSources,
          ...(Object.keys(buildPermissions).length > 0 ? { buildPermissions } : {}),
        }, { signal }))
      }
      const [{ name, source }] = batchSources
      return attachSkipped(await pluginTransaction({
        action: 'update',
        name,
        source,
        ...(Object.keys(buildPermissions).length > 0 ? { buildPermissions } : {}),
      }, { signal }))
    } catch (error) {
      return { ok: false, error: errorDetail(error) }
    }
  }

  async function pluginMarketInstall(request, { signal } = {}) {
    if (request === null || typeof request !== 'object' || Array.isArray(request) || typeof request.url !== 'string') {
      return { ok: false, error: 'Invalid managed market install request' }
    }

    try {
      let catalog
      try { const discovered = await pluginOwners.loadPluginCatalog({ signal }); catalog = discovered?.catalog ?? discovered } catch (error) {
        if (signal?.aborted) throw error
        writeLog('desktop', '[plugin-install] Catalog unavailable; resolving the selected source directly.\n')
      }
      let requestedUrl
      try { requestedUrl = normalizePluginSourceUrl(request.url) } catch { /* npm source */ }
      const entry = (catalog?.plugins ?? []).find(item => {
        try { return requestedUrl !== undefined && normalizePluginSourceUrl(item.url) === requestedUrl } catch { return false }
      })
      // A registry entry is a discovery hint. GitHub identity always comes
      // from package.json at the exact selected commit, never the repo name.
      const selected = entry?.source === 'npm'
        ? { packageName: entry.npm, source: { type: 'npm', package: entry.npm } }
        : await (pluginOwners.resolveMarketSource ?? resolveMarketSource)(request.url, {
            signal, fetchImpl: net?.fetch ? net.fetch.bind(net) : globalThis.fetch,
          })
      const { packageName, source } = selected

      const release = await resolveActivePluginRelease({ signal })
      const manifest = JSON.parse(await readFile(join(release.recipe.profileHome, 'profile', 'package.json'), 'utf8'))
      if (typeof manifest?.dependencies?.[packageName] === 'string') throw new Error(`Plugin ${packageName} is already installed`)

      // The click is explicit user authorization for this selected source.
      // Its scripts still execute only inside the disposable candidate, and
      // the runtime/compatibility gates must pass before activation.
      return pluginInstallMany({
        sources: [{ name: packageName, source }],
        buildPermissions: {
          [packageName]: true,
          ...(packageName === DSH_DOCTOR_PACKAGE ? DSH_DOCTOR_BUILD_PERMISSIONS : {}),
        },
      }, { signal })
    } catch (error) {
      return { ok: false, error: errorDetail(error) }
    }
  }

  function repairActiveCompatibility({ signal, activate = true, label = 'startup-compatibility-repair' } = {}) {
    if (compatibilityRepairPromise !== undefined) return compatibilityRepairPromise
    const repair = (async () => {
      if (signal?.aborted) throw abortReason(signal)
      if (quitting) return { ok: false, repaired: false, error: 'Desktop shutdown is in progress' }
      if (!ensureReleaseOwners() || !releaseStoreComplete(releaseStateStore, ['readActive'])) {
        return { ok: true, repaired: false, reason: 'release-state-unavailable' }
      }
      if (pendingPluginCandidateId !== undefined) {
        return { ok: false, repaired: false, pendingCandidateId: pendingPluginCandidateId, error: 'A plugin candidate is already waiting for activation' }
      }

      const active = releaseStateStore.readActive()
      if (active === undefined || active.releaseId === BOOTSTRAP_RELEASE_ID) {
        return { ok: true, repaired: false, reason: 'bootstrap-release' }
      }
      // The active pointer already refers to a previously verified immutable
      // release. Match normal startup here: verify its canonical manifest,
      // profile receipts, descriptor and persisted inventory, then inspect only
      // the compatibility recipe targets. The new child still receives the
      // complete runtime inventory verification before activation.
      const release = await resolveCandidateRelease(active.releaseId, {
        signal,
        verifyRuntime: false,
        writePluginCompatibility: false,
      })
      if (release?.pointer?.manifestSha256 !== active.manifestSha256) {
        throw new Error(`Persisted active release ${active.releaseId} does not match its verified manifest`)
      }
      const version = release?.candidate?.runtime?.version
      let runtimeTargets = []
      if (compatibilityRecipeForVersion(version)) {
        const audit = await compatibilityRecipeApplier({
          root: release.candidate.runtime.directory,
          recipe: compatibilityRecipeForVersion(version),
          dshVersion: version,
          write: false,
          signal,
        })
        runtimeTargets = audit.targets
          .filter(target => target.state === 'patched')
          .map(target => ({ id: target.id }))
      }
      const pluginTargets = (release.pluginCompatibility?.checks ?? [])
        .filter(compatibility => compatibility?.state === 'patched')
        .flatMap(compatibility => {
          const packageName = typeof compatibility.packageName === 'string' && compatibility.packageName.length > 0
            ? compatibility.packageName
            : 'unknown-plugin'
          const patchedTargets = Array.isArray(compatibility.targets)
            ? compatibility.targets.filter(target => target?.state === 'patched')
            : []
          return (patchedTargets.length > 0 ? patchedTargets : [{ id: 'runtime' }])
            .map(target => ({ id: `plugin:${packageName}:${String(target.id ?? 'runtime')}` }))
        })
      const targets = [...runtimeTargets, ...pluginTargets]
      if (targets.length === 0) {
        return {
          ok: true,
          repaired: false,
          releaseId: active.releaseId,
          reason: compatibilityRecipeForVersion(version) ? 'already-compatible' : 'recipe-not-applicable',
        }
      }

      const profile = JSON.parse(await readFile(join(release.recipe.profileHome, 'profile', 'package.json'), 'utf8'))
      const order = pluginBundleOrder(profile)
      writeLog('desktop', `[compatibility-repair] Migrating active release ${active.releaseId} through a verified immutable child for ${targets.map(target => target.id).join(', ')}.\n`)
      const staged = await pluginTransaction({ action: 'reorder', order }, { signal })
      if (staged?.ok !== true) {
        return { ok: false, repaired: false, releaseId: active.releaseId, error: staged?.error ?? 'Compatibility repair candidate could not be staged' }
      }
      const candidateId = staged.report?.candidateId ?? staged.report?.candidate?.id
      if (!activate) return { ok: true, repaired: false, staged: true, releaseId: active.releaseId, candidateId, targets: targets.map(target => target.id) }

      const switched = await restartPluginChanges(label, { signal })
      if (switched?.status !== 'switched' || switched?.pointer?.releaseId !== candidateId) {
        throw new Error(`Compatibility repair candidate ${String(candidateId ?? '<missing>')} was not activated`)
      }
      writeLog('desktop', `[compatibility-repair] Activated compatible release ${candidateId} from ${active.releaseId}.\n`)
      return { ok: true, repaired: true, releaseId: candidateId, parentReleaseId: active.releaseId, targets: targets.map(target => target.id) }
    })()
    compatibilityRepairPromise = repair.finally(() => { compatibilityRepairPromise = undefined })
    return compatibilityRepairPromise
  }

  function pluginInstallMany(request, { signal, onProgress } = {}) {
    return runPluginTransactionOperation(async (service, operationSignal) => {
      assertNoPendingPluginCandidate()
      const report = await service.installMany({
        ...structuredPluginRequest(request),
        signal: operationSignal,
        onProgress: typeof onProgress === 'function' ? onProgress : undefined,
      })
      await stagePluginTransactionReport(service, report, 'installMany', operationSignal)
      return { ok: true, report }
    }, { signal })
  }

  function pluginRemovePreview(request, { signal } = {}) {
    return runPluginTransactionOperation(async (service, operationSignal) => ({
      ok: true,
      preview: await service.removePreview({ ...structuredPluginRequest(request), signal: operationSignal }),
    }), { signal })
  }

  function pluginConfirmRemove(request, { signal } = {}) {
    return runPluginTransactionOperation(async (service, operationSignal) => {
      assertNoPendingPluginCandidate()
      const report = await service.confirmRemove({ ...structuredPluginRequest(request), signal: operationSignal })
      await stagePluginTransactionReport(service, report, 'remove', operationSignal)
      return { ok: true, report }
    }, { signal })
  }

  function legacyPluginMutationDisabled() {
    return Promise.resolve({
      ok: false,
      error: 'Legacy live-profile plugin mutation is disabled; use the structured candidate transaction API.',
    })
  }

  function pluginInstall() {
    return legacyPluginMutationDisabled()
  }

  function pluginEnabled() {
    return legacyPluginMutationDisabled()
  }

  function pluginUpdate() {
    return legacyPluginMutationDisabled()
  }

  function pluginRemove() {
    return legacyPluginMutationDisabled()
  }

  async function installDefaultPlugins() {
    if (activeHome === undefined) return undefined
    writeLog('desktop', '[candidate-only] Default live-profile plugin installation is disabled; use the structured candidate transaction API.\n')
    return false
  }

  async function prepareBundledPluginsTransaction() {
    if (activeHome === undefined || quitting) return false
    writeLog('desktop', '[candidate-only] Bundled live-profile plugin preparation is disabled; use a candidate release.\n')
    return false
  }

  function prepareBundledPlugins() {
    if (activeHome === undefined || quitting) return Promise.resolve(false)
    writeLog('desktop', '[candidate-only] Bundled live-profile plugin preparation is disabled; use a candidate release.\n')
    return Promise.resolve(false)
  }

  function resetWorkspace() {
    return workspaceReadiness.reset()
  }

  function getUpdateStatus() {
    const controller = dshUpdateController
    const combined = dualUpdates?.snapshot().dsh
    return sanitizeDiagnosticValue({
      state: combined?.state ?? controller?.state ?? 'unavailable',
      currentVersion: activeDshRuntime?.version ?? controller?.runtime?.version ?? null,
      available: controller !== undefined,
      latestVersion: combined?.targetVersion ?? dshUpdateProbeResult?.latestVersion ?? null,
      updateAvailable: combined?.hasUpdate ?? dshUpdateProbeResult?.available === true,
      busy: combined ? ['checking', 'updating'].includes(combined.state) : controller?.busy ?? false,
      checkAvailable: controller?.checkAvailable ?? false,
      managedRestoreAvailable: managedDataHome === undefined && (controller?.managedRestoreAvailable ?? false),
      restoreAvailable: managedDataHome === undefined && (controller?.restoreAvailable ?? false),
    })
  }

  function checkDshUpdateAvailability(options = {}) {
    if (dshUpdateController === undefined || typeof dshUpdateController.probe !== 'function') {
      return Promise.resolve({
        available: false,
        currentVersion: activeDshRuntime?.version ?? null,
        latestVersion: null,
      })
    }
    return dshUpdateController.probe(options).then(result => {
      dshUpdateProbeResult = result
      notifyState()
      return result
    })
  }

  async function checkDshUpdate(manual = false, options = {}) {
    const result = await checkDshUpdateAvailability(options)
    if (!manual) return result
    const workspace = windows.getWindow('management') ?? windows.getWindow('workspace')
    const chinese = String(getLanguage()).toLowerCase().startsWith('zh')
    if (result?.busy === true) {
      await showDialog?.showMessageBox?.(workspace, {
        type: 'info',
        title: chinese ? 'DSH 更新检测正在等待' : 'DSH Update Check Is Waiting',
        message: chinese ? '当前有另一项桌面操作正在进行，请稍后再试。' : 'Another desktop operation is currently running. Please try again shortly.',
      })
      return result
    }
    if (typeof result?.error === 'string' && result.error !== '') {
      await showDialog?.showMessageBox?.(workspace, {
        type: 'error',
        title: chinese ? 'DSH 更新检测失败' : 'DSH Update Check Failed',
        message: result.error,
      })
      return result
    }
    if (result?.available !== true) {
      await showDialog?.showMessageBox?.(workspace, {
        type: 'info',
        title: chinese ? 'DSH 已是最新版本' : 'DSH Is Up to Date',
        message: chinese
          ? `当前版本 ${result?.currentVersion ?? activeDshRuntime?.version ?? '未知'} 已是最新版本。`
          : `Version ${result?.currentVersion ?? activeDshRuntime?.version ?? 'unknown'} is current.`,
      })
      return result
    }
    const response = await showDialog?.showMessageBox?.(workspace, {
      type: 'info',
      title: chinese ? '发现 DSH 更新' : 'DSH Update Available',
      message: chinese ? `可更新到 DSH ${result.latestVersion}。` : `DSH ${result.latestVersion} is available.`,
      detail: chinese
        ? '将先创建并验证配对候选版本；只有候选通过运行时检查后才允许切换，失败会保留当前版本。'
        : 'The Desktop will prepare and verify a paired candidate before switching. A failed candidate leaves the current version untouched.',
      buttons: chinese ? ['准备候选版本', '稍后'] : ['Prepare Candidate', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (response?.response !== 0) return result
    return prepareCandidate(result.channel === 'next' ? 'next' : 'stable', options)
  }

  function getDesktopUpdateStatus() {
    const controller = installerUpdateController
    const current = controller?.snapshot?.()
    return sanitizeDiagnosticValue({
      state: current?.state ?? controller?.state ?? 'unavailable',
      currentVersion: appVersion(),
      available: controller !== undefined,
      releaseSourceConfigured: controller?.releaseSourceConfigured ?? false,
      supported: controller?.supported ?? false,
      externalReleaseAvailable: controller?.externalReleaseAvailable ?? false,
      busy: current ? ['checking', 'downloading', 'opening'].includes(current.state) : controller?.busy ?? false,
      checkAvailable: current ? !['checking', 'downloading', 'opening'].includes(current.state) : controller?.checkAvailable ?? false,
      progress: current?.progress ?? controller?.progress ?? 0,
      downloaded: controller?.downloadedPath !== undefined,
      targetVersion: current?.targetVersion ?? (controller !== undefined && ['available', 'downloading', 'downloaded'].includes(controller.state)
        ? controller.targetVersion ?? null
        : null),
    })
  }

  function getPluginStatus() {
    let installed = null
    if (activeHome !== undefined) {
      try { installed = readPluginCatalogIfIdle({ swallow: true })?.plugins?.length ?? null } catch { installed = null }
    }
    // Resolve the release owner before exposing activeCandidate. Without this
    // read-only initialization, the first status snapshot would report an
    // already-active immutable candidate as bootstrap simply because the
    // state store had not been constructed yet.
    ensureReleaseOwners()
    const transaction = pluginTransactionStatus()
    return {
      state: activeHome === undefined ? 'unavailable' : 'available',
      available: activeHome !== undefined,
      busy: operationCoordinator.busy || pluginOperationRunning,
      installed,
      catalogAvailable: activeHome !== undefined,
      transactionAvailable: transaction.available,
      transactionState: transaction.state,
      transactionReason: transaction.reason,
      activeCandidate: transaction.activeCandidate === true,
      pendingCandidateId: transaction.pendingCandidateId ?? null,
      restartRequired: transaction.pendingCandidateId !== null && transaction.pendingCandidateId !== undefined,
      recoveryAvailable: activeHome !== undefined,
      recoveryMode: activePluginRecovery !== undefined,
      recoveryRows: activePluginRecovery?.rowCount ?? 0,
      recoveryReason: activePluginRecovery?.reason ?? null,
      compatibilityWarnings: [...pluginCompatibilityWarnings.values()].filter(warning => warning.releaseId === releaseStateStore?.readActive?.()?.releaseId),
    }
  }

  function statusSnapshot() {
    const runtimeModeStatus = modeStatus()
    return sanitizeDiagnosticValue({
      server: server === undefined ? undefined : { generation: publishedGeneration, origin: harnessOrigin },
      harnessOrigin,
      startup: {
        phase: startupPhase,
        progress: normalizeProgress(loadingProgress),
        message: startupMessage,
        error: startupError,
      },
      runtime: activeDshRuntime,
      mode: runtimeModeStatus,
      modeSupervisor: runtimeModeStatus,
      workspace: {
        ready: workspaceReadiness.isReady(),
        origin: harnessOrigin,
      },
      lifecycle: {
        generation: lifecycleOwner.generation,
        unsafe: lifecycleOwner.unsafe === true,
        cleanupError: lifecycleOwner.cleanupError,
      },
      data: {
        state: managedDataRecoveryPending ? 'unavailable' : managedDataHome !== undefined ? 'independent' : dataRoot === undefined ? 'unavailable' : 'candidate',
        home: managedDataHome ?? null,
      },
      update: getUpdateStatus(),
      desktopUpdate: getDesktopUpdateStatus(),
      plugins: getPluginStatus(),
      release: releaseStatus(),
      snapshots: snapshotStatus(),
      candidate: getCandidateStatus(),
      operationBusy: operationCoordinator.busy,
      operation: {
        busy: operationCoordinator.busy,
        active: operationCoordinator.active,
        queued: operationCoordinator.queued,
      },
      quitting,
    })
  }

  function shutdown(reason = new Error('Desktop shutdown')) {
    if (shutdownPromise !== undefined) return shutdownPromise
    quitting = true
    dualUpdates?.stop()
    workspaceReadiness.reset()
    lifecycleOwner.invalidate()
    clearTimers()
    const drain = operationCoordinator.close(reason)
    pluginOperationController?.abort(reason)
    installerUpdateController?.abort()
    dshUpdateController?.abort()
    const stopServer = lifecycleOwner.stopAll()
    const publishedModeOwner = lifecycleOwner.published?.server === modeSupervisor
    const stopMode = publishedModeOwner
      ? Promise.resolve()
      : Promise.resolve().then(() => modeSupervisor.stop(reason))
    shutdownPromise = Promise.allSettled([drain, stopServer, stopMode]).then(async () => {
      try {
        await releaseOwnership?.release()
      } catch (error) {
        writeLog('stderr', `[release/ownership] Unable to release the desktop ownership lease: ${errorDetail(error)}\n`)
      }
    })
    return shutdownPromise
  }

  ensureReleaseOwners()

  return Object.freeze({
    initializeUpdates,
    prepareBundledPlugins,
    start,
    restart,
    installDefaultPlugins,
    ensureDefaultPlugins: installDefaultPlugins,
    pluginList,
    pluginDiscover,
    pluginTransaction,
    pluginMarketInstall,
    pluginMarketUpdate,
    pluginInstallMany,
    getActiveSettingsPath,
    repairActiveCompatibility,
    restartPluginChanges,
    startPluginSafeMode,
    exitPluginSafeMode,
    abandonPendingPluginCandidate,
    pluginRemovePreview,
    pluginConfirmRemove,
    pluginInstall,
    installPlugin: pluginInstall,
    pluginEnabled,
    setPluginEnabled: pluginEnabled,
    pluginUpdate,
    updatePlugin: pluginUpdate,
    pluginRemove,
    removePlugin: pluginRemove,
    checkDesktopUpdate: enqueueDesktopUpdate,
    getUpdates: () => ensureDualUpdates().snapshot(),
    checkUpdates: () => ensureDualUpdates().check(),
    executeUpdates: request => ensureDualUpdates().execute(request),
    checkDshUpdate,
    checkDshUpdateAvailability,
    prepareCandidate,
    switchCandidate,
    listSnapshots,
    createSnapshot,
    restoreSnapshot,
    recoverPendingRelease,
    getCandidateStatus,
    getSnapshotStatus: snapshotStatus,
    getReleaseStatus: releaseStatus,
    restoreDsh: (options = {}) => {
      if (activeRoot !== undefined && readManagedDataHome(activeRoot) !== undefined) {
        return Promise.reject(new Error('独立数据目录已启用，请使用“回退程序版本”，不要切回旧版引导目录。'))
      }
      return enqueueDshOperation('restore', signal => dshUpdateController?.restoreBundled({ signal }), options)
    },
    getUpdateAdapters,
    updateAdapters: getUpdateAdapters,
    getUpdateStatus,
    getDesktopUpdateStatus,
    getHarnessOrigin: () => harnessOrigin,
    isWorkspaceReady: () => workspaceReadiness.isReady(),
    resetWorkspace,
    statusSnapshot,
    getStatusSnapshot: statusSnapshot,
    shutdown,
    drain: () => operationCoordinator.drain(),
    abort: reason => operationCoordinator.abortAll(reason),
    isQuitting: () => quitting,
    get lifecycleOwner() { return lifecycleOwner },
    get workspaceReadiness() { return workspaceReadiness },
    get operationCoordinator() { return operationCoordinator },
  })
}
