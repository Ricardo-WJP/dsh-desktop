import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import process from 'node:process'
import { promises as fs } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createChildSupervisor, createSpawnOptions } from '../src/process-tree.js'
import releaseUiFixture from '../test-support/release-ui-fixture.cjs'

const {
  CLIENT_SOURCE_RELATIVE_PATH,
  FIXTURE_SIMULATION_NOTE,
  extractClientUiContract,
} = releaseUiFixture

export const RELEASE_ACCEPTANCE_SCHEMA_VERSION = 1
export const DEFAULT_RELEASE_ACCEPTANCE_TIMEOUT_MS = 180_000
export const DEFAULT_NATIVE_DATA_SMOKE_TIMEOUT_MS = 120_000

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url))
const TARGET_PLATFORMS = Object.freeze({ windows: 'win32', mac: 'darwin', linux: 'linux' })
const ACCEPTANCE_OUTPUT_DIRECTORY = 'output/release-acceptance'
const RESULT_PREFIX = 'RELEASE_ACCEPTANCE_RESULT '
const CI_WINDOWS_HEADLESS_SCALE = '0.625'
const FAILURE_DIAGNOSTIC_FILES = Object.freeze([
  'report.json',
  'receipt.json',
  'release-acceptance-artifact.json',
  'release-ui-fixture.stdout.log',
  'release-ui-fixture.stderr.log',
])
const INPUT_WALK_ROOTS = Object.freeze(['src', 'scripts', 'build', 'profiles', 'compatibility', 'assets'])
const INPUT_PACKAGE_FILES = Object.freeze(['package.json', 'package-lock.json'])
export const RELEASE_ACCEPTANCE_INPUT_EXCLUSIONS = Object.freeze([
  'generated renderer/preload/plugin-suite binaries',
  'output/temp/dist/artifacts/backups/.git/.playwright-cli/node_modules directories',
  'explicit secret data files (.env/.credentials/*secret*.json and related data files)',
  'private-key/certificate extensions (.pem/.key/.p12/.pfx/.crt/.cer/.der/.jks)',
])

// Kept as a small explicit compatibility seed for callers that want to pass a
// fixed manifest. The release runner itself discovers the full safe input set.
export const DEFAULT_RELEASE_ACCEPTANCE_INPUTS = Object.freeze([
  'package.json',
  'package-lock.json',
  'scripts/build-desktop.mjs',
  'scripts/release-acceptance.mjs',
  'test/release-acceptance.test.js',
  'test-support/release-ui-fixture.cjs',
])

const SECRET_INPUT_PATTERN = /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.credentials\.(?:json|ya?ml|toml|ini|conf|txt)|credentials\.(?:json|ya?ml|toml|ini|conf|txt)|[^\\/]*(?:secret|secrets)\.(?:json|ya?ml|toml|ini|conf|txt))$|\.(?:pem|key|p12|pfx|crt|cer|der|jks)$/iu
const EXCLUDED_INPUT_DIRECTORY_PATTERN = /(^|[\\/])(output|outputs|temp|tmp|dist|artifacts|backups|node_modules|\.git|\.playwright-cli)([\\/]|$)/iu
const EXCLUDED_INPUT_NAME_PATTERN = /(^|[\\/])\.tmp(?:[._-]|$)/iu
const GENERATED_BUILD_DIRECTORY_PATTERN = /^build\/(?:renderer|preload|plugin-suite\/bin)(?:\/|$)/iu

function isExcludedInputPath(pathName, { generatedBuild = false } = {}) {
  const normalized = String(pathName).replaceAll('\\', '/')
  if (EXCLUDED_INPUT_DIRECTORY_PATTERN.test(`/${normalized}`)) return true
  if (EXCLUDED_INPUT_NAME_PATTERN.test(`/${normalized}`)) return true
  if (SECRET_INPUT_PATTERN.test(`/${normalized}`)) return true
  return generatedBuild && GENERATED_BUILD_DIRECTORY_PATTERN.test(normalized)
}

async function walkInputRoot(root, relativeRoot, { packageFilesOnly = false, generatedBuild = false } = {}) {
  const found = []
  const visit = async currentRelative => {
    const absolute = resolve(root, currentRelative)
    let entries
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const childRelative = `${currentRelative}/${entry.name}`
      if (isExcludedInputPath(childRelative, { generatedBuild })) continue
      if (entry.isDirectory()) {
        await visit(childRelative)
        continue
      }
      if (!entry.isFile()) continue
      if (packageFilesOnly && !/(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/u.test(childRelative)) continue
      found.push(childRelative)
    }
  }
  await visit(relativeRoot)
  return found
}

export async function discoverReleaseAcceptanceInputFiles(root = DEFAULT_ROOT) {
  const rootPath = resolve(assertNonEmptyString(root, 'release acceptance root'))
  const found = []
  for (const file of INPUT_PACKAGE_FILES) {
    if (!isExcludedInputPath(file)) found.push(file)
  }
  for (const relativeRoot of INPUT_WALK_ROOTS) {
    found.push(...await walkInputRoot(rootPath, relativeRoot, {
      packageFilesOnly: false,
      generatedBuild: relativeRoot === 'build',
    }))
  }
  found.push('LICENSE', 'NOTICE.md', 'vite.config.ts', 'tsconfig.json', 'test/release-acceptance.test.js', 'test-support/release-ui-fixture.cjs')
  const unique = [...new Set(found.filter(pathName => !isExcludedInputPath(pathName)))]
  unique.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  return Object.freeze(unique)
}

function normalizeSuiteReceipt(receipt) {
  if (receipt === undefined || receipt === null) return null
  if (typeof receipt !== 'object') throw new TypeError('Invalid suite asset receipt')
  const stringField = name => typeof receipt[name] === 'string' && receipt[name].trim() !== '' ? receipt[name] : null
  return Object.freeze({
    schemaVersion: Number.isInteger(receipt.schemaVersion) ? receipt.schemaVersion : null,
    platform: stringField('platform'),
    arch: stringField('arch'),
    version: stringField('version'),
    executable: stringField('executable'),
    archive: stringField('archive'),
    archiveSha256: stringField('archiveSha256'),
    binarySha256: stringField('binarySha256'),
    source: stringField('source'),
  })
}

function normalizeBuildSelection({ target, flavor = 'base', suiteReceipt, selection } = {}) {
  const selectedTarget = selection?.target ?? target
  const selectedFlavor = selection?.flavor ?? flavor
  if (selectedTarget !== target) throw new TypeError('Release acceptance target does not match the selected build target')
  assertNonEmptyString(selectedFlavor, 'release build flavor')
  const rawReceipt = selection?.suiteReceipt ?? suiteReceipt
  return Object.freeze({
    target,
    flavor: selectedFlavor,
    suite: selectedFlavor === 'suite',
    suiteReceipt: normalizeSuiteReceipt(rawReceipt),
  })
}

function suiteInputFiles(root, selection, suiteReceipt) {
  if (selection.flavor !== 'suite') return []
  const paths = [
    join(root, 'build', 'electron-builder.suite.cjs'),
    join(root, 'build', 'plugin-suite', 'mnemon-assets.json'),
  ]
  // Generated suite binaries/receipts stay outside the source content
  // manifest. Their pinned hashes are carried in selection.suiteReceipt and
  // are checked separately, so output bytes cannot silently become inputs.
  void suiteReceipt
  return paths.map(path => {
    const absolutePath = resolve(path)
    if (!isPathInside(root, absolutePath)) throw new TypeError('Suite acceptance input escapes the repository root')
    return relativeUnixPath(root, absolutePath)
  })
}

