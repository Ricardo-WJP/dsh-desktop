import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve as resolvePath } from 'node:path'

const MODES = new Set(['dev', 'stable', 'next'])
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]{0,127}\/)?[a-z0-9][a-z0-9._-]{0,127}$/i
const NPM_TAG = /^[a-z0-9][a-z0-9._-]{0,127}$/i
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const EXACT_COMMIT = /^[a-f0-9]{40}$/i
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/
const GITHUB_OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i
const GITHUB_REPOSITORY = /^[a-z0-9][a-z0-9._-]{0,99}$/i
const GITHUB_REF = /^[a-z0-9][a-z0-9._/-]{0,127}$/i
const GITHUB_PATH = /^\/[a-z0-9][a-z0-9._/-]{0,255}$/i

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

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Source resolution aborted')
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal)
}

function invokeRunner(runner, args, signal, runnerOptions = {}) {
  if (typeof runner !== 'function') throw new TypeError('A command runner is required')
  if (!isPlainObject(runnerOptions)) throw new TypeError('Invalid command runner options')
  throwIfAborted(signal)

  const request = { ...runnerOptions, args: [...args], signal, shell: false }
  const invocation = runner.length >= 2
    ? () => runner(request.args, request)
    : () => runner(request)

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener?.('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject, abortError(signal))
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    let result
    try {
      result = invocation()
    } catch (error) {
      finish(reject, error)
      return
    }
    Promise.resolve(result).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    )
  })
}

function commandOutput(result, label) {
  if (typeof result === 'string') return result
  // Owned commands expose both the clean stdout stream and a combined output
  // stream. Node/pnpm warnings belong to stderr; parsing the combined stream
  // makes otherwise valid multi-line JSON impossible to decode.
  if (typeof result?.stdout === 'string') return result.stdout
  if (typeof result?.output === 'string') return result.output
  throw new Error(`${label} did not return command output`)
}

function parseJsonCandidates(output) {
  const candidates = []
  const trimmed = output.trim()
  if (trimmed !== '') {
    try { candidates.push(JSON.parse(trimmed)) } catch { /* try JSON lines below */ }
    for (const line of trimmed.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
      try { candidates.push(JSON.parse(line)) } catch { /* ignore non-JSON progress output */ }
    }
  }
  return candidates
}

function registryRecord(value) {
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string') {
      return { version: value[0], integrity: value[1] }
    }
    return value.length === 1 ? registryRecord(value[0]) : undefined
  }
  if (!isPlainObject(value)) return undefined
  const version = value.version
  const integrity = value.integrity
    ?? value['dist.integrity']
    ?? value.distIntegrity
    ?? value.dist?.integrity
  return typeof version === 'string' && typeof integrity === 'string' ? { version, integrity } : undefined
}

function parseRegistryMetadata(result) {
  const output = commandOutput(result, 'pnpm')
  for (const candidate of parseJsonCandidates(output)) {
    const record = registryRecord(candidate)
    if (record !== undefined) return record
  }
  const lines = output.trim().split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  if (lines.length === 2 && EXACT_VERSION.test(lines[0]) && INTEGRITY.test(lines[1])) {
    return { version: lines[0], integrity: lines[1] }
  }
  throw new Error('pnpm did not return an exact version and integrity')
}

function normalizePackage(value) {
  if (typeof value !== 'string' || !NPM_PACKAGE.test(value)) throw new TypeError('Invalid npm package')
  return value
}

function normalizeVersionOrTag(value) {
  if (value === undefined) return 'latest'
  if (typeof value !== 'string' || !NPM_TAG.test(value)) throw new TypeError('Invalid npm version or tag')
  return value
}

async function resolveNpm({ source, signal, runPnpm, pnpmOptions }) {
  const packageName = normalizePackage(source.package)
  const requested = normalizeVersionOrTag(source.versionOrTag)
  const result = await invokeRunner(
    runPnpm,
    ['view', `${packageName}@${requested}`, 'version', 'dist.integrity', '--json'],
    signal,
    pnpmOptions,
  )
  throwIfAborted(signal)
  const { version, integrity } = parseRegistryMetadata(result)
  if (!EXACT_VERSION.test(version) || !INTEGRITY.test(integrity)) {
    throw new Error('pnpm returned a non-exact version or invalid integrity')
  }
  if (EXACT_VERSION.test(requested) && version !== requested) {
    throw new Error(`Registry version did not match requested ${requested}`)
  }
  return Object.freeze({
    type: 'npm',
    package: packageName,
    version,
    integrity,
    specifier: `${packageName}@${version}`,
    promotable: true,
  })
}

function normalizeRepository(value) {
  if (typeof value !== 'string') throw new TypeError('Invalid GitHub repository')
  const parts = value.split('/')
  if (parts.length !== 2 || !GITHUB_OWNER.test(parts[0]) || !GITHUB_REPOSITORY.test(parts[1]) || parts[1].endsWith('.git')) {
    throw new TypeError('GitHub repository must use owner/repository form')
  }
  return `${parts[0]}/${parts[1]}`
}

