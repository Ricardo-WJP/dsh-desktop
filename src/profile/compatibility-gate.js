import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import semver from 'semver'

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,127}\/)?[a-z0-9][a-z0-9._-]{0,127}$/i
const CORE_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
const HOST_EXPORT_CONDITIONS = new Set(['node', 'node-addons', 'import', 'module-sync'])
const CLIENT_EXPORT_CONDITIONS = new Set(['browser', 'import', 'module-sync'])

function inside(root, target) {
  const remainder = relative(resolve(root), resolve(target))
  return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder))
}

async function readJson(path, label) {
  const value = JSON.parse(await readFile(path, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

async function packageFileStatus(packageRoot, path) {
  try {
    if (!(await stat(path)).isFile()) return 'missing'
    const [realPackageRoot, realTarget] = await Promise.all([realpath(packageRoot), realpath(path)])
    return inside(realPackageRoot, realTarget) ? 'file' : 'outside'
  } catch {
    return 'missing'
  }
}

function exportEntry(value, conditions, depth = 0) {
  if (depth > 8) return undefined
  if (value === null) return null
  if (typeof value === 'string' && value.trim() !== '') return value
  if (Array.isArray(value)) {
    let fallback
    for (const candidate of value) {
      const entry = exportEntry(candidate, conditions, depth + 1)
      if (entry !== undefined && entry !== null) return entry
      if (entry === null) fallback = null
    }
    return fallback
  }
  if (value === null || typeof value !== 'object') return undefined
  // Conditions are selected in declaration order, as for Node's host import
  // and the browser client. A selected null target must not fall through.
  for (const [condition, target] of Object.entries(value)) {
    if (condition !== 'default' && !conditions.has(condition)) continue
    const entry = exportEntry(target, conditions, depth + 1)
    if (entry !== undefined) return entry
  }
  return undefined
}

function packageEntry(meta) {
  if (meta.exports !== undefined) {
    const exports = meta.exports
    const isSubpathMap = exports !== null && typeof exports === 'object'
      && !Array.isArray(exports) && Object.keys(exports).some(key => key.startsWith('.'))
    return exportEntry(isSubpathMap ? exports['.'] : exports, HOST_EXPORT_CONDITIONS)
  }
  if (typeof meta.main === 'string' && meta.main.trim() !== '') return meta.main
  return undefined
}

function packageFilePath(packageRoot, entry) {
  if (typeof entry !== 'string') return undefined
  const value = entry.trim()
  if (value === '' || value.includes('\0') || isAbsolute(value)) return undefined
  const target = resolve(packageRoot, value)
  return inside(packageRoot, target) ? target : undefined
}

function collectClientEntries(meta) {
  const result = []
  const client = meta.dsh?.client
  if (client && typeof client === 'object') {
    for (const key of ['entry', 'script', 'path']) if (typeof client[key] === 'string') result.push(client[key])
  }
  const exports = meta.exports
  if (exports && typeof exports === 'object') {
    const exportedClient = exportEntry(exports['./client'], CLIENT_EXPORT_CONDITIONS)
    if (typeof exportedClient === 'string') result.push(exportedClient)
  }
  return [...new Set(result)]
}

function moduleLoaderKeys(text) {
  const keys = []
  const pattern = /ModuleLoader\.load\(\s*["'`]([^"'`]+)["'`]/g
  for (const match of text.matchAll(pattern)) keys.push(match[1])
  return keys
}

function duplicate(values) {
  const seen = new Set()
  const duplicates = new Set()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates]
}

function normalizeEngineOverrides(value) {
  if (!Array.isArray(value)) throw new TypeError('Plugin engine compatibility overrides must be an array')
  return value.map((override, index) => {
    if (override === null || typeof override !== 'object' || Array.isArray(override)) {
      throw new TypeError(`Plugin engine compatibility override ${index} must be an object`)
    }
    const { name, pluginVersion, dshVersion, requiredRange, reason } = override
    if (typeof name !== 'string' || !PACKAGE_NAME.test(name)
      || semver.valid(pluginVersion) !== pluginVersion
      || semver.valid(dshVersion) !== dshVersion
      || typeof requiredRange !== 'string' || semver.validRange(requiredRange, { includePrerelease: true }) === null
      || typeof reason !== 'string' || reason.trim() === '') {
      throw new TypeError(`Plugin engine compatibility override ${index} is invalid`)
    }
    return Object.freeze({ name, pluginVersion, dshVersion, requiredRange, reason: reason.trim() })
  })
}

function engineOverrideFor(overrides, { name, pluginVersion, dshVersion, requiredRange }) {
  return overrides.find(override => override.name === name
    && override.pluginVersion === pluginVersion
    && override.dshVersion === dshVersion
    && override.requiredRange === requiredRange)
}

export function inspectPluginDshEngine({
  name,
  pluginVersion,
  requiredRange,
  dshVersion,
  engineCompatibilityOverrides = [],
} = {}) {
  if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) throw new TypeError('Plugin engine check requires a valid package name')
  if (semver.valid(dshVersion) !== dshVersion) throw new TypeError('Plugin engine check requires an exact candidate DSH version')
  const overrides = normalizeEngineOverrides(engineCompatibilityOverrides)
  if (requiredRange === undefined) {
    return Object.freeze({ name, pluginVersion: pluginVersion ?? null, requiredRange: null, dshVersion, status: 'unspecified' })
  }
  if (semver.valid(pluginVersion) !== pluginVersion) {
    return Object.freeze({
      name,
      pluginVersion: pluginVersion ?? null,
      requiredRange: typeof requiredRange === 'string' ? requiredRange : String(requiredRange),
      dshVersion,
      status: 'invalid',
      message: `${name}@${String(pluginVersion ?? '<unknown>')}: package version is not an exact semantic version`,
    })
  }
  const validRange = typeof requiredRange === 'string'
    ? semver.validRange(requiredRange, { includePrerelease: true })
    : null
  if (validRange === null) {
    return Object.freeze({
      name,
      pluginVersion,
      requiredRange: typeof requiredRange === 'string' ? requiredRange : String(requiredRange),
      dshVersion,
      status: 'invalid',
      message: `${name}@${pluginVersion}: invalid dsh.engines.dsh range (${String(requiredRange)})`,
    })
  }
  if (semver.satisfies(dshVersion, validRange, { includePrerelease: true })) {
    return Object.freeze({ name, pluginVersion, requiredRange, dshVersion, status: 'compatible' })
  }
  const override = engineOverrideFor(overrides, { name, pluginVersion, dshVersion, requiredRange })
  if (override !== undefined) {
    return Object.freeze({
      name,
      pluginVersion,
      requiredRange,
      dshVersion,
      status: 'audited-override',
      reason: override.reason,
    })
  }
  return Object.freeze({
    name,
    pluginVersion,
    requiredRange,
    dshVersion,
    status: 'incompatible',
    message: `${name}@${pluginVersion} requires DSH ${requiredRange} but candidate runtime is ${dshVersion}`,
  })
}

/**
 * Static candidate gate. It is intentionally offline: the release switcher
 * performs the real DSH boot/HTTP observation after this receipt is issued.
 * A malformed candidate is rejected before it can become active.
 */
export async function inspectCandidateProfile({
  profilePath,
  nodeModulesPath,
  platform = process.platform,
  dshVersion,
  engineCompatibilityOverrides = [],
} = {}) {
  if (typeof profilePath !== 'string' || !profilePath.trim()) throw new TypeError('Candidate profile path is required')
  if (dshVersion !== undefined && semver.valid(dshVersion) !== dshVersion) throw new TypeError('Candidate DSH version must be an exact semantic version')
  normalizeEngineOverrides(engineCompatibilityOverrides)
  const root = resolve(profilePath)
  const dependencyRoot = nodeModulesPath === undefined ? join(root, 'node_modules') : resolve(nodeModulesPath)
  const manifestPath = join(root, 'package.json')
  const manifest = await readJson(manifestPath, 'Candidate package manifest')
  const bundleNames = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundleNames) || bundleNames.some(name => typeof name !== 'string' || !PACKAGE_NAME.test(name))) {
    const error = new Error('Candidate profile must declare a valid dsh.profile.bundles list')
    error.code = 'CANDIDATE_COMPATIBILITY_FAILED'
    throw error
  }
  const uniqueBundles = [...new Set(bundleNames)]
  if (uniqueBundles.length !== bundleNames.length) {
    const error = new Error('Candidate profile contains duplicate bundles')
    error.code = 'CANDIDATE_COMPATIBILITY_FAILED'
    throw error
  }

  const errors = []
  const warnings = []
  const loaderKeys = []
  const checked = []
  const engineChecks = []
  for (const name of uniqueBundles) {
    if (CORE_BUNDLES.has(name)) {
      checked.push(`${name}:core-runtime`)
      continue
    }
    const packageRoot = join(dependencyRoot, name)
    if (!inside(dependencyRoot, packageRoot)) throw new Error(`Plugin path escapes candidate dependencies: ${name}`)
    let meta
    try {
      meta = await readJson(join(packageRoot, 'package.json'), `${name} package manifest`)
    } catch (error) {
      errors.push(`${name}: package.json is missing or invalid (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    if (meta.name !== name) errors.push(`${name}: package manifest identity is ${String(meta.name ?? '<missing>')}`)
    const requiredDshRange = meta.dsh?.engines?.dsh
    if (requiredDshRange !== undefined) {
      if (dshVersion === undefined) {
        errors.push(`${name}@${String(meta.version ?? '<unknown>')}: candidate DSH version is unavailable for engine check (${requiredDshRange})`)
      } else {
        const engineCheck = inspectPluginDshEngine({
          name,
          pluginVersion: meta.version,
          dshVersion,
          requiredRange: requiredDshRange,
          engineCompatibilityOverrides,
        })
        if (engineCheck.status === 'invalid' || engineCheck.status === 'incompatible') errors.push(engineCheck.message)
        else engineChecks.push(engineCheck)
      }
    }
    const entry = packageEntry(meta)
    const entryPath = packageFilePath(packageRoot, entry)
    if (typeof entry !== 'string' || entry.trim() === '') {
      errors.push(`${name}: package entry is not declared`)
    } else if (entryPath === undefined) {
      errors.push(`${name}: package entry escapes package root (${entry})`)
    } else {
      const status = await packageFileStatus(packageRoot, entryPath)
      if (status === 'outside') errors.push(`${name}: package entry resolves outside package root (${entry})`)
      else if (status !== 'file') errors.push(`${name}: package entry does not exist (${entry})`)
    }
    const patch = meta.dsh?.bundle?.patch
    if (typeof patch === 'string') {
      const patchPath = packageFilePath(packageRoot, patch)
      if (patchPath === undefined) errors.push(`${name}: declared Cordis patch escapes package root (${patch})`)
      else {
        const status = await packageFileStatus(packageRoot, patchPath)
        if (status === 'outside') errors.push(`${name}: declared Cordis patch resolves outside package root (${patch})`)
        else if (status !== 'file') errors.push(`${name}: declared Cordis patch does not exist (${patch})`)
      }
    }
    const scannedClients = new Set()
    for (const clientEntry of collectClientEntries(meta)) {
      const clientPath = packageFilePath(packageRoot, clientEntry)
      if (clientPath === undefined) {
        errors.push(`${name}: declared client entry escapes package root (${clientEntry})`)
        continue
      }
      const status = await packageFileStatus(packageRoot, clientPath)
      if (status === 'outside') {
        errors.push(`${name}: declared client entry resolves outside package root (${clientEntry})`)
        continue
      }
      if (status !== 'file') {
        errors.push(`${name}: declared client entry does not exist (${clientEntry})`)
        continue
      }
      // Validate every declaration first; only then deduplicate aliases of a
      // package-owned physical file (including in-package symlinks).
      const canonicalClientPath = await realpath(clientPath)
      if (scannedClients.has(canonicalClientPath)) continue
      scannedClients.add(canonicalClientPath)
      const clientText = await readFile(canonicalClientPath, 'utf8')
      loaderKeys.push(...moduleLoaderKeys(clientText).map(key => `${key}`))
      if (clientText.includes('ModuleLoader') && !clientText.includes(name.split('/').pop())) {
        // Keep the receipt informative without rejecting packages that use a
        // generated client id rather than their npm name.
        checked.push(`${name}:client-generated-id`)
      }
    }
    checked.push(name)
  }

  const duplicateLoaderKeys = duplicate(loaderKeys)
  if (duplicateLoaderKeys.length > 0) {
    warnings.push({
      code: 'UNVERIFIED_DUPLICATE_LOADER_KEYS',
      message: `Repeated ModuleLoader text requires runtime registration validation: ${duplicateLoaderKeys.join(', ')}`,
      keys: duplicateLoaderKeys,
      requiresRuntimeGate: true,
    })
  }
  if (errors.length > 0) {
    const error = new Error(`Candidate compatibility gate failed: ${errors.join('; ')}`)
    error.code = 'CANDIDATE_COMPATIBILITY_FAILED'
    error.details = { errors, warnings, checked, duplicateLoaderKeys, engineChecks }
    throw error
  }
  return {
    ok: true,
    gate: 'static-profile-v1',
    profilePath: root,
    bundles: uniqueBundles,
    checked,
    warnings,
    duplicateLoaderKeys,
    engineChecks,
  }
}