function acceptanceInputFiles(root, inputFiles, selection, suiteReceipt) {
  if (!Array.isArray(inputFiles)) throw new TypeError('Release acceptance input files must be an array')
  return [...new Set([...inputFiles, ...suiteInputFiles(root, selection, suiteReceipt)])]
}

async function verifySuiteReceipt(root, selection, rawReceipt) {
  if (selection.flavor !== 'suite' || selection.suiteReceipt === null) return null
  const receipt = rawReceipt ?? {}
  const resolveSuitePath = value => {
    if (typeof value !== 'string' || value.trim() === '') return undefined
    const path = resolve(value)
    if (!isPathInside(root, path)) throw errorWithCode('Suite receipt path escapes the repository root', 'RELEASE_ACCEPTANCE_SUITE_PATH')
    return path
  }
  const receiptPath = resolveSuitePath(receipt.receiptPath ?? (typeof receipt.directory === 'string' ? join(receipt.directory, 'receipt.json') : undefined))
  const executablePath = resolveSuitePath(receipt.executablePath ?? (typeof receipt.directory === 'string' && typeof selection.suiteReceipt.executable === 'string'
    ? join(receipt.directory, selection.suiteReceipt.executable)
    : undefined))
  if (receiptPath === undefined && executablePath === undefined) return { verified: false, reason: 'metadata-only' }
  if (receiptPath !== undefined) {
    let onDisk
    try { onDisk = JSON.parse(await fs.readFile(receiptPath, 'utf8')) } catch (error) {
      throw errorWithCode(`Suite receipt could not be read: ${asError(error).message}`, 'RELEASE_ACCEPTANCE_SUITE_RECEIPT_INVALID', error)
    }
    if (JSON.stringify(normalizeSuiteReceipt(onDisk)) !== JSON.stringify(selection.suiteReceipt)) {
      throw errorWithCode('Suite receipt metadata changed after preparation', 'RELEASE_ACCEPTANCE_SUITE_RECEIPT_CHANGED')
    }
  }
  let executable
  if (executablePath !== undefined) {
    executable = await hashFile(executablePath)
    if (selection.suiteReceipt.binarySha256 !== null && executable.sha256 !== selection.suiteReceipt.binarySha256) {
      throw errorWithCode('Suite executable bytes do not match its receipt', 'RELEASE_ACCEPTANCE_SUITE_BINARY_CHANGED')
    }
  }
  return {
    verified: true,
    receiptPath,
    executablePath,
    binarySha256: executable?.sha256 ?? selection.suiteReceipt.binarySha256,
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function asError(value, fallback = 'Release acceptance failed') {
  if (value instanceof Error) return value
  return new Error(value === undefined ? fallback : String(value))
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw asError(signal.reason, 'Release acceptance aborted')
}

function errorWithCode(message, code, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = code
  return error
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`Invalid ${name}`)
  return value
}

function isPathInside(root, candidate) {
  const rootPath = resolve(root)
  const candidatePath = resolve(candidate)
  const remainder = relative(rootPath, candidatePath)
  return remainder === '' || (!remainder.startsWith(`..${sep}`) && remainder !== '..' && !isAbsolute(remainder))
}

function resolveInputPath(root, inputPath) {
  assertNonEmptyString(inputPath, 'release acceptance input path')
  const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath)
  if (!isPathInside(root, absolutePath) || absolutePath === resolve(root)) {
    throw new TypeError(`Release acceptance input must stay inside root: ${inputPath}`)
  }
  return absolutePath
}

function relativeUnixPath(root, absolutePath) {
  return relative(resolve(root), resolve(absolutePath)).split(sep).join('/')
}

export async function hashReleaseInputFiles(root, inputFiles, { selection } = {}) {
  assertNonEmptyString(root, 'release acceptance root')
  const resolvedInputFiles = inputFiles === undefined ? await discoverReleaseAcceptanceInputFiles(root) : inputFiles
  if (!Array.isArray(resolvedInputFiles) || resolvedInputFiles.length === 0 || resolvedInputFiles.some(value => typeof value !== 'string' || value.trim() === '')) {
    throw new TypeError('Release acceptance requires a non-empty input file list')
  }
  const rootPath = resolve(root)
  const seen = new Set()
  const files = []
  for (const inputPath of resolvedInputFiles) {
    if (isExcludedInputPath(inputPath, { generatedBuild: true })) {
      throw new TypeError(`Release acceptance input is excluded from the content manifest: ${inputPath}`)
    }
    const absolutePath = resolveInputPath(rootPath, inputPath)
    const pathName = relativeUnixPath(rootPath, absolutePath)
    if (seen.has(pathName)) throw new TypeError(`Duplicate release acceptance input: ${pathName}`)
    seen.add(pathName)
    const bytes = await fs.readFile(absolutePath)
    files.push({
      path: pathName,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    })
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const fileCanonical = files.map(file => `${file.path}\0${String(file.bytes)}\0${file.sha256}`).join('\n')
  // Preserve the simple file-only digest for callers that use this helper as
  // a generic content hash. Release runs always provide the selected build
  // metadata, so base and suite/target receipts cannot share a fingerprint.
  const canonical = selection === undefined
    ? fileCanonical
    : JSON.stringify({ files, selection })
  return Object.freeze({
    algorithm: 'sha256',
    files: Object.freeze(files.map(file => Object.freeze(file))),
    fingerprint: sha256(canonical),
  })
}

async function hashFile(absolutePath) {
  const bytes = await fs.readFile(absolutePath)
  const digest = sha256(bytes)
  return { path: absolutePath, bytes: bytes.byteLength, sha256: digest, bytesSha256: digest }
}

async function optionalHashFile(absolutePath) {
  try {
    return await hashFile(absolutePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function writeJsonExclusive(path, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  await fs.writeFile(path, serialized, { encoding: 'utf8', flag: 'wx' })
}

function platformVerification(target) {
  const hostPlatform = process.platform
  const expectedPlatform = target === 'all' ? hostPlatform : TARGET_PLATFORMS[target]
  const targetPlatformVerified = expectedPlatform === hostPlatform
  return Object.freeze({
    hostPlatform,
    requestedTarget: target,
    targetPlatform: expectedPlatform ?? 'unknown',
    targetPlatformVerified,
    scope: 'local Electron fixture UI only',
    note: targetPlatformVerified
      ? 'Only the host-platform fixture UI was checked; this is not actual DSH end-to-end coverage.'
      : `Cross-platform package target ${String(target)} was not verified; only host-platform fixture UI was checked.`,
  })
}

function validateTarget(target) {
  if (typeof target !== 'string' || !['all', ...Object.keys(TARGET_PLATFORMS)].includes(target)) {
    throw new TypeError(`Invalid desktop release target: ${String(target)}`)
  }
  return target
}

function validateTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) {
    throw new TypeError('Release acceptance timeout must be an integer between 1 and 600000 ms')
  }
  return timeoutMs
}

function resolveElectronExecutable(root, supplied) {
  if (supplied !== undefined) return assertNonEmptyString(supplied, 'Electron executable')
  let electronPath
  try {
    const rootPackage = join(resolve(root), 'package.json')
    electronPath = createRequire(rootPackage)('electron')
  } catch {
    electronPath = createRequire(import.meta.url)('electron')
  }
  return assertNonEmptyString(electronPath, 'Electron executable')
}

function resolveFixturePath(root, supplied) {
  const fixturePath = supplied === undefined
    ? join(resolve(root), 'test-support', 'release-ui-fixture.cjs')
    : resolveInputPath(root, supplied)
  return fixturePath
}

function normalizeFixtureResult(result, { isDefault, inputFingerprint }) {
  if (result === undefined || result === null || typeof result !== 'object') {
    throw errorWithCode('Release UI fixture returned no result', 'RELEASE_ACCEPTANCE_EMPTY_FIXTURE')
  }
  if (result.ok !== true) {
    throw errorWithCode(`Release UI fixture failed: ${result.error ?? JSON.stringify(result.failures ?? result)}`, 'RELEASE_ACCEPTANCE_FIXTURE_FAILED')
  }
  if (result.actualDshE2E === true) {
    throw errorWithCode('Release acceptance fixture cannot claim actual DSH end-to-end coverage', 'RELEASE_ACCEPTANCE_FALSE_E2E_CLAIM')
  }
  if (isDefault) {
    if (result.simulation !== true || result.actualDshE2E !== false) {
      throw errorWithCode('Release UI fixture did not identify itself as simulation-only', 'RELEASE_ACCEPTANCE_FIXTURE_IDENTITY')
    }
    if (result.inputFingerprint !== inputFingerprint) {
      throw errorWithCode('Release UI fixture input fingerprint is stale', 'RELEASE_ACCEPTANCE_STALE_FIXTURE_FINGERPRINT')
    }
    if (result.browserWindow?.isVisible !== false) {
      throw errorWithCode('Release UI fixture BrowserWindow was not verified hidden', 'RELEASE_ACCEPTANCE_VISIBLE_FIXTURE_WINDOW')
    }
    if (result.browserWindow?.userDataIsolated !== true || result.browserWindow?.tempIsolated !== true) {
      throw errorWithCode('Release acceptance fixture did not verify isolated Electron userData/temp paths', 'RELEASE_ACCEPTANCE_NON_ISOLATED_FIXTURE')
    }
    if (Array.isArray(result.networkRequests) && result.networkRequests.length !== 0) {
      throw errorWithCode('Release UI fixture attempted a network request', 'RELEASE_ACCEPTANCE_NETWORK_REQUEST')
    }
  }
  return Object.freeze({
    ...result,
    simulation: result.simulation === true ? true : 'injected-test-double',
    actualDshE2E: false,
    note: typeof result.note === 'string' && result.note.length > 0 ? result.note : FIXTURE_SIMULATION_NOTE,
  })
}

function candidateInput(options) {
  if (options.candidate !== undefined) {
    if (typeof options.candidate === 'string') return { path: options.candidate }
    if (options.candidate instanceof Uint8Array || options.candidate instanceof ArrayBuffer) return { bytes: options.candidate }
    if (options.candidate !== null && typeof options.candidate === 'object') return options.candidate
    throw new TypeError('Invalid release candidate input')
  }
  if (options.candidatePath !== undefined) return { path: options.candidatePath }
  if (options.candidateBytes !== undefined) return { bytes: options.candidateBytes }
  return undefined
}

function copyCandidateBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value)).subarray(0)
  if (value instanceof Uint8Array) return Buffer.from(value).subarray(0)
  throw new TypeError('Release candidate bytes must be a string, ArrayBuffer, or Uint8Array')
}

