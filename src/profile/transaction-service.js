import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { resolvePluginSource } from './source-resolver.js'

const ACTIONS = new Set([
  'install',
  'update',
  'setEnabled',
  'replaceSource',
  'reorder',
  'configure',
  'promoteLocal',
  'remove',
])
const SOURCE_ACTIONS = new Set(['install', 'update', 'replaceSource', 'promoteLocal'])
const PROFILE_ONLY_ACTIONS = new Set(['setEnabled', 'reorder', 'configure'])
const PLUGIN_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,127}\/)?[a-z0-9][a-z0-9._-]{0,127}$/i
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const EXACT_COMMIT = /^[a-f0-9]{40}$/i
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/
const SHA256 = /^[a-f0-9]{64}$/i
const SAFE_CANDIDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const SHELL_META = /[;&|<>`$\r\n]/u
const SCRIPT_NAMES = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
])

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a structured object`)
  return value
}

function assertKnownFields(value, fields, label) {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new TypeError(`Unknown ${label} field: ${field}`)
  }
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]))
  return value
}

function createProgressReporter(onProgress) {
  if (onProgress === undefined) return () => {}
  if (typeof onProgress !== 'function') throw new TypeError('onProgress must be a function')
  return update => {
    try {
      onProgress(cloneValue(update))
    } catch {
      // Progress is observational. A closed splash window or a renderer-side
      // callback failure must never invalidate an otherwise sound candidate.
    }
  }
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Plugin transaction aborted')
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal)
}

async function awaitWithAbort(value, signal) {
  throwIfAborted(signal)
  try {
    const result = await Promise.resolve(value)
    // Cancellation is not allowed to release the transaction queue while an
    // adapter can still mutate the candidate. Adapters receive the same
    // signal and must drain their owned work before their promise settles.
    throwIfAborted(signal)
    return result
  } catch (error) {
    if (!signal?.aborted) throw error
    const aborted = abortError(signal)
    if (error !== aborted && aborted !== null && (typeof aborted === 'object' || typeof aborted === 'function')) {
      try {
        Object.defineProperty(aborted, 'adapterDrainError', {
          value: error,
          configurable: true,
        })
      } catch {
        // Preserve the cancellation reason when the Error is immutable.
      }
    }
    throw aborted
  }
}

async function callAdapter(adapter, request, label) {
  if (typeof adapter !== 'function') throw new TypeError(`${label} adapter is required`)
  const signal = request?.signal
  throwIfAborted(signal)
  let result
  try {
    result = adapter(request)
  } catch (error) {
    throw error
  }
  return awaitWithAbort(result, signal)
}

function assertSafeCommandValue(value, label) {
  if (typeof value !== 'string' || value.length === 0 || SHELL_META.test(value)) {
    throw new TypeError(`${label} contains command text or shell metacharacters`)
  }
  return value
}

function assertPluginName(value, label = 'Plugin name') {
  if (typeof value !== 'string' || !PLUGIN_NAME.test(value) || SHELL_META.test(value)) {
    throw new TypeError(`Invalid ${label}`)
  }
  return value
}

function assertCandidateId(value) {
  if (typeof value !== 'string' || !SAFE_CANDIDATE_ID.test(value) || SHELL_META.test(value)) {
    throw new TypeError('Invalid candidate id')
  }
  return value
}

function assertCandidateRoot(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new TypeError('candidateRoot must be an absolute path')
  return resolve(value)
}

function isInside(root, target, { strict = true } = {}) {
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  const remainder = relative(rootPath, targetPath)
  if (remainder === '') return !strict
  return remainder !== '..' && !remainder.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(remainder)
}

function assertCandidatePath(root, value, label = 'Candidate path') {
  if (typeof value !== 'string' || !isAbsolute(value) || !isInside(root, value)) {
    throw new TypeError(`${label} must be inside candidateRoot`)
  }
  return resolve(value)
}