function normalizeGitHubRef(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || (!EXACT_COMMIT.test(value) && (!GITHUB_REF.test(value) || value.includes('..') || value.includes('//') || value.endsWith('/')))) {
    throw new TypeError('Invalid GitHub ref')
  }
  return value
}

function normalizeGitHubPath(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !GITHUB_PATH.test(value) || value.includes('..') || value.includes('//') || value.endsWith('/')) {
    throw new TypeError('GitHub path must use /segment form')
  }
  return value
}

function parseGitCommit(result) {
  const output = commandOutput(result, 'git')
  for (const line of output.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{40})(?:\s+\S+)?$/i.exec(line.trim())
    if (match !== null) return match[1].toLowerCase()
  }
  throw new Error('git did not return an exact 40-character commit')
}

async function resolveGithub({ source, signal, runGit, gitOptions }) {
  const repository = normalizeRepository(source.repository)
  const ref = normalizeGitHubRef(source.ref)
  const path = normalizeGitHubPath(source.path)
  const remote = `https://github.com/${repository}.git`
  let commit
  if (ref !== undefined && EXACT_COMMIT.test(ref)) {
    commit = ref.toLowerCase()
  } else {
    const args = ref === undefined
      ? ['ls-remote', '--symref', remote, 'HEAD']
      : ['ls-remote', '--refs', remote, ref]
    commit = parseGitCommit(await invokeRunner(runGit, args, signal, gitOptions))
    throwIfAborted(signal)
  }
  const selector = `${commit}${path === undefined ? '' : `&path:${path}`}`
  return Object.freeze({
    type: 'github',
    repository,
    ref: commit,
    commit,
    ...(path === undefined ? {} : { path }),
    specifier: `github:${repository}#${selector}`,
    promotable: true,
  })
}

async function canonicalPath(value) {
  return realpath(resolvePath(value))
}

function isWithin(root, target) {
  const remainder = relative(root, target)
  return remainder === '' || (remainder !== '..' && !remainder.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(remainder))
}

async function resolveLocalDev({ source, mode, allowedRoots, signal }) {
  if (mode !== 'dev') throw new Error('local-dev sources are allowed only in dev mode')
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) throw new TypeError('Explicit allowedRoots are required for local-dev')
  if (typeof source.path !== 'string' || !isAbsolute(source.path)) throw new TypeError('local-dev path must be absolute')
  throwIfAborted(signal)
  const roots = await Promise.all(allowedRoots.map(async root => {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new TypeError('allowedRoots must contain absolute paths')
    return canonicalPath(root)
  }))
  const path = await canonicalPath(source.path)
  throwIfAborted(signal)
  if (!roots.some(root => isWithin(root, path))) throw new Error('local-dev path is outside allowedRoots')
  const link = `link:${path}`
  return Object.freeze({ type: 'local-dev', path, link, specifier: link, promotable: false })
}

/**
 * Resolve a structured source. The preferred call shape is
 * resolvePluginSource({ source, mode, allowedRoots, runPnpm, runGit, signal }).
 * Injected runners receive { args, signal, shell: false } and return either a
 * string or { output }/{ stdout }.
 */
export async function resolvePluginSource(first, second) {
  const envelope = isPlainObject(first) && (Object.hasOwn(first, 'source') || Object.hasOwn(first, 'sourceSpec'))
  const options = envelope ? first : (second ?? {})
  assertPlainObject(options, 'resolver options')
  const source = envelope ? (first.source ?? first.sourceSpec) : first
  assertPlainObject(source, 'source')
  if (typeof options.mode !== 'string' || !MODES.has(options.mode)) throw new TypeError('mode must be dev, stable, or next')
  const allowed = new Set(Object.keys(source))
  if (typeof source.type !== 'string') throw new TypeError('source.type is required')
  const fields = {
    npm: new Set(['type', 'package', 'versionOrTag']),
    github: new Set(['type', 'repository', 'ref', 'path']),
    'local-dev': new Set(['type', 'path']),
  }[source.type]
  if (fields === undefined) throw new TypeError(`Unsupported source type: ${source.type}`)
  assertKnownFields(source, fields, source.type)
  if (source.type === 'npm') return resolveNpm({ source, signal: options.signal, runPnpm: options.runPnpm ?? options.runPnpmImpl, pnpmOptions: options.pnpmOptions })
  if (source.type === 'github') return resolveGithub({ source, signal: options.signal, runGit: options.runGit ?? options.runGitImpl, gitOptions: options.gitOptions })
  return resolveLocalDev({ source, mode: options.mode, allowedRoots: options.allowedRoots, signal: options.signal })
}

export const resolveSource = resolvePluginSource
export const resolveProfileSource = resolvePluginSource
export default resolvePluginSource