async function snapshotCandidate(root, input, previous) {
  if (input === undefined) return undefined
  if (input === null || typeof input !== 'object') throw new TypeError('Invalid release candidate input')
  if (input.path !== undefined) {
    const path = isAbsolute(input.path) ? resolve(input.path) : resolve(root, input.path)
    const info = await hashFile(path)
    return {
      kind: 'path',
      path,
      relativePath: isPathInside(root, path) ? relativeUnixPath(root, path) : undefined,
      bytesSha256: info.sha256,
      bytes: info.bytes,
    }
  }
  if (input.bytes !== undefined) {
    const bytes = previous?.kind === 'bytes' ? previous.bytes : copyCandidateBytes(input.bytes)
    return {
      kind: 'bytes',
      bytes,
      bytesSha256: sha256(bytes),
      bytesLength: bytes.byteLength,
    }
  }
  throw new TypeError('Release candidate input requires path or bytes')
}

function candidateForGate(snapshot) {
  if (snapshot === undefined) return undefined
  const value = {
    kind: snapshot.kind,
    path: snapshot.path,
    relativePath: snapshot.relativePath,
    bytesSha256: snapshot.bytesSha256,
    bytes: snapshot.bytes,
    bytesLength: snapshot.bytesLength ?? snapshot.bytes,
  }
  return value
}

function candidateSummary(snapshot) {
  if (snapshot === undefined) return null
  return {
    kind: snapshot.kind,
    path: snapshot.path,
    relativePath: snapshot.relativePath,
    bytes: snapshot.bytesLength ?? snapshot.bytes,
    bytesSha256: snapshot.bytesSha256,
  }
}

function artifactForGate(path, snapshot, inputFingerprint) {
  return Object.freeze({
    path,
    bytes: snapshot.bytes,
    bytesSha256: snapshot.sha256,
    inputFingerprint,
  })
}

function fingerprintFromGateResult(result) {
  if (typeof result?.inputFingerprint === 'string') return result.inputFingerprint
  if (typeof result?.fingerprint === 'string') return result.fingerprint
  if (typeof result?.inputSha256 === 'string') return result.inputSha256
  if (typeof result?.fingerprint?.inputFingerprint === 'string') return result.fingerprint.inputFingerprint
  return undefined
}

function artifactFingerprintFromGateResult(result) {
  if (typeof result?.artifactBytesSha256 === 'string') return result.artifactBytesSha256
  if (typeof result?.artifactSha256 === 'string') return result.artifactSha256
  if (typeof result?.artifact?.bytesSha256 === 'string') return result.artifact.bytesSha256
  return undefined
}

function candidateFingerprintFromGateResult(result) {
  if (typeof result?.candidateBytesSha256 === 'string') return result.candidateBytesSha256
  if (typeof result?.candidateSha256 === 'string') return result.candidateSha256
  if (typeof result?.candidate?.bytesSha256 === 'string') return result.candidate.bytesSha256
  return undefined
}

function nativeReportFingerprintFromGateResult(result) {
  if (typeof result?.nativeReportSha256 === 'string') return result.nativeReportSha256
  if (typeof result?.nativeDataSmoke?.reportSha256 === 'string') return result.nativeDataSmoke.reportSha256
  return undefined
}

function nativeRuntimeFingerprintFromGateResult(result) {
  if (typeof result?.nativeRuntimeEntrySha256 === 'string') return result.nativeRuntimeEntrySha256
  if (typeof result?.nativeDataSmoke?.runtimeEntrySha256 === 'string') return result.nativeDataSmoke.runtimeEntrySha256
  return undefined
}