function assertOptionalCandidatePath(root, value, label) {
  if (value === undefined) return undefined
  return assertCandidatePath(root, value, label)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function normalizeResolvedSource(source, { mode, action }) {
  assertPlainObject(source, 'Resolved source')
  if (source.type === 'npm') {
    assertPluginName(source.package, 'Resolved npm package')
    if (!EXACT_VERSION.test(source.version ?? '')) throw new TypeError('npm source was not resolved to an exact version')
    if (!INTEGRITY.test(source.integrity ?? '')) throw new TypeError('npm source is missing registry integrity')
    const specifier = `${source.package}@${source.version}`
    if (source.specifier !== undefined && source.specifier !== specifier) throw new TypeError('Resolved npm specifier mismatch')
    return {
      type: 'npm',
      package: source.package,
      version: source.version,
      integrity: source.integrity,
      specifier,
      promotable: source.promotable !== false,
    }
  }
  if (source.type === 'github') {
    assertSafeCommandValue(source.repository, 'Resolved GitHub repository')
    if (!EXACT_COMMIT.test(source.commit ?? '') || source.ref !== source.commit) {
      throw new TypeError('GitHub source was not resolved to an exact commit')
    }
    if (source.path !== undefined) {
      if (typeof source.path !== 'string' || !/^\/[a-z0-9][a-z0-9._/-]{0,255}$/i.test(source.path) || source.path.includes('..') || source.path.includes('//')) {
        throw new TypeError('Invalid resolved GitHub path')
      }
    }
    const specifier = `github:${source.repository}#${source.commit}${source.path === undefined ? '' : `&path:${source.path}`}`
    if (source.specifier !== undefined && source.specifier !== specifier) throw new TypeError('Resolved GitHub specifier mismatch')
    return {
      type: 'github',
      repository: source.repository,
      ref: source.commit.toLowerCase(),
      commit: source.commit.toLowerCase(),
      ...(source.path === undefined ? {} : { path: source.path }),
      specifier,
      promotable: source.promotable !== false,
    }
  }
  if (source.type === 'local-dev') {
    if (mode !== 'dev' && action !== 'promoteLocal') throw new Error('local-dev sources are allowed only in dev mode')
    if (typeof source.path !== 'string' || !isAbsolute(source.path)) throw new TypeError('Invalid local-dev source path')
    return {
      type: 'local-dev',
      path: resolve(source.path),
      link: `link:${resolve(source.path)}`,
      specifier: `link:${resolve(source.path)}`,
      promotable: false,
    }
  }
  throw new TypeError(`Unsupported resolved source type: ${String(source.type)}`)
}

function validateStructuredSource(source) {
  assertPlainObject(source, 'Source')
  for (const value of Object.values(source)) {
    if (typeof value === 'string' && SHELL_META.test(value)) {
      throw new TypeError('Source contains command text or shell metacharacters')
    }
  }
  if (typeof source.type !== 'string' || !['npm', 'github', 'local-dev'].includes(source.type)) {
    throw new TypeError('Source type must be npm, github, or local-dev')
  }
  return source
}

function sourcePackageName(source, requestedName) {
  if (requestedName !== undefined) assertPluginName(requestedName)
  if (source.type === 'npm') {
    if (requestedName !== undefined && requestedName !== source.package) throw new Error('npm source package does not match plugin name')
    return source.package
  }
  if (source.type === 'local-pack' && requestedName === undefined) return source.package
  if (source.type === 'local-pack' && requestedName !== source.package) throw new Error('Packed source package does not match plugin name')
  if (requestedName === undefined) throw new TypeError('A plugin name is required for GitHub or local-dev sources')
  return requestedName
}

function exactSourceFromDependency(name, dependency, mode) {
  const dependencyValue = typeof dependency === 'string' ? dependency : dependency?.specifier ?? dependency?.version ?? dependency?.resolved
  const dependencyIntegrity = typeof dependency === 'object' ? dependency.integrity ?? dependency.resolution?.integrity : undefined
  if (typeof dependencyValue !== 'string') throw new Error(`Plugin ${name} needs a structured source for update`)
  if (dependencyValue.startsWith('github:')) {
    const match = /^github:([^/]+\/[^#]+)#([a-f0-9]{40})(?:&path:(\/.*))?$/i.exec(dependencyValue)
    if (match === null) throw new Error(`Plugin ${name} has a non-exact GitHub source`)
    return normalizeResolvedSource({ type: 'github', repository: match[1], ref: match[2], commit: match[2], ...(match[3] === undefined ? {} : { path: match[3] }) }, { mode, action: 'update' })
  }
  const scoped = /^(@[^/]+\/[^@]+)@(.+)$/.exec(dependencyValue)
  const unscoped = /^([^@/]+)@(.+)$/.exec(dependencyValue)
  const match = scoped ?? unscoped
  if (match !== null && EXACT_VERSION.test(match[2]) && INTEGRITY.test(dependencyIntegrity ?? '')) {
    return normalizeResolvedSource({ type: 'npm', package: match[1], version: match[2], integrity: dependencyIntegrity }, { mode, action: 'update' })
  }
  if (dependencyValue.startsWith('link:') && mode === 'dev') {
    return normalizeResolvedSource({ type: 'local-dev', path: dependencyValue.slice('link:'.length) }, { mode, action: 'update' })
  }
  throw new Error(`Plugin ${name} has no exact structured source; provide source explicitly`)
}

function profileManifest(profile) {
  if (isPlainObject(profile.packageJson)) return profile.packageJson
  if (isPlainObject(profile.manifest)) return profile.manifest
  return profile
}

function ensureObjectProperty(target, key) {
  if (!isPlainObject(target[key])) target[key] = {}
  return target[key]
}

function dependencyContainer(profile) {
  const manifest = profileManifest(profile)
  return ensureObjectProperty(manifest, 'dependencies')
}

function dependencyEntries(profile) {
  const dependencies = dependencyContainer(profile)
  return Object.entries(dependencies).map(([name, value]) => ({
    name,
    specifier: typeof value === 'string' ? value : value?.specifier ?? value?.version ?? value?.resolved,
    value: cloneValue(value),
  }))
}

function packageSnapshot(profile) {
  return dependencyEntries(profile).map(({ name, specifier, value }) => ({ name, specifier, ...(value !== undefined && typeof value !== 'string' ? { value } : {}) }))
}

function bundleContainer(profile) {
  const manifest = profileManifest(profile)
  const candidates = [
    [manifest?.dsh?.profile, 'bundles'],
    [profile?.dsh?.profile, 'bundles'],
    [profile, 'bundles'],
  ]
  for (const [owner, key] of candidates) {
    if (isPlainObject(owner) && Array.isArray(owner[key])) return owner
  }
  if (isPlainObject(manifest)) {
    if (!isPlainObject(manifest.dsh)) manifest.dsh = {}
    if (!isPlainObject(manifest.dsh.profile)) manifest.dsh.profile = {}
    if (!Array.isArray(manifest.dsh.profile.bundles)) manifest.dsh.profile.bundles = []
    return manifest.dsh.profile
  }
  if (!Array.isArray(profile.bundles)) profile.bundles = []
  return profile
}

function bundleNames(profile) {
  return bundleContainer(profile).bundles.map(value => typeof value === 'string' ? value : value?.name).filter(value => typeof value === 'string')
}

function setBundleNames(profile, names) {
  bundleContainer(profile).bundles = [...names]
}

function configContainer(profile) {
  const manifest = profileManifest(profile)
  const candidates = [
    [manifest?.dsh?.profile, 'config'],
    [profile?.dsh?.profile, 'config'],
    [profile, 'config'],
    [profile, 'pluginConfig'],
  ]
  for (const [owner, key] of candidates) {
    if (isPlainObject(owner) && isPlainObject(owner[key])) return owner[key]
  }
  if (isPlainObject(manifest)) {
    if (!isPlainObject(manifest.dsh)) manifest.dsh = {}
    if (!isPlainObject(manifest.dsh.profile)) manifest.dsh.profile = {}
    manifest.dsh.profile.config = {}
    return manifest.dsh.profile.config
  }
  profile.config = {}
  return profile.config
}

function targetConfig(profile, name) {
  const config = configContainer(profile)
  return Object.hasOwn(config, name) ? cloneValue(config[name]) : undefined
}

function setTargetConfig(profile, name, value) {
  configContainer(profile)[name] = cloneValue(value)
}

function diffNames(before, after) {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: after.filter(value => !beforeSet.has(value)),
    removed: before.filter(value => !afterSet.has(value)),
  }
}

function canonicalRecords(records) {
  return records.map(value => cloneValue(value))
}

function diffPackages(beforeProfile, afterProfile) {
  const before = packageSnapshot(beforeProfile)
  const after = packageSnapshot(afterProfile)
  const beforeMap = new Map(before.map(value => [value.name, value]))
  const afterMap = new Map(after.map(value => [value.name, value]))
  const added = after.filter(value => !beforeMap.has(value.name)).map(value => value.name)
  const removed = before.filter(value => !afterMap.has(value.name)).map(value => value.name)
  const changed = after.filter(value => beforeMap.has(value.name) && stableJson(beforeMap.get(value.name)) !== stableJson(value)).map(value => value.name)
  return { before: canonicalRecords(before), after: canonicalRecords(after), added, removed, changed }
}

function diffBundles(beforeProfile, afterProfile) {
  const before = bundleNames(beforeProfile)
  const after = bundleNames(afterProfile)
  return {
    before: [...before],
    after: [...after],
    ...diffNames(before, after),
    orderChanged: stableJson(before) !== stableJson(after),
  }
}

function diffConfig(beforeProfile, afterProfile, name) {
  const before = targetConfig(beforeProfile, name)
  const after = targetConfig(afterProfile, name)
  return {
    plugin: name,
    before: cloneValue(before),
    after: cloneValue(after),
    changed: stableJson(before) !== stableJson(after),
  }
}

function normalizeBuildPermissions(value) {
  if (value === undefined) return {}
  assertPlainObject(value, 'buildPermissions')
  for (const [name, allowed] of Object.entries(value)) {
    assertPluginName(name, 'build permission package')
    if (typeof allowed !== 'boolean') throw new TypeError(`buildPermissions[${name}] must be boolean`)
  }
  return value
}

function scriptRecord(packageName, scriptName, command, raw) {
  if (!SCRIPT_NAMES.has(scriptName) || typeof command !== 'string' || command.trim() === '') return undefined
  return {
    package: packageName,
    name: scriptName,
    command,
    raw: cloneValue(raw),
  }
}

function collectScriptRecords(value, fallbackPackage) {
  const records = []
  const addObject = (entry, fallback = fallbackPackage) => {
    if (typeof entry === 'string') {
      const record = scriptRecord(fallback, entry, entry, entry)
      if (record !== undefined) records.push(record)
      return
    }
    if (!isPlainObject(entry)) return
    const packageName = entry.package ?? entry.packageName ?? entry.nameOfPackage ?? fallback
    const scripts = entry.scripts ?? entry.scriptNames ?? entry.entries
    if (isPlainObject(scripts)) {
      for (const [name, command] of Object.entries(scripts)) {
        const record = scriptRecord(packageName, name, command, entry)
        if (record !== undefined) records.push(record)
      }
      return
    }
    if (Array.isArray(scripts)) {
      for (const script of scripts) {
        if (typeof script === 'string') {
          const record = scriptRecord(packageName, script, script, entry)
          if (record !== undefined) records.push(record)
        } else if (isPlainObject(script)) {
          const name = script.name ?? script.script ?? script.lifecycle
          const command = script.command ?? script.value ?? script.commandText ?? name
          const record = scriptRecord(packageName, name, command, script)
          if (record !== undefined) records.push(record)
        }
      }
      return
    }
    const directNames = Object.keys(entry).filter(name => SCRIPT_NAMES.has(name))
    for (const name of directNames) {
      const record = scriptRecord(packageName, name, entry[name], entry)
      if (record !== undefined) records.push(record)
    }
  }

  if (Array.isArray(value)) {
    for (const entry of value) addObject(entry)
  } else if (isPlainObject(value)) {
    if (Array.isArray(value.packages)) {
      for (const entry of value.packages) addObject(entry)
    } else if (value.scripts !== undefined || value.scriptNames !== undefined || value.entries !== undefined) {
      addObject(value)
    } else {
      for (const [packageName, entry] of Object.entries(value)) addObject(entry, packageName)
    }
  } else if (typeof value === 'string') {
    addObject(value)
  }
  for (const record of records) {
    if (typeof record.package !== 'string' || !PLUGIN_NAME.test(record.package)) {
      throw new TypeError('Build script inventory contains an invalid package name')
    }
  }
  return records
}

function scriptReport(raw, fallbackPackage, buildPermissions) {
  const records = collectScriptRecords(raw, fallbackPackage)
  const blocked = records.filter(record => buildPermissions[record.package] !== true)
  return {
    manifest: cloneValue(raw ?? []),
    entries: records.map(cloneValue),
    allowed: records.filter(record => buildPermissions[record.package] === true).map(cloneValue),
    blocked: blocked.map(cloneValue),
  }
}

function assertScriptPermissions(report) {
  if (report.blocked.length === 0) return
  const packages = [...new Set(report.blocked.map(record => record.package ?? '<unknown>'))]
  const error = new Error(`Build scripts require explicit buildPermissions: ${packages.join(', ')}`)
  error.code = 'BUILD_PERMISSION_REQUIRED'
  error.scripts = cloneValue(report)
  throw error
}

function exactSpecifier(source) {
  if (source.type === 'local-dev') return source.specifier
  return source.specifier
}

function buildPermissionArgs(buildPermissions = {}) {
  return Object.entries(buildPermissions)
    .filter(([, allowed]) => allowed === true)
    .map(([name]) => `--allow-build=${name}`)
    .sort()
}

// pnpm 11 enables strictDepBuilds by default. A profile can legitimately
// contain older dependencies whose lifecycle scripts remain unapproved (and
// therefore disabled). Without this scoped override, adding an unrelated,
// explicitly audited plugin aborts with ERR_PNPM_IGNORED_BUILDS even though no
// unapproved script ran. The transaction inventory/allow-build gate above
// remains authoritative, and the candidate runtime gate still rolls back a
// plugin that cannot operate with an ignored transitive build.
const PNPM_NONINTERACTIVE_BUILD_POLICY = '--config.strict-dep-builds=false'

function buildPnpmArgs(action, name, source, buildPermissions = {}) {
  if (action === 'remove') return ['remove', '--reporter', 'append-only', PNPM_NONINTERACTIVE_BUILD_POLICY, name]
  return [
    'add',
    '--workspace-root',
    '--save-prod',
    '--reporter',
    'append-only',
    PNPM_NONINTERACTIVE_BUILD_POLICY,
    ...buildPermissionArgs(buildPermissions),
    exactSpecifier(source),
  ]
}

function buildPnpmInstallManyArgs(sources, buildPermissions = {}) {
  return [
    'add',
    '--workspace-root',
    '--save-prod',
    '--reporter',
    'append-only',
    PNPM_NONINTERACTIVE_BUILD_POLICY,
    ...buildPermissionArgs(buildPermissions),
    ...sources.map(exactSpecifier),
  ]
}

function buildPnpmHydrateArgs() {
  return ['install', '--prefer-offline', '--frozen-lockfile', '--reporter', 'append-only', PNPM_NONINTERACTIVE_BUILD_POLICY]
}

function cloneCandidateResult(result, fallback) {
  if (typeof result === 'string') return { ...fallback, candidatePath: result }
  if (!isPlainObject(result)) return fallback
  const candidatePath = result.candidatePath ?? result.path
  return {
    ...fallback,
    ...(candidatePath === undefined ? {} : { candidatePath }),
    ...(result.profile === undefined ? {} : { seedProfile: result.profile }),
    ...(result.parentReleaseId === undefined ? {} : { parentReleaseId: result.parentReleaseId }),
  }
}

function invocationExitCode(result) {
  if (!isPlainObject(result)) return undefined
  for (const field of ['code', 'exitCode', 'status']) {
    if (Number.isInteger(result[field])) return result[field]
  }
  return undefined
}

function assertSuccessfulInvocation(result) {
  const exitCode = invocationExitCode(result)
  if (result === false || (isPlainObject(result) && result.ok === false) || (exitCode !== undefined && exitCode !== 0)) {
    const error = new Error(`DSH plugin command did not complete successfully${exitCode === undefined ? '' : ` (exit ${String(exitCode)})`}`)
    error.code = 'DSH_PLUGIN_COMMAND_FAILED'
    if (exitCode !== undefined) error.exitCode = exitCode
    throw error
  }
  return result
}

function unwrapProfile(result) {
  if (isPlainObject(result) && isPlainObject(result.profile)) return result.profile
  return result
}

function isEmptyProfile(value) {
  return isPlainObject(value) && Object.keys(value).length === 0
}

function dependencyRecord(profile, name) {
  const value = dependencyContainer(profile)[name]
  if (value === undefined) return undefined
  return { name, specifier: typeof value === 'string' ? value : value?.specifier ?? value?.version ?? value?.resolved, value: cloneValue(value) }
}

function setDependency(profile, name, specifier) {
  dependencyContainer(profile)[name] = specifier
}

function removeDependency(profile, name) {
  delete dependencyContainer(profile)[name]
}

function dependencySpecifier(source) {
  // pnpm's CLI needs the full `package@version` selector, but package.json
  // already carries the package name as the dependency key. Persisting the
  // CLI selector there makes pnpm read it as `package@package@version` on the
  // next transaction. Registry packages therefore store only their exact
  // version; pinned GitHub, link, and file sources keep their exact specifier.
  if (source.type === 'npm') return source.version
  return source.specifier
}

function exactPackageFromPacked(result, candidateRoot, candidatePath) {
  assertPlainObject(result, 'packLocalSource result')
  const packageName = result.package ?? result.name
  assertPluginName(packageName, 'Packed package')
  if (!EXACT_VERSION.test(result.version ?? '')) throw new TypeError('Packed local source needs an exact version')
  const artifactPath = result.artifactPath ?? result.path
  const checkedArtifactPath = assertCandidatePath(candidateRoot, artifactPath, 'Packed artifact path')
  const integrity = result.integrity
  if (integrity !== undefined && !INTEGRITY.test(integrity)) throw new TypeError('Invalid packed package integrity')
  if (!SHA256.test(result.sha256 ?? '')) throw new TypeError('Packed local source needs a SHA-256 digest')
  const specifier = result.specifier ?? result.fileSpecifier ?? `file:${checkedArtifactPath}`
  assertSafeCommandValue(specifier, 'Packed package specifier')
  if (!specifier.startsWith('file:')) throw new TypeError('Packed package must use a file specifier')
  const specifierPath = specifier.slice('file:'.length)
  const resolvedSpecifierPath = isAbsolute(specifierPath) ? specifierPath : resolve(candidatePath, specifierPath)
  assertCandidatePath(candidateRoot, resolvedSpecifierPath, 'Packed package specifier path')
  return {
    type: 'local-pack',
    package: packageName,
    version: result.version,
    ...(integrity === undefined ? {} : { integrity }),
    sha256: result.sha256.toLowerCase(),
    artifactPath: checkedArtifactPath,
    specifier,
    promotable: true,
  }
}

function findDependentPackages(profile, name) {
  const result = new Set()
  const directDependents = profile.dependents
  if (isPlainObject(directDependents)) {
    const values = directDependents[name]
    if (Array.isArray(values)) for (const value of values) if (typeof value === 'string') result.add(value)
  }
  const graph = profile.packageGraph ?? profile.dependencyGraph
  if (isPlainObject(graph)) {
    for (const [packageName, value] of Object.entries(graph)) {
      const dependencies = Array.isArray(value) ? value : value?.dependencies
      if (Array.isArray(dependencies) && dependencies.includes(name)) result.add(packageName)
    }
  }
  const packages = profile.packages
  if (Array.isArray(packages)) {
    for (const entry of packages) {
      if (!isPlainObject(entry)) continue
      const packageName = entry.name ?? entry.package
      const dependencies = entry.dependencies ?? entry.requires
      if (typeof packageName === 'string' && Array.isArray(dependencies) && dependencies.includes(name)) result.add(packageName)
    }
  }
  result.delete(name)
  return [...result].sort()
}

function findDependentBundles(profile, name) {
  const result = new Set()
  const graph = profile.bundleDependencies ?? profile.bundlesByPackage ?? profile.dsh?.profile?.bundleDependencies
  if (isPlainObject(graph)) {
    for (const [bundle, dependencies] of Object.entries(graph)) {
      const values = Array.isArray(dependencies) ? dependencies : dependencies?.packages
      if (Array.isArray(values) && values.includes(name)) result.add(bundle)
    }
  }
  if (bundleNames(profile).includes(name)) result.add(name)
  result.delete(name)
  return [...result].sort()
}

function removalFingerprint(profile, name) {
  const packageEntry = dependencyRecord(profile, name)
  return digest({
    name,
    package: packageEntry,
    dependentPackages: findDependentPackages(profile, name),
    dependentBundles: findDependentBundles(profile, name),
  })
}

export class CandidateGateError extends Error {
  constructor(message, receipt) {
    super(message)
    this.name = 'CandidateGateError'
    this.code = 'CANDIDATE_GATE_FAILED'
    this.receipt = cloneValue(receipt)
  }
}

export class RemovalConfirmationError extends Error {
  constructor(message = 'Removal confirmation token mismatch') {
    super(message)
    this.name = 'RemovalConfirmationError'
    this.code = 'REMOVAL_CONFIRMATION_REQUIRED'
  }
}

/**
 * The only profile writer in this service is the injected candidate writer.
 * The service deliberately owns no queue: desktop-runtime-controller's
 * operationCoordinator remains the sole concurrency owner.
 */
export class PluginTransactionService {
  constructor(options = {}) {
    assertPlainObject(options, 'Plugin transaction options')
    this.candidateRoot = assertCandidateRoot(options.candidateRoot)
    this.mode = options.mode ?? 'stable'
    if (!['dev', 'stable', 'next'].includes(this.mode)) throw new TypeError('mode must be dev, stable, or next')
    this.allowedRoots = options.allowedRoots
    this.sourceResolver = options.sourceResolver ?? resolvePluginSource
    this.runPnpm = options.runPnpm ?? options.runPnpmImpl
    this.runGit = options.runGit ?? options.runGitImpl
    this.pnpmOptions = options.pnpmOptions
    this.gitOptions = options.gitOptions
    this.cloneActiveProfile = options.cloneActiveProfile
    this.discardCandidate = options.discardCandidate
    this.invokeDshPlugin = options.invokeDshPlugin
    this.inventoryScripts = options.inventoryScripts
    this.runCandidateGate = options.runCandidateGate
    this.runCandidateRuntimeGate = options.runCandidateRuntimeGate
    this.readCandidateProfile = options.readCandidateProfile
    this.writeCandidateProfile = options.writeCandidateProfile
    this.packLocalSource = options.packLocalSource
    this.finalizeCandidate = options.finalizeCandidate
    this.readActiveProfile = options.readActiveProfile
    this.idFactory = options.idFactory ?? (() => `plugin-${randomUUID()}`)
    this.previews = new Map()
  }

  nextCandidate(input = {}) {
    const suppliedId = input.candidateId
    const candidateId = suppliedId === undefined ? this.idFactory() : suppliedId
    assertCandidateId(candidateId)
    const canonicalPath = join(this.candidateRoot, candidateId)
    const requestedPath = input.candidatePath ?? canonicalPath
    const candidatePath = assertCandidatePath(this.candidateRoot, requestedPath)
    if (candidatePath !== resolve(canonicalPath)) throw new TypeError('candidatePath must match candidateId')
    return { candidateId, candidatePath }
  }

  async resolveSource(source, { action, signal, mode = this.mode } = {}) {
    validateStructuredSource(source)
    throwIfAborted(signal)
    const resolvedSource = await callAdapter(this.sourceResolver, {
      source,
      mode: action === 'promoteLocal' ? 'dev' : mode,
      allowedRoots: this.allowedRoots,
      runPnpm: this.runPnpm,
      runGit: this.runGit,
      pnpmOptions: this.pnpmOptions,
      gitOptions: this.gitOptions,
      signal,
    }, 'sourceResolver')
    throwIfAborted(signal)
    return normalizeResolvedSource(resolvedSource, { mode, action })
  }

  async cloneCandidate(candidate, action, signal) {
    const result = await callAdapter(this.cloneActiveProfile, {
      candidateId: candidate.candidateId,
      candidatePath: candidate.candidatePath,
      candidateRoot: this.candidateRoot,
      action,
      signal,
    }, 'cloneActiveProfile')
    if (isPlainObject(result)
      && result.candidateId !== undefined
      && result.candidateId !== candidate.candidateId) {
      throw new Error('cloneActiveProfile returned a different candidate id')
    }
    const cloned = cloneCandidateResult(result, candidate)
    cloned.candidatePath = assertCandidatePath(this.candidateRoot, cloned.candidatePath)
    if (cloned.candidatePath !== candidate.candidatePath) throw new Error('cloneActiveProfile changed the candidate identity')
    if (cloned.parentReleaseId !== undefined) {
      assertCandidateId(cloned.parentReleaseId)
      if (cloned.parentReleaseId === candidate.candidateId) throw new Error('Candidate parent release cannot be the candidate itself')
    }
    return cloned
  }

  async discardFailedCandidate(candidate, action, originalError) {
    if (typeof this.discardCandidate !== 'function') return
    try {
      await callAdapter(this.discardCandidate, {
        candidateId: candidate.candidateId,
        candidatePath: candidate.candidatePath,
        candidateRoot: this.candidateRoot,
        action,
      }, 'discardCandidate')
    } catch (cleanupError) {
      if (originalError !== null && (typeof originalError === 'object' || typeof originalError === 'function')) {
        try {
          Object.defineProperty(originalError, 'candidateCleanupError', {
            value: cleanupError,
            configurable: true,
          })
        } catch {
          // Preserve the transaction failure even when the error is immutable.
        }
      }
    }
  }

  /**
   * Retire a candidate that completed the service transaction but could not be
   * journaled by the desktop owner. This is intentionally separate from
   * discardFailedCandidate: callers need a positive cleanup result after the
   * transaction itself has already returned successfully.
   */
  async discardCandidateRelease(input = {}) {
    assertPlainObject(input, 'discardCandidateRelease input')
    assertKnownFields(input, new Set(['candidateId', 'candidatePath', 'action']), 'discardCandidateRelease input')
    const candidate = this.nextCandidate(input)
    const action = input.action ?? 'discard'
    if (typeof action !== 'string' || action.trim() === '') throw new TypeError('discardCandidateRelease action must be a non-empty string')
    return callAdapter(this.discardCandidate, {
      candidateId: candidate.candidateId,
      candidatePath: candidate.candidatePath,
      candidateRoot: this.candidateRoot,
      action,
    }, 'discardCandidate')
  }

  async readProfile(candidate, action, signal) {
    const result = await callAdapter(this.readCandidateProfile, {
      candidateId: candidate.candidateId,
      candidatePath: candidate.candidatePath,
      candidateRoot: this.candidateRoot,
      action,
      signal,
    }, 'readCandidateProfile')
    const profile = unwrapProfile(result)
    if (profile === undefined) return {}
    assertPlainObject(profile, 'Candidate profile')
    return cloneValue(profile)
  }

  async writeProfile(candidate, action, profile, signal) {
    assertPlainObject(profile, 'Candidate profile')
    await callAdapter(this.writeCandidateProfile, {
      candidateId: candidate.candidateId,
      candidatePath: candidate.candidatePath,
      candidateRoot: this.candidateRoot,
      action,
      profile: cloneValue(profile),
      signal,
    }, 'writeCandidateProfile')
  }

  async inventory(candidate, action, source, packageName, signal) {
    const raw = await callAdapter(this.inventoryScripts, {
      candidateId: candidate.candidateId,
      candidatePath: candidate.candidatePath,
      candidateRoot: this.candidateRoot,
      action,
      packageName,
      source: cloneValue(source),
      signal,
    }, 'inventoryScripts')
    return { raw: cloneValue(raw ?? []), packageName }
  }

  async invoke(candidate, action, pnpmArgs, source, signal) {
    if (!Array.isArray(pnpmArgs) || pnpmArgs.some(argument => typeof argument !== 'string' || SHELL_META.test(argument))) {
      throw new TypeError('Plugin invocation must use safe argv strings')
    }
    const argv = Object.freeze(['plugin', '--profile', candidate.candidatePath, ...pnpmArgs])
    if (argv.some(argument => typeof argument !== 'string' || SHELL_META.test(argument))) {
      throw new TypeError('Plugin invocation argv contains command text or shell metacharacters')
    }
    const result = await callAdapter(this.invokeDshPlugin, {
      argv,
      args: argv,
      shell: false,
      candidateId: candidate.candidateId,
      candidatePath: candidate.candidatePath,
      candidateRoot: this.candidateRoot,
      action,
      source: cloneValue(source),
      signal,
    }, 'invokeDshPlugin')
    return assertSuccessfulInvocation(result)
  }

  async gate(candidate, action, profile, source, scripts, signal, onProgress) {
    const request = {
      candidateId: candidate.candidateId,
      candidatePath: candidate.candidatePath,
      candidateRoot: this.candidateRoot,
      action,
      profile: cloneValue(profile),
      source: cloneValue(source),
      scripts: cloneValue(scripts),
      signal,
    }
    onProgress?.({ phase: 'static-gate', completed: 0, total: 1 })
    const receipt = await callAdapter(this.runCandidateGate, request, 'runCandidateGate')
    if (receipt === false || receipt?.ok === false) throw new CandidateGateError('Candidate gate failed', receipt)
    const staticReceipt = cloneValue(receipt === true || receipt === undefined ? { ok: true } : receipt)
    onProgress?.({ phase: 'static-gate', completed: 1, total: 1 })
    if (typeof this.runCandidateRuntimeGate !== 'function') return staticReceipt
    onProgress?.({ phase: 'runtime-gate', completed: 0, total: 1 })
    const runtimeReceipt = await callAdapter(this.runCandidateRuntimeGate, request, 'runCandidateRuntimeGate')
    if (!isPlainObject(runtimeReceipt) || runtimeReceipt.ok !== true) {
      throw new CandidateGateError('Candidate runtime gate failed', runtimeReceipt)
    }
    if (runtimeReceipt.candidateId !== undefined && runtimeReceipt.candidateId !== candidate.candidateId) {
      throw new CandidateGateError('Candidate runtime gate candidateId mismatch', runtimeReceipt)
    }
    onProgress?.({ phase: 'runtime-gate', completed: 1, total: 1 })
    return {
      ok: true,
      static: staticReceipt,
      runtime: cloneValue(runtimeReceipt),
    }
  }

  async resolveMutationSource(action, input, beforeProfile, signal) {
    if (input.source !== undefined) {
      const source = await this.resolveSource(input.source, { action, signal })
      if (source.type === 'local-dev' && this.mode !== 'dev' && action !== 'promoteLocal') throw new Error('local-dev sources are allowed only in dev mode')
      return source
    }
    if (action === 'update') {
      const name = assertPluginName(input.name)
      const current = dependencyRecord(beforeProfile, name)
      if (current === undefined) throw new Error(`Plugin ${name} is not installed`)
      return exactSourceFromDependency(name, current.value ?? current.specifier, this.mode)
    }
    throw new TypeError(`${action} requires a structured source`)
  }

  async prepareLocalPromotion(candidate, source, input, signal) {
    const result = await callAdapter(this.packLocalSource, {
      source: cloneValue(source),
      candidateId: candidate.candidateId,
      candidatePath: candidate.candidatePath,
      candidateRoot: this.candidateRoot,
      packageName: input.name ?? input.packageName,
      signal,
    }, 'packLocalSource')
    return exactPackageFromPacked(result, this.candidateRoot, candidate.candidatePath)
  }

  packageNameFor(action, input, source) {
    if (action === 'remove' || action === 'setEnabled' || action === 'configure') return assertPluginName(input.name ?? input.packageName)
    return sourcePackageName(source, input.name ?? input.packageName)
  }

  applyPackageAction(action, profile, name, source, input, priorBundles = bundleNames(profile)) {
    if (action === 'remove') {
      removeDependency(profile, name)
      setBundleNames(profile, bundleNames(profile).filter(bundle => bundle !== name))
      return
    }
    if (SOURCE_ACTIONS.has(action)) {
      setDependency(profile, name, dependencySpecifier(source))
      const currentBundles = bundleNames(profile)
      const shouldEnable = input.enabled === undefined
        ? action === 'install' || action === 'promoteLocal' ? true : priorBundles.includes(name)
        : input.enabled
      if (shouldEnable && !currentBundles.includes(name)) setBundleNames(profile, [...currentBundles, name])
      if (shouldEnable === false) setBundleNames(profile, currentBundles.filter(bundle => bundle !== name))
    }
  }

  async mutate(action, input = {}) {
    assertPlainObject(input, `${action} input`)
    const allowedFields = new Set([
      'action',
      'candidateId',
      'candidatePath',
      'name',
      'packageName',
      'source',
      'buildPermissions',
      'enabled',
      'order',
      'bundles',
      'config',
      'previewDigest',
      'confirmationToken',
      'signal',
    ])
    assertKnownFields(input, allowedFields, `${action} input`)
    if (!ACTIONS.has(action)) throw new TypeError(`Unsupported plugin transaction action: ${action}`)
    if (action === 'remove' && (typeof input.previewDigest !== 'string' || typeof input.confirmationToken !== 'string')) {
      throw new RemovalConfirmationError()
    }
    let confirmedPreview
    if (action === 'remove') {
      confirmedPreview = this.previews.get(input.previewDigest)
      const confirmedName = input.name ?? input.packageName
      if (confirmedPreview === undefined || confirmedPreview.confirmationToken !== input.confirmationToken || confirmedPreview.name !== confirmedName) {
        throw new RemovalConfirmationError()
      }
      if ((input.candidateId !== undefined && input.candidateId !== confirmedPreview.candidateId)
        || (input.candidatePath !== undefined && resolve(input.candidatePath) !== confirmedPreview.candidatePath)) {
        throw new RemovalConfirmationError('Removal confirmation does not match the preview candidate')
      }
    }
    const signal = input.signal
    throwIfAborted(signal)
    const candidateInput = confirmedPreview === undefined
      ? input
      : { ...input, candidateId: confirmedPreview.candidateId, candidatePath: confirmedPreview.candidatePath }
    const candidate = await this.cloneCandidate(this.nextCandidate(candidateInput), action, signal)
    try {
    const beforeProfile = await this.readProfile(candidate, action, signal)
    const priorBundles = bundleNames(beforeProfile)
    let profile = cloneValue(beforeProfile)
    let source
    let packageName
    let scripts = { raw: [], packageName: input.name ?? input.packageName }
    let scriptDetails = { manifest: [], entries: [], allowed: [], blocked: [] }
    const buildPermissions = normalizeBuildPermissions(input.buildPermissions)

    if (SOURCE_ACTIONS.has(action)) {
      source = await this.resolveMutationSource(action, input, beforeProfile, signal)
      packageName = this.packageNameFor(action, input, source)
      if (action === 'promoteLocal') {
        if (source.type !== 'local-dev') throw new TypeError('promoteLocal requires a local-dev source')
        // Inventory the local manifest before it is converted into the sealed
        // local-pack descriptor. The adapter intentionally accepts local-dev
        // paths but not internal local-pack records, so checking afterwards
        // would reject every otherwise valid promotion on Windows and macOS.
        const inventory = await this.inventory(candidate, action, source, packageName, signal)
        scripts = inventory
        scriptDetails = scriptReport(inventory.raw, packageName, buildPermissions)
        assertScriptPermissions(scriptDetails)
        source = await this.prepareLocalPromotion(candidate, source, input, signal)
      } else {
        const inventory = await this.inventory(candidate, action, source, packageName, signal)
        scripts = inventory
        scriptDetails = scriptReport(inventory.raw, packageName, buildPermissions)
        assertScriptPermissions(scriptDetails)
      }
      await this.invoke(candidate, action, buildPnpmArgs(action, packageName, source, buildPermissions), source, signal)
      const invokedProfile = await this.readProfile(candidate, action, signal)
      if (!isEmptyProfile(invokedProfile) || isEmptyProfile(profile)) profile = invokedProfile
      this.applyPackageAction(action, profile, packageName, source, input, priorBundles)
    } else if (action === 'remove') {
      packageName = assertPluginName(input.name ?? input.packageName)
      if (input.previewDigest !== undefined || input.confirmationToken !== undefined) {
        const preview = this.previews.get(input.previewDigest)
        if (preview === undefined || preview.confirmationToken !== input.confirmationToken || preview.name !== packageName) {
          throw new RemovalConfirmationError()
        }
        if (preview.profileFingerprint !== removalFingerprint(beforeProfile, packageName)) {
          throw new RemovalConfirmationError('Removal preview is stale; create a new preview')
        }
      }
      await this.invoke(candidate, action, buildPnpmArgs(action, packageName), undefined, signal)
      const invokedProfile = await this.readProfile(candidate, action, signal)
      if (!isEmptyProfile(invokedProfile) || isEmptyProfile(profile)) profile = invokedProfile
      this.applyPackageAction(action, profile, packageName, undefined, input)
    } else if (action === 'setEnabled') {
      packageName = assertPluginName(input.name ?? input.packageName)
      if (typeof input.enabled !== 'boolean') throw new TypeError('enabled must be boolean')
      if (dependencyRecord(profile, packageName) === undefined) throw new Error(`Plugin ${packageName} is not installed`)
      const bundles = bundleNames(profile)
      setBundleNames(profile, input.enabled
        ? (bundles.includes(packageName) ? bundles : [...bundles, packageName])
        : bundles.filter(bundle => bundle !== packageName))
    } else if (action === 'reorder') {
      const order = input.order ?? input.bundles
      if (!Array.isArray(order) || order.length !== new Set(order).size) throw new TypeError('reorder requires a unique order array')
      for (const name of order) assertPluginName(name, 'bundle name')
      const current = bundleNames(profile)
      if (order.length !== current.length || current.some(name => !order.includes(name))) throw new Error('reorder must include exactly the current bundles')
      setBundleNames(profile, order)
    } else if (action === 'configure') {
      packageName = assertPluginName(input.name ?? input.packageName)
      assertPlainObject(input.config, 'Plugin config')
      if (dependencyRecord(profile, packageName) === undefined) throw new Error(`Plugin ${packageName} is not installed`)
      setTargetConfig(profile, packageName, input.config)
    }

    throwIfAborted(signal)
    await this.writeProfile(candidate, action, profile, signal)
    if (PROFILE_ONLY_ACTIONS.has(action)) {
      // Candidate cloning intentionally omits both derived node_modules link
      // farms because their absolute pnpm targets belong to the active parent.
      // Source mutations rebuild those links through `pnpm add/remove`; pure
      // profile mutations must explicitly hydrate from the pinned lockfile
      // before static and runtime gates inspect installed bundle manifests.
      // Prefer the local store, but allow pnpm to fetch missing registry
      // metadata when an older machine has an incomplete offline mirror. The
      // frozen lockfile and candidate-only transaction still constrain every
      // resolved package; a failed hydration retires the candidate.
      await this.invoke(candidate, action, buildPnpmHydrateArgs(), undefined, signal)
      profile = await this.readProfile(candidate, action, signal)
    }
    const finalization = this.finalizeCandidate === undefined
      ? undefined
      : await callAdapter(this.finalizeCandidate, {
        candidateId: candidate.candidateId,
        candidatePath: candidate.candidatePath,
        candidateRoot: this.candidateRoot,
        parentReleaseId: candidate.parentReleaseId,
        action,
        packageName,
        source: cloneValue(source),
        profile: cloneValue(profile),
        signal,
      }, 'finalizeCandidate')
    const gateReceipt = await this.gate(candidate, action, profile, source, scriptDetails, signal)
    throwIfAborted(signal)
    const packages = diffPackages(beforeProfile, profile)
    const bundles = diffBundles(beforeProfile, profile)
    const config = packageName === undefined ? { plugin: undefined, before: undefined, after: undefined, changed: false } : diffConfig(beforeProfile, profile, packageName)
    const report = {
      action,
      source: cloneValue(source),
      sourceExact: cloneValue(source),
      packageName,
      packages,
      bundles,
      order: {
        before: bundles.before,
        after: bundles.after,
        changed: bundles.orderChanged,
      },
      config,
      scripts: scriptDetails,
      gate: cloneValue(gateReceipt),
      gateReceipt: cloneValue(gateReceipt),
      ...(finalization === undefined ? {} : { finalization: cloneValue(finalization) }),
      candidate: {
        id: candidate.candidateId,
        path: candidate.candidatePath,
        ...(candidate.parentReleaseId === undefined ? {} : { parentReleaseId: candidate.parentReleaseId }),
      },
      candidateId: candidate.candidateId,
      candidatePath: candidate.candidatePath,
      ...(candidate.parentReleaseId === undefined ? {} : { parentReleaseId: candidate.parentReleaseId }),
    }
    if (action === 'remove' && input.previewDigest !== undefined) {
      report.removal = {
        previewDigest: input.previewDigest,
        confirmed: true,
        snapshotPath: confirmedPreview.snapshotPath,
        recoveryPath: confirmedPreview.recoveryPath,
      }
      this.previews.delete(input.previewDigest)
    }
    return report
    } catch (error) {
      await this.discardFailedCandidate(candidate, action, error)
      throw error
    }
  }

  async install(input = {}) { return this.mutate('install', input) }

  /**
   * Stage several curated installs in one candidate. The regular transaction
   * API intentionally remains single-plugin; this batch seam is used only by
   * the first-run recommender so a multi-select never creates a chain of
   * partially activated restarts.
   */
  async installMany(input = {}) {
    assertPlainObject(input, 'installMany input')
    assertKnownFields(input, new Set(['sources', 'buildPermissions', 'signal', 'onProgress']), 'installMany input')
    if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > 256) {
      throw new TypeError('installMany requires one to 256 plugin sources')
    }
    const signal = input.signal
    const progress = createProgressReporter(input.onProgress)
    throwIfAborted(signal)
    const requests = input.sources.map((value, index) => {
      assertPlainObject(value, `installMany source ${String(index + 1)}`)
      assertKnownFields(value, new Set(['name', 'packageName', 'source', 'enabled']), `installMany source ${String(index + 1)}`)
      const requestedName = value.name ?? value.packageName
      if (requestedName !== undefined) assertPluginName(requestedName)
      validateStructuredSource(value.source)
      return { requestedName, sourceInput: cloneValue(value.source), enabled: value.enabled }
    })
    const permissions = normalizeBuildPermissions(input.buildPermissions)
    progress({ phase: 'candidate-clone', completed: 0, total: 1 })
    const candidate = await this.cloneCandidate(this.nextCandidate(), 'installMany', signal)
    progress({ phase: 'candidate-clone', completed: 1, total: 1 })
    try {
      return await this.installManyCandidate({ candidate, requests, permissions, signal, progress })
    } catch (error) {
      await this.discardFailedCandidate(candidate, 'installMany', error)
      throw error
    }
  }

  async installManyCandidate({ candidate, requests, permissions, signal, progress }) {
    const beforeProfile = await this.readProfile(candidate, 'installMany', signal)
    const priorBundles = bundleNames(beforeProfile)
    const resolved = []
    const reports = []
    const packageNames = new Set()

    for (const [index, request] of requests.entries()) {
      const localPromotion = request.sourceInput.type === 'local-dev'
      let source = await this.resolveSource(request.sourceInput, { action: localPromotion ? 'promoteLocal' : 'install', signal })
      const packageName = sourcePackageName(source, request.requestedName)
      if (packageNames.has(packageName)) throw new Error(`Plugin ${packageName} was selected more than once`)
      packageNames.add(packageName)
      const inventory = await this.inventory(candidate, 'installMany', source, packageName, signal)
      const scriptDetails = scriptReport(inventory.raw, packageName, permissions)
      assertScriptPermissions(scriptDetails)
      if (localPromotion) {
        // Curated desktop-owned plugins may ship as source with the installer.
        // Seal each one into this candidate before the single pnpm invocation;
        // the active profile never keeps a mutable link to the application.
        source = await this.prepareLocalPromotion(candidate, source, { name: packageName }, signal)
      }
      resolved.push({ packageName, source, scriptDetails, enabled: request.enabled })
      reports.push(scriptDetails)
      progress({ phase: 'source-resolve', completed: index + 1, total: requests.length, packageName })
    }

    progress({ phase: 'plugin-install', completed: 0, total: resolved.length })
    await this.invoke(
      candidate,
      'installMany',
      buildPnpmInstallManyArgs(resolved.map(value => value.source), permissions),
      resolved.map(value => value.source),
      signal,
    )
    progress({ phase: 'plugin-install', completed: resolved.length, total: resolved.length })
    const invokedProfile = await this.readProfile(candidate, 'installMany', signal)
    let profile = !isEmptyProfile(invokedProfile) || isEmptyProfile(beforeProfile) ? invokedProfile : cloneValue(beforeProfile)
    for (const entry of resolved) {
      this.applyPackageAction('install', profile, entry.packageName, entry.source, { enabled: entry.enabled }, priorBundles)
    }
    await this.writeProfile(candidate, 'installMany', profile, signal)

    const finalizations = []
    if (this.finalizeCandidate !== undefined) {
      progress({ phase: 'candidate-finalize', completed: 0, total: 1 })
      finalizations.push(await callAdapter(this.finalizeCandidate, {
        candidateId: candidate.candidateId,
        candidatePath: candidate.candidatePath,
        candidateRoot: this.candidateRoot,
        parentReleaseId: candidate.parentReleaseId,
        action: 'installMany',
        packages: resolved.map(entry => ({ packageName: entry.packageName, source: cloneValue(entry.source) })),
        profile: cloneValue(profile),
        signal,
        onProgress: progress,
      }, 'finalizeCandidate'))
      progress({ phase: 'candidate-finalize', completed: 1, total: 1 })
    }
    const combinedScripts = {
      manifest: reports.flatMap(report => report.manifest),
      entries: reports.flatMap(report => report.entries),
      allowed: reports.flatMap(report => report.allowed),
      blocked: reports.flatMap(report => report.blocked),
    }
    const gates = [await this.gate(
      candidate,
      'installMany',
      profile,
      resolved.map(entry => entry.source),
      combinedScripts,
      signal,
      progress,
    )]
    throwIfAborted(signal)
    progress({ phase: 'complete', completed: 1, total: 1 })
    const packages = diffPackages(beforeProfile, profile)
    const bundles = diffBundles(beforeProfile, profile)
    return {
      action: 'installMany',
      sources: resolved.map(entry => cloneValue(entry.source)),
      packageNames: resolved.map(entry => entry.packageName),
      packages,
      bundles,
      order: { before: bundles.before, after: bundles.after, changed: bundles.orderChanged },
      scripts: combinedScripts,
      gates: cloneValue(gates),
      ...(finalizations.length === 0 ? {} : { finalization: cloneValue(finalizations) }),
      candidate: {
        id: candidate.candidateId,
        path: candidate.candidatePath,
        ...(candidate.parentReleaseId === undefined ? {} : { parentReleaseId: candidate.parentReleaseId }),
      },
      candidateId: candidate.candidateId,
      candidatePath: candidate.candidatePath,
      ...(candidate.parentReleaseId === undefined ? {} : { parentReleaseId: candidate.parentReleaseId }),
    }
  }

  async update(input = {}) { return this.mutate('update', input) }

  async setEnabled(input = {}) { return this.mutate('setEnabled', input) }

  async replaceSource(input = {}) { return this.mutate('replaceSource', input) }

  async reorder(input = {}) { return this.mutate('reorder', input) }

  async configure(input = {}) { return this.mutate('configure', input) }

  async promoteLocal(input = {}) { return this.mutate('promoteLocal', input) }

  async transaction(input = {}) {
    assertPlainObject(input, 'transaction input')
    if (typeof input.action !== 'string') throw new TypeError('transaction action is required')
    return this.mutate(input.action, input)
  }

  async run(input = {}) { return this.transaction(input) }

  async removePreview(input = {}) {
    assertPlainObject(input, 'removePreview input')
    assertKnownFields(input, new Set(['name', 'candidateId', 'candidatePath', 'snapshotPath', 'recoveryPath', 'profile', 'signal']), 'removePreview input')
    const name = assertPluginName(input.name)
    const signal = input.signal
    throwIfAborted(signal)
    const candidate = this.nextCandidate(input)
    let profile
    let clonedCandidate = candidate
    if (input.profile !== undefined) {
      assertPlainObject(input.profile, 'Preview profile')
      profile = cloneValue(input.profile)
    } else if (typeof this.readActiveProfile === 'function') {
      const result = await callAdapter(this.readActiveProfile, { name, candidateRoot: this.candidateRoot, signal }, 'readActiveProfile')
      profile = cloneValue(unwrapProfile(result))
      assertPlainObject(profile, 'Active profile')
    } else {
      clonedCandidate = await this.cloneCandidate(candidate, 'removePreview', signal)
      profile = await this.readProfile(clonedCandidate, 'removePreview', signal)
    }
    if (dependencyRecord(profile, name) === undefined) throw new Error(`Plugin ${name} is not installed`)
    const snapshotPath = assertCandidatePath(
      this.candidateRoot,
      input.snapshotPath ?? join(this.candidateRoot, `${clonedCandidate.candidateId}-removal-snapshot`),
      'Removal snapshot path',
    )
    const recoveryPath = assertCandidatePath(
      this.candidateRoot,
      input.recoveryPath ?? join(this.candidateRoot, `${clonedCandidate.candidateId}-removal-recovery`),
      'Removal recovery path',
    )
    const exactPackages = [dependencyRecord(profile, name), ...findDependentPackages(profile, name).map(dependent => dependencyRecord(profile, dependent)).filter(Boolean)]
    const dependentBundles = findDependentBundles(profile, name)
    const profileFingerprint = removalFingerprint(profile, name)
    const digestPayload = {
      name,
      packages: exactPackages,
      dependentBundles,
      snapshotPath,
      recoveryPath,
      profileFingerprint,
    }
    const previewDigest = digest(digestPayload)
    const confirmationToken = `remove:${previewDigest}`
    const preview = {
      action: 'removePreview',
      type: 'removal-preview',
      name,
      packages: cloneValue(exactPackages),
      dependentPackages: findDependentPackages(profile, name),
      dependentBundles: [...dependentBundles],
      snapshotPath,
      recoveryPath,
      previewDigest,
      confirmationToken,
      profileFingerprint,
      candidate: { id: clonedCandidate.candidateId, path: clonedCandidate.candidatePath },
      candidateId: clonedCandidate.candidateId,
      candidatePath: clonedCandidate.candidatePath,
    }
    this.previews.set(previewDigest, cloneValue(preview))
    throwIfAborted(signal)
    return preview
  }

  async confirmRemove(input = {}) {
    assertPlainObject(input, 'confirmRemove input')
    assertKnownFields(input, new Set(['name', 'previewDigest', 'confirmationToken', 'candidateId', 'candidatePath', 'signal']), 'confirmRemove input')
    const name = assertPluginName(input.name)
    if (typeof input.previewDigest !== 'string' || !SHA256.test(input.previewDigest)) throw new RemovalConfirmationError()
    if (typeof input.confirmationToken !== 'string' || !SAFE_TOKEN.test(input.confirmationToken)) throw new RemovalConfirmationError()
    const preview = this.previews.get(input.previewDigest)
    if (preview === undefined || preview.confirmationToken !== input.confirmationToken || preview.name !== name) throw new RemovalConfirmationError()
    if ((input.candidateId !== undefined && input.candidateId !== preview.candidateId)
      || (input.candidatePath !== undefined && resolve(input.candidatePath) !== preview.candidatePath)) {
      throw new RemovalConfirmationError('Removal confirmation does not match the preview candidate')
    }
    return this.mutate('remove', {
      name,
      previewDigest: input.previewDigest,
      confirmationToken: input.confirmationToken,
      candidateId: preview.candidateId,
      candidatePath: preview.candidatePath,
      signal: input.signal,
    })
  }
}

export function createPluginTransactionService(options) {
  return new PluginTransactionService(options)
}

export const createPluginTransaction = createPluginTransactionService
export default createPluginTransactionService