function validateGateResult(result, { inputFingerprint, artifact, candidate, nativeDataSmoke }) {
  if (result === undefined || result === null) {
    throw errorWithCode('Release acceptance gate returned undefined/empty success', 'RELEASE_ACCEPTANCE_EMPTY_GATE_RESULT')
  }
  if (typeof result !== 'object' || result.ok !== true) {
    throw errorWithCode(`Release acceptance gate rejected the build: ${result?.error ?? JSON.stringify(result)}`, 'RELEASE_ACCEPTANCE_GATE_REJECTED')
  }
  const reportedInputFingerprint = fingerprintFromGateResult(result)
  if (reportedInputFingerprint === undefined) {
    throw errorWithCode('Release acceptance gate returned ok without the current input fingerprint', 'RELEASE_ACCEPTANCE_EMPTY_GATE_FINGERPRINT')
  }
  if (reportedInputFingerprint !== inputFingerprint) {
    throw errorWithCode('Release acceptance gate returned a stale input fingerprint', 'RELEASE_ACCEPTANCE_STALE_FINGERPRINT')
  }
  const reportedArtifactFingerprint = artifactFingerprintFromGateResult(result)
  if (reportedArtifactFingerprint !== artifact.bytesSha256) {
    throw errorWithCode('Release acceptance gate artifact bytes do not match this run', 'RELEASE_ACCEPTANCE_STALE_ARTIFACT')
  }
  const reportedCandidateFingerprint = candidateFingerprintFromGateResult(result)
  if (candidate === undefined) {
    if (reportedCandidateFingerprint !== undefined && reportedCandidateFingerprint !== null) {
      throw errorWithCode('Release acceptance gate supplied a candidate fingerprint without a candidate', 'RELEASE_ACCEPTANCE_UNBOUND_CANDIDATE')
    }
  } else if (reportedCandidateFingerprint !== candidate.bytesSha256) {
    throw errorWithCode('Release acceptance gate candidate bytes do not match this run', 'RELEASE_ACCEPTANCE_STALE_CANDIDATE')
  }
  if (nativeDataSmoke !== undefined) {
    if (nativeReportFingerprintFromGateResult(result) !== nativeDataSmoke.reportSha256
      || nativeRuntimeFingerprintFromGateResult(result) !== nativeDataSmoke.runtimeEntrySha256) {
      throw errorWithCode('Release acceptance gate did not bind the native data smoke report/runtime', 'RELEASE_ACCEPTANCE_STALE_NATIVE_REPORT')
    }
  }
  return Object.freeze({
    ok: true,
    inputFingerprint,
    artifactBytesSha256: artifact.bytesSha256,
    ...(candidate === undefined ? { candidateBytesSha256: null } : { candidateBytesSha256: candidate.bytesSha256 }),
    ...(nativeDataSmoke === undefined ? {} : {
      nativeReportSha256: nativeDataSmoke.reportSha256,
      nativeRuntimeEntrySha256: nativeDataSmoke.runtimeEntrySha256,
    }),
    ...(result.checks === undefined ? {} : { checks: result.checks }),
  })
}

export async function defaultReleaseAcceptanceGate({ fixtureResult, inputFingerprint, artifact, candidate, nativeDataSmoke }) {
  if (fixtureResult?.ok !== true) return { ok: false, error: 'fixture failed' }
  return {
    ok: true,
    inputFingerprint,
    artifactBytesSha256: artifact.bytesSha256,
    candidateBytesSha256: candidate?.bytesSha256 ?? null,
    ...(nativeDataSmoke === undefined ? {} : {
      nativeReportSha256: nativeDataSmoke.reportSha256,
      nativeRuntimeEntrySha256: nativeDataSmoke.runtimeEntrySha256,
    }),
    checks: fixtureResult.checks ?? {},
  }
}

function safeFixtureArtifact(result) {
  return {
    ok: result.ok === true,
    simulation: result.simulation,
    actualDshE2E: false,
    note: result.note ?? FIXTURE_SIMULATION_NOTE,
    inputFingerprint: result.inputFingerprint ?? null,
    client: result.client ?? null,
    browserWindow: result.browserWindow
      ? {
          show: result.browserWindow.show,
          isVisible: result.browserWindow.isVisible,
          userDataPath: result.browserWindow.userDataPath ?? null,
          tempPath: result.browserWindow.tempPath ?? null,
          userDataIsolated: result.browserWindow.userDataIsolated ?? false,
          tempIsolated: result.browserWindow.tempIsolated ?? false,
        }
      : null,
    networkRequests: Array.isArray(result.networkRequests) ? result.networkRequests : [],
    checks: result.checks ?? {},
    failures: result.failures ?? [],
    viewport: result.viewport ?? null,
  }
}

function buildArtifact({ runId, inputManifest, fixtureResult, nativeDataSmoke, screenshot, platform, selection, suiteReceiptVerification, generatedAt }) {
  return {
    schemaVersion: RELEASE_ACCEPTANCE_SCHEMA_VERSION,
    kind: 'dsh-desktop-release-acceptance-fixture-artifact',
    runId,
    generatedAt,
    selection,
    flavor: selection.flavor,
    target: selection.target,
    suiteReceiptVerification,
    inputFingerprint: inputManifest.fingerprint,
    inputFiles: inputManifest.files,
    inputExclusionPolicy: RELEASE_ACCEPTANCE_INPUT_EXCLUSIONS,
    clientSource: {
      path: CLIENT_SOURCE_RELATIVE_PATH,
      sha256: inputManifest.files.find(file => file.path === CLIENT_SOURCE_RELATIVE_PATH)?.sha256 ?? null,
      extractedCssSha256: fixtureResult.client?.cssSha256 ?? null,
      normalizedLabelSha256: fixtureResult.client?.normalizedLabelSha256 ?? null,
    },
    fixture: safeFixtureArtifact(fixtureResult),
    nativeDataSmoke: nativeDataSmokeSummary(nativeDataSmoke),
    screenshot: screenshot === undefined ? null : screenshot,
    verification: {
      ...platform,
      selectedFlavor: selection.flavor,
      selectedTarget: selection.target,
      fixtureSimulation: true,
      actualDshE2E: false,
      fullE2E: 'not-run; main agent integration remains required',
    },
  }
}

function buildReport(state, status, error, extra = {}) {
  const report = {
    schemaVersion: RELEASE_ACCEPTANCE_SCHEMA_VERSION,
    status,
    ok: status === 'passed',
    runId: state.runId,
    generatedAt: new Date().toISOString(),
    outputDir: state.outputDir,
    reportPath: state.reportPath,
    artifactPath: state.artifactPath,
    receiptPath: state.receiptPath,
    phase: state.phase,
    selection: state.selection,
    flavor: state.selection?.flavor ?? null,
    target: state.selection?.target ?? null,
    suiteReceiptVerification: state.suiteReceiptVerification ?? null,
    inputFingerprint: state.inputManifest?.fingerprint ?? null,
    inputFiles: state.inputManifest?.files ?? [],
    inputExclusionPolicy: RELEASE_ACCEPTANCE_INPUT_EXCLUSIONS,
    inputFingerprintAfter: state.inputManifestAfter?.fingerprint ?? null,
    artifact: state.artifact
      ? { path: state.artifact.path, bytes: state.artifact.bytes, bytesSha256: state.artifact.bytesSha256 }
      : null,
    candidate: candidateSummary(state.candidate),
    nativeDataSmoke: nativeDataSmokeSummary(state.nativeDataSmoke),
    fixtureSimulation: true,
    actualDshE2E: false,
    fullE2E: 'not-run; main agent integration remains required',
    note: FIXTURE_SIMULATION_NOTE,
    verification: state.platform,
    fixture: state.fixtureResult ? safeFixtureArtifact(state.fixtureResult) : null,
    gate: state.gateResult ?? null,
    ...(error === undefined ? {} : {
      error: {
        name: error.name,
        code: error.code ?? null,
        message: error.message,
      },
    }),
    ...extra,
  }
  return report
}

function buildReceipt(state, status, error) {
  return {
    schemaVersion: RELEASE_ACCEPTANCE_SCHEMA_VERSION,
    kind: 'dsh-desktop-release-acceptance-receipt',
    status,
    ok: status === 'passed',
    runId: state.runId,
    generatedAt: new Date().toISOString(),
    selection: state.selection,
    flavor: state.selection?.flavor ?? null,
    target: state.selection?.target ?? null,
    suiteReceiptVerification: state.suiteReceiptVerification ?? null,
    inputFingerprint: state.inputManifest?.fingerprint ?? null,
    inputFiles: state.inputManifest?.files ?? [],
    inputExclusionPolicy: RELEASE_ACCEPTANCE_INPUT_EXCLUSIONS,
    artifact: state.artifact
      ? { path: state.artifact.path, bytes: state.artifact.bytes, bytesSha256: state.artifact.bytesSha256 }
      : null,
    nativeDataSmoke: nativeDataSmokeSummary(state.nativeDataSmoke),
    verification: {
      ...state.platform,
      selectedFlavor: state.selection?.flavor ?? null,
      selectedTarget: state.selection?.target ?? null,
      fixtureSimulation: true,
      actualDshE2E: false,
      fullE2E: 'not-run; main agent integration remains required',
    },
    ...(error === undefined ? {} : {
      error: { name: error.name, code: error.code ?? null, message: error.message },
    }),
  }
}

async function writeReceipt(state, status, error) {
  if (state.receiptPromise !== undefined) return state.receiptPromise
  state.receiptPromise = writeJsonExclusive(state.receiptPath, buildReceipt(state, status, error)).then(() => {
    state.receiptWritten = true
  })
  return state.receiptPromise
}

async function writeFailureReport(state, error) {
  if (state.reportPromise !== undefined) return state.reportPromise
  state.reportPromise = (async () => {
    let receiptError
    try {
      await writeReceipt(state, 'failed', error)
    } catch (failure) {
      receiptError = asError(failure).message
    }
    const report = buildReport(state, 'failed', error, receiptError === undefined ? {} : { receiptError })
    await writeJsonExclusive(state.reportPath, report)
    state.reportWritten = true
    return report
  })()
  return state.reportPromise
}

function decorateError(error, state) {
  const decorated = asError(error)
  if (state.outputDir !== undefined) decorated.outputDir = state.outputDir
  if (state.reportPath !== undefined) decorated.reportPath = state.reportPath
  if (state.artifactPath !== undefined) decorated.artifactPath = state.artifactPath
  if (state.runId !== undefined) decorated.runId = state.runId
  return decorated
}

async function persistFailureDiagnostics(root, runId, state, error) {
  const diagnosticsDir = join(resolve(root), ACCEPTANCE_OUTPUT_DIRECTORY, `failure-${runId}`)
  await fs.mkdir(diagnosticsDir, { recursive: true })
  const copiedFiles = []
  for (const name of FAILURE_DIAGNOSTIC_FILES) {
    const sourcePath = join(state.outputDir, name)
    try {
      const sourceInfo = await fs.stat(sourcePath)
      if (!sourceInfo.isFile()) continue
      await fs.copyFile(sourcePath, join(diagnosticsDir, name))
      copiedFiles.push(name)
    } catch (copyError) {
      if (copyError?.code !== 'ENOENT') throw copyError
    }
  }
  await writeJsonExclusive(join(diagnosticsDir, 'failure-diagnostics.json'), {
    schemaVersion: RELEASE_ACCEPTANCE_SCHEMA_VERSION,
    kind: 'dsh-desktop-release-acceptance-failure-diagnostics',
    runId,
    phase: state.phase,
    error: {
      name: error.name,
      code: error.code ?? null,
      message: error.message,
    },
    files: copiedFiles,
    exclusionPolicy: 'top-level allowlist only; no userData, cache, temp, or secret directories are copied',
  })
  return diagnosticsDir
}

function linkAbortSignal(source, target) {
  if (!source?.addEventListener) return () => {}
  const abort = () => target.abort(source.reason instanceof Error ? source.reason : new Error('Release acceptance aborted'))
  source.addEventListener('abort', abort, { once: true })
  if (source.aborted) abort()
  return () => source.removeEventListener('abort', abort)
}

function protocolResult(stdout) {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(RESULT_PREFIX))
  if (lines.length !== 1) return undefined
  try {
    return JSON.parse(lines[0].slice(RESULT_PREFIX.length))
  } catch {
    return undefined
  }
}

async function runElectronUiFixtureCore({ root, outputDir, inputFingerprint, electronExecutable, fixturePath, signal }) {
  const userDataPath = join(outputDir, 'electron-user-data')
  const tempPath = join(outputDir, 'electron-tmp')
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.mkdir(tempPath, { recursive: true })
  const childEnv = { ...process.env,
    DSH_RELEASE_ACCEPTANCE_CHILD: '1',
    DSH_RELEASE_ACCEPTANCE_ROOT: root,
    DSH_RELEASE_ACCEPTANCE_OUTPUT_DIR: outputDir,
    DSH_RELEASE_ACCEPTANCE_USER_DATA: userDataPath,
    DSH_RELEASE_ACCEPTANCE_TEMP: tempPath,
    DSH_RELEASE_ACCEPTANCE_INPUT_FINGERPRINT: inputFingerprint,
    DSH_RELEASE_ACCEPTANCE_NO_NETWORK: '1',
  }
  delete childEnv.ELECTRON_RUN_AS_NODE

  const supervisor = createChildSupervisor({
    cwd: root,
    env: childEnv,
    windowsHide: true,
    terminationTimeoutMs: 2_000,
  })
  let child
  let stdout = ''
  let stderr = ''
  let closeResult
  let released = false
  let logsWritten = false
  const writeCapturedLogs = async () => {
    if (logsWritten) return
    logsWritten = true
    await Promise.all([
      fs.writeFile(join(outputDir, 'release-ui-fixture.stdout.log'), stdout, { encoding: 'utf8' }),
      fs.writeFile(join(outputDir, 'release-ui-fixture.stderr.log'), stderr, { encoding: 'utf8' }),
    ])
  }
  try {
    const electronArgs = ['--disable-gpu', fixturePath]
    if (process.platform === 'win32' && /^(?:1|true)$/iu.test(process.env.CI ?? '')) {
      electronArgs.unshift(`--force-device-scale-factor=${CI_WINDOWS_HEADLESS_SCALE}`, '--headless')
    }
    child = supervisor.spawn(
      electronExecutable,
      electronArgs,
      createSpawnOptions({ cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
    )
    child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8') })
    closeResult = await supervisor.waitForChildClose(child, { signal })
    await writeCapturedLogs()
    const result = protocolResult(stdout)
    if (closeResult?.code !== 0 || closeResult?.signal !== null) {
      supervisor.releaseExitedRootUnverified(child)
      released = true
      throw errorWithCode(`Electron release UI fixture exited with code ${String(closeResult?.code ?? 1)} and signal ${String(closeResult?.signal ?? null)}${stderr.trim() === '' ? '' : `: ${stderr.trim().slice(-800)}`}`, 'RELEASE_ACCEPTANCE_ELECTRON_FAILED')
    }
    if (result === undefined) {
      supervisor.releaseExitedRootUnverified(child)
      released = true
      throw errorWithCode('Electron release UI fixture exited without a non-empty result', 'RELEASE_ACCEPTANCE_EMPTY_FIXTURE_RESULT')
    }
    supervisor.releaseExitedRootUnverified(child)
    released = true
    return result
  } finally {
    try { await writeCapturedLogs() } catch (error) {
      if (closeResult === undefined) throw error
    }
    if (!released) {
      try { await supervisor.stopAll(new Error('Release UI fixture cleanup')) } catch (error) {
        if (closeResult === undefined) throw error
      }
    }
  }
}

function nativeDataSmokeSummary(value) {
  if (value === undefined || value === null) return null
  return {
    ok: value.ok === true,
    reportPath: value.reportPath,
    reportBytes: value.reportBytes,
    reportSha256: value.reportSha256,
    command: value.command,
    args: value.args,
    completionContract: value.completionContract ?? null,
    runtimeEntry: value.runtimeEntry,
    runtimeEntrySha256: value.runtimeEntrySha256,
    userStateRead: value.report?.userStateRead ?? null,
    activeUserReleaseUnchanged: value.report?.activeUserReleaseUnchanged ?? null,
    dataRestorePreservesProgram: value.report?.dataRestorePreservesProgram ?? null,
    rescueRestorePassed: value.report?.rescueRestorePassed ?? null,
    bootCount: Array.isArray(value.report?.checks) ? value.report.checks.length : 0,
    httpStatuses: Array.isArray(value.report?.checks) ? value.report.checks.map(check => check.httpStatus) : [],
    pluginExecuted: Array.isArray(value.report?.checks) ? value.report.checks.every(check => check.pluginExecuted === true) : false,
    sharedDataPreserved: Array.isArray(value.report?.checks) ? value.report.checks.every(check => check.sharedDataPreserved === true) : false,
  }
}

function nativeProofReportLooksSuccessful(report) {
  return report?.ok === true
    && report.userStateRead === false
    && report.activeUserReleaseUnchanged === null
    && report.dataRestorePreservesProgram === true
    && report.rescueRestorePassed === true
    && Array.isArray(report.checks)
    && report.checks.length === 3
    && report.checks.every((check, index) => check?.release === ['release-a', 'release-b', 'release-a'][index]
      && check?.httpStatus === 200
      && check?.pluginExecuted === true
      && check?.sharedDataPreserved === true)
}

export async function runManagedDataNativeExecutor({ command, args, cwd, env, outputDir, signal, timeoutMs }) {
  const supervisor = createChildSupervisor({
    cwd,
    env,
    windowsHide: true,
    forceWindowsTreeTermination: true,
    terminationTimeoutMs: 2_000,
  })
  let child
  let stdout = ''
  let stderr = ''
  let closeResult
  let released = false
  try {
    child = supervisor.spawn(command, args, createSpawnOptions({
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }))
    child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8') })
    closeResult = await supervisor.waitForChildClose(child, { signal, timeoutMs })
    await fs.writeFile(join(outputDir, 'native-data.stdout.log'), stdout, { encoding: 'utf8', flag: 'wx' })
    await fs.writeFile(join(outputDir, 'native-data.stderr.log'), stderr, { encoding: 'utf8', flag: 'wx' })
    if (closeResult === undefined) {
      await supervisor.stopAll(errorWithCode(`Native data smoke timed out after ${String(timeoutMs)} ms`, 'RELEASE_ACCEPTANCE_NATIVE_TIMEOUT'))
      released = true
      throw errorWithCode(`Native data smoke timed out after ${String(timeoutMs)} ms`, 'RELEASE_ACCEPTANCE_NATIVE_TIMEOUT')
    }
    if (closeResult.code !== 0 || closeResult.signal !== null) {
      supervisor.releaseExitedRootUnverified(child)
      released = true
      throw errorWithCode(`Native data smoke exited with code ${String(closeResult.code ?? 1)} and signal ${String(closeResult.signal ?? null)}${stderr.trim() === '' ? '' : `: ${stderr.trim().slice(-800)}`}`, 'RELEASE_ACCEPTANCE_NATIVE_FAILED')
    }
    const reportPath = args[args.indexOf('--report') + 1]
    let proofReport
    try { proofReport = JSON.parse(await fs.readFile(reportPath, 'utf8')) } catch {
      supervisor.releaseExitedRootUnverified(child)
      released = true
      return { ok: false, reportPath, error: 'native proof report missing or invalid' }
    }
    if (!nativeProofReportLooksSuccessful(proofReport)) {
      supervisor.releaseExitedRootUnverified(child)
      released = true
      return { ok: false, reportPath, error: 'native proof report did not prove cleanup and recovery' }
    }
    const completionContract = { oneShot: true, descendants: 'none' }
    if (!supervisor.releaseCompletedRoot(child, completionContract)) {
      supervisor.releaseExitedRootUnverified(child)
      released = true
      return { ok: false, reportPath, error: 'native proof root could not be released with its completion contract' }
    }
    released = true
    return { ok: true, reportPath, completionContract }
  } finally {
    if (!released) {
      try { await supervisor.stopAll(new Error('Native data smoke cleanup')) } catch (error) {
        if (closeResult === undefined) throw error
      }
    }
  }
}

export async function runManagedDataNativeSmoke({
  root,
  outputDir,
  timeoutMs = DEFAULT_NATIVE_DATA_SMOKE_TIMEOUT_MS,
  nativeExecutor = runManagedDataNativeExecutor,
  executor,
  nativeScriptPath,
  runtimeEntry,
  signal,
} = {}) {
  const rootPath = resolve(assertNonEmptyString(root, 'release acceptance root'))
  const outputPath = resolve(assertNonEmptyString(outputDir, 'release acceptance output directory'))
  const boundedTimeout = validateTimeout(timeoutMs)
  await fs.mkdir(outputPath, { recursive: true })
  const selectedExecutor = executor ?? nativeExecutor
  if (typeof selectedExecutor !== 'function') throw new TypeError('Native data smoke executor must be a function')
  const scriptPath = resolveInputPath(rootPath, nativeScriptPath ?? 'scripts/verify-managed-data-native.mjs')
  const entryPath = resolveInputPath(rootPath, runtimeEntry ?? 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  const reportPath = join(outputPath, 'native-data-report.json')
  const runtimeInfo = await hashFile(entryPath)
  const command = process.execPath
  const args = [scriptPath, '--runtime-entry', entryPath, '--report', reportPath]
  const env = {
    ...process.env,
    DSH_RELEASE_ACCEPTANCE_NATIVE: '1',
    DSH_RELEASE_ACCEPTANCE_NO_NETWORK: '1',
  }
  const execution = Promise.resolve().then(() => selectedExecutor({
    command,
    args,
    cwd: rootPath,
    env,
    outputDir: outputPath,
    reportPath,
    runtimeEntry: entryPath,
    runtimeEntrySha256: runtimeInfo.sha256,
    timeoutMs: boundedTimeout,
    signal,
  }))
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(errorWithCode(`Native data smoke timed out after ${String(boundedTimeout)} ms`, 'RELEASE_ACCEPTANCE_NATIVE_TIMEOUT')), boundedTimeout)
  })
  let result
  try {
    result = await Promise.race([execution, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    execution.catch(() => {})
  }
  if (result?.ok !== true) {
    throw errorWithCode(`Native data smoke executor failed: ${result?.error ?? 'empty result'}`, 'RELEASE_ACCEPTANCE_NATIVE_EXECUTOR_FAILED')
  }
  const reportedReportPath = result.reportPath === undefined
    ? reportPath
    : isAbsolute(result.reportPath) ? resolve(result.reportPath) : resolve(outputPath, result.reportPath)
  if (reportedReportPath !== reportPath) {
    throw errorWithCode('Native data smoke report escaped its run-owned path', 'RELEASE_ACCEPTANCE_NATIVE_REPORT_PATH')
  }
  try {
    await fs.access(reportPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    if (result.report === undefined) throw errorWithCode('Native data smoke returned no report', 'RELEASE_ACCEPTANCE_NATIVE_EMPTY_REPORT')
    await writeJsonExclusive(reportPath, result.report)
  }
  const reportInfo = await hashFile(reportPath)
  let report
  try {
    report = JSON.parse(await fs.readFile(reportPath, 'utf8'))
  } catch (error) {
    throw errorWithCode(`Native data smoke report is not valid JSON: ${asError(error).message}`, 'RELEASE_ACCEPTANCE_NATIVE_REPORT_INVALID', error)
  }
  if (!nativeProofReportLooksSuccessful(report)) {
    throw errorWithCode('Native data smoke report did not prove three 200 boots and data recovery', 'RELEASE_ACCEPTANCE_NATIVE_REPORT_FAILED')
  }
  return {
    ok: true,
    reportPath,
    reportBytes: reportInfo.bytes,
    reportSha256: reportInfo.sha256,
    runtimeEntry: entryPath,
    runtimeEntrySha256: runtimeInfo.sha256,
    command,
    args,
    completionContract: result.completionContract ?? null,
    report,
  }
}

export async function runElectronUiFixture({
  root,
  outputDir,
  inputFingerprint,
  timeoutMs = DEFAULT_RELEASE_ACCEPTANCE_TIMEOUT_MS,
  electronExecutable,
  fixturePath,
  signal,
} = {}) {
  const rootPath = resolve(assertNonEmptyString(root, 'release acceptance root'))
  const outputPath = resolve(assertNonEmptyString(outputDir, 'release acceptance output directory'))
  const fingerprint = assertNonEmptyString(inputFingerprint, 'release acceptance input fingerprint')
  const boundedTimeout = validateTimeout(timeoutMs)
  const electronPath = resolveElectronExecutable(rootPath, electronExecutable)
  const pagePath = resolveFixturePath(rootPath, fixturePath)
  const controller = new AbortController()
  const unlink = linkAbortSignal(signal, controller)
  const timeoutError = errorWithCode(`Release UI fixture timed out after ${String(boundedTimeout)} ms`, 'RELEASE_ACCEPTANCE_FIXTURE_TIMEOUT')
  let timer
  let task
  try {
    task = runElectronUiFixtureCore({ root: rootPath, outputDir: outputPath, inputFingerprint: fingerprint, electronExecutable: electronPath, fixturePath: pagePath, signal: controller.signal })
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeoutError)
        reject(timeoutError)
      }, boundedTimeout)
    })
    return await Promise.race([task, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    unlink()
    task?.catch(() => {})
  }
}

async function revalidateCandidate(root, input, previous) {
  if (input === undefined) return undefined
  return snapshotCandidate(root, input, previous)
}

export async function runReleaseAcceptance({
  root = DEFAULT_ROOT,
  target = 'all',
  flavor = 'base',
  suiteReceipt,
  selection,
  timeoutMs = DEFAULT_RELEASE_ACCEPTANCE_TIMEOUT_MS,
  outputRoot = join(root, ACCEPTANCE_OUTPUT_DIRECTORY),
  inputFiles,
  candidate,
  candidatePath,
  candidateBytes,
  electronExecutable,
  fixturePath,
  fixtureRunner,
  runFixture,
  gate = defaultReleaseAcceptanceGate,
  nativeSmoke = false,
  nativeTimeoutMs = DEFAULT_NATIVE_DATA_SMOKE_TIMEOUT_MS,
  nativeExecutor,
  executor,
  nativeScriptPath,
  nativeRuntimeEntry,
  signal,
} = {}) {
  const rootPath = resolve(assertNonEmptyString(root, 'release acceptance root'))
  const requestedTarget = validateTarget(target)
  const boundedTimeout = validateTimeout(timeoutMs)
  const boundedNativeTimeout = validateTimeout(nativeTimeoutMs)
  if (typeof nativeSmoke !== 'boolean') throw new TypeError('Native data smoke option must be boolean')
  if (typeof gate !== 'function') throw new TypeError('Release acceptance gate must be a function')
  const selectedFixtureRunner = fixtureRunner ?? runFixture ?? runElectronUiFixture
  if (typeof selectedFixtureRunner !== 'function') throw new TypeError('Release acceptance fixture runner must be a function')

  const outputPath = resolve(assertNonEmptyString(outputRoot, 'release acceptance output root'))
  await fs.mkdir(outputPath, { recursive: true })
  const runPath = await fs.mkdtemp(join(outputPath, `run-${Date.now()}-${process.pid}-`))
  const runId = basename(runPath)
  const buildSelection = normalizeBuildSelection({ target: requestedTarget, flavor, suiteReceipt, selection })
  const acceptanceInputs = inputFiles === undefined
    ? undefined
    : acceptanceInputFiles(rootPath, inputFiles, buildSelection, selection?.suiteReceipt ?? suiteReceipt)
  const state = {
    runId,
    outputDir: runPath,
    reportPath: join(runPath, 'report.json'),
    artifactPath: join(runPath, 'release-acceptance-artifact.json'),
    receiptPath: join(runPath, 'receipt.json'),
    phase: 'prepare',
    platform: platformVerification(requestedTarget),
    selection: buildSelection,
    inputFiles: acceptanceInputs,
    reportPromise: undefined,
    reportWritten: false,
    inputManifest: undefined,
    inputManifestAfter: undefined,
    artifact: undefined,
    candidate: undefined,
    fixtureResult: undefined,
    fixtureRunnerIsDefault: selectedFixtureRunner === runElectronUiFixture,
    nativeDataSmoke: undefined,
    suiteReceiptVerification: undefined,
    gateResult: undefined,
  }

  const controller = new AbortController()
  const unlink = linkAbortSignal(signal, controller)
  const timeoutError = errorWithCode(`Release acceptance timed out after ${String(boundedTimeout)} ms`, 'RELEASE_ACCEPTANCE_TIMEOUT')
  let timer
  let operation
  let timeoutTriggered = false
  try {
    operation = (async () => {
      state.phase = 'hash-inputs'
      throwIfAborted(controller.signal)
      state.suiteReceiptVerification = await verifySuiteReceipt(rootPath, buildSelection, selection?.suiteReceipt ?? suiteReceipt)
      const discoveredInputs = state.inputFiles ?? await discoverReleaseAcceptanceInputFiles(rootPath)
      state.inputFiles = acceptanceInputFiles(rootPath, discoveredInputs, buildSelection, selection?.suiteReceipt ?? suiteReceipt)
      state.inputManifest = await hashReleaseInputFiles(rootPath, state.inputFiles, { selection: state.selection })

      state.phase = 'candidate'
      throwIfAborted(controller.signal)
      const candidateInputValue = candidateInput({ candidate, candidatePath, candidateBytes })
      state.candidate = await snapshotCandidate(rootPath, candidateInputValue)

      state.phase = 'native-data-smoke'
      throwIfAborted(controller.signal)
      if (nativeSmoke) {
        state.nativeDataSmoke = await runManagedDataNativeSmoke({
          root: rootPath,
          outputDir: runPath,
          timeoutMs: boundedNativeTimeout,
          nativeExecutor,
          executor,
          nativeScriptPath,
          runtimeEntry: nativeRuntimeEntry,
          signal: controller.signal,
        })
      }

      state.phase = 'fixture'
      throwIfAborted(controller.signal)
      const fixtureResult = await selectedFixtureRunner({
        root: rootPath,
        outputDir: runPath,
        runId,
        target: requestedTarget,
        flavor: buildSelection.flavor,
        selection: state.selection,
        inputFingerprint: state.inputManifest.fingerprint,
        inputManifest: state.inputManifest,
        candidate: candidateForGate(state.candidate),
        electronExecutable,
        fixturePath,
        timeoutMs: boundedTimeout,
        signal: controller.signal,
      })
      state.fixtureResult = normalizeFixtureResult(fixtureResult, {
        isDefault: selectedFixtureRunner === runElectronUiFixture,
        inputFingerprint: state.inputManifest.fingerprint,
      })
      throwIfAborted(controller.signal)

      state.phase = 'artifact'
      const screenshot = typeof state.fixtureResult.screenshotPath === 'string'
        ? await optionalHashFile(state.fixtureResult.screenshotPath)
        : undefined
      const artifactContents = buildArtifact({
        runId,
        inputManifest: state.inputManifest,
        fixtureResult: state.fixtureResult,
        screenshot: screenshot === undefined ? undefined : {
          path: screenshot.path,
          relativePath: isPathInside(runPath, screenshot.path) ? relativeUnixPath(runPath, screenshot.path) : undefined,
          bytes: screenshot.bytes,
          sha256: screenshot.sha256,
        },
        platform: state.platform,
        selection: state.selection,
        suiteReceiptVerification: state.suiteReceiptVerification,
        nativeDataSmoke: state.nativeDataSmoke,
        generatedAt: new Date().toISOString(),
      })
      await writeJsonExclusive(state.artifactPath, artifactContents)
      state.artifact = await hashFile(state.artifactPath)

      state.phase = 'gate'
      throwIfAborted(controller.signal)
      let rawGateResult
      try {
        rawGateResult = await gate({
          root: rootPath,
          outputDir: runPath,
          runId,
          target: requestedTarget,
          flavor: buildSelection.flavor,
          selection: state.selection,
          signal: controller.signal,
          inputManifest: state.inputManifest,
          inputFingerprint: state.inputManifest.fingerprint,
          fingerprint: state.inputManifest.fingerprint,
          timeoutMs: boundedTimeout,
          fixtureResult: state.fixtureResult,
          nativeDataSmoke: state.nativeDataSmoke,
          artifact: artifactForGate(state.artifactPath, state.artifact, state.inputManifest.fingerprint),
          candidate: candidateForGate(state.candidate),
          reportPath: state.reportPath,
        })
      } catch (error) {
        throw errorWithCode(`Release acceptance gate threw: ${asError(error).message}`, 'RELEASE_ACCEPTANCE_GATE_THROW', error)
      }
      state.gateResult = validateGateResult(rawGateResult, {
        inputFingerprint: state.inputManifest.fingerprint,
        artifact: state.artifact,
        candidate: state.candidate,
        nativeDataSmoke: state.nativeDataSmoke,
      })
      throwIfAborted(controller.signal)

      state.phase = 'revalidate'
      throwIfAborted(controller.signal)
      const revalidatedInputs = inputFiles === undefined
        ? acceptanceInputFiles(rootPath, await discoverReleaseAcceptanceInputFiles(rootPath), buildSelection, selection?.suiteReceipt ?? suiteReceipt)
        : state.inputFiles
      if (JSON.stringify(revalidatedInputs) !== JSON.stringify(state.inputFiles)) {
        throw errorWithCode('Release acceptance input file set changed during the gate', 'RELEASE_ACCEPTANCE_INPUT_SET_CHANGED')
      }
      state.inputManifestAfter = await hashReleaseInputFiles(rootPath, revalidatedInputs, { selection: state.selection })
      if (state.inputManifestAfter.fingerprint !== state.inputManifest.fingerprint) {
        throw errorWithCode('Release acceptance input files changed during the gate', 'RELEASE_ACCEPTANCE_INPUTS_CHANGED')
      }
      const artifactAfter = await hashFile(state.artifactPath)
      if (artifactAfter.sha256 !== state.artifact.bytesSha256) {
        throw errorWithCode('Release acceptance artifact bytes changed during the gate', 'RELEASE_ACCEPTANCE_ARTIFACT_CHANGED')
      }
      const candidateAfter = await revalidateCandidate(rootPath, candidateInputValue, state.candidate)
      if (state.candidate !== undefined && candidateAfter?.bytesSha256 !== state.candidate.bytesSha256) {
        throw errorWithCode('Release candidate bytes changed during the gate', 'RELEASE_ACCEPTANCE_CANDIDATE_CHANGED')
      }
      if (state.nativeDataSmoke !== undefined) {
        const nativeReportAfter = await hashFile(state.nativeDataSmoke.reportPath)
        if (nativeReportAfter.sha256 !== state.nativeDataSmoke.reportSha256) {
          throw errorWithCode('Native data smoke report bytes changed during the gate', 'RELEASE_ACCEPTANCE_NATIVE_REPORT_CHANGED')
        }
        const runtimeEntryAfter = await hashFile(state.nativeDataSmoke.runtimeEntry)
        if (runtimeEntryAfter.sha256 !== state.nativeDataSmoke.runtimeEntrySha256) {
          throw errorWithCode('Native runtime entry bytes changed during the gate', 'RELEASE_ACCEPTANCE_NATIVE_RUNTIME_CHANGED')
        }
      }

      await writeReceipt(state, 'passed')
      state.phase = 'report'
      throwIfAborted(controller.signal)
      const report = buildReport(state, 'passed', undefined, {
        inputFingerprintAfter: state.inputManifestAfter.fingerprint,
        artifact: { path: state.artifact.path, bytes: state.artifact.bytes, bytesSha256: state.artifact.bytesSha256 },
        candidate: candidateSummary(state.candidate),
      })
      await writeJsonExclusive(state.reportPath, report)
      state.reportWritten = true
      console.log(`RELEASE_ACCEPTANCE_OK ${state.reportPath}`)
      console.log(`RELEASE_ACCEPTANCE_SCOPE ${FIXTURE_SIMULATION_NOTE}; full E2E remains required`) 
      return report
    })()

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timeoutTriggered = true
        controller.abort(timeoutError)
        reject(timeoutError)
      }, boundedTimeout)
    })
    const externalAbort = signal?.aborted
      ? Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Release acceptance aborted'))
      : new Promise((_, reject) => signal?.addEventListener?.('abort', () => reject(signal.reason instanceof Error ? signal.reason : new Error('Release acceptance aborted')), { once: true }))
    return await Promise.race([operation, timeout, externalAbort])
  } catch (error) {
    const decorated = decorateError(timeoutTriggered ? timeoutError : error, state)
    try {
      await writeFailureReport(state, decorated)
    } catch (reportError) {
      decorated.reportWriteError = asError(reportError).message
    }
    if (state.fixtureRunnerIsDefault) {
      try {
        decorated.failureDiagnosticsDir = await persistFailureDiagnostics(rootPath, state.runId, state, decorated)
      } catch (diagnosticError) {
        decorated.failureDiagnosticsWriteError = asError(diagnosticError).message
      }
    }
    throw decorated
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    unlink()
    operation?.catch(() => {})
  }
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const target = process.argv[2] ?? 'all'
  try {
    await runReleaseAcceptance({ root: DEFAULT_ROOT, target })
  } catch (error) {
    console.error(error?.stack || error)
    process.exitCode = 1
  }
}
