import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createDesktopRuntimeController } from '../src/desktop-runtime-controller.js'
import { prepareHarnessToolchain } from '../src/desktop-integration.js'
import { readActiveDshRuntime, resolveManagedDshRuntimeRoot } from '../src/dsh-runtime.js'

const DOCTOR_PACKAGE = '@linxin666/dsh-doctor'
const DOCTOR_VERSION = '0.3.6'
const require = createRequire(import.meta.url)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const userData = join(process.env.APPDATA ?? '', 'dsh-desktop')
const dshHome = join(process.env.USERPROFILE ?? '', '.dsh')
const runtimeRoot = resolveManagedDshRuntimeRoot({
  userProfile: process.env.USERPROFILE,
  userData,
})

function resolvePnpmEntry() {
  const manifest = require.resolve('pnpm')
  const entry = join(dirname(manifest), 'bin', 'pnpm.mjs')
  if (!existsSync(entry)) throw new Error(`Bundled pnpm entry point is missing: ${entry}`)
  return entry
}

function resolveBundledDshManifest() {
  return require.resolve('@deepseek-ai/dsh/package.json')
}

function resolveDshEntry(activeRuntime) {
  if (activeRuntime?.entry !== undefined) return activeRuntime.entry
  const entry = join(dirname(resolveBundledDshManifest()), 'lib', 'bin.js')
  if (!existsSync(entry)) throw new Error(`DeepSeek Harness entry point is missing: ${entry}`)
  return entry
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const pnpmEntry = resolvePnpmEntry()
const initialRuntime = readActiveDshRuntime({
  runtimeRoot,
  bundledManifestPath: resolveBundledDshManifest(),
})
const runtimeEnvironment = prepareHarnessToolchain({
  directory: join(userData, 'toolchain'),
  execPath: process.execPath,
  pnpmEntry,
  env: process.env,
})
const app = {
  getAppPath: () => repositoryRoot,
  getPath: name => name === 'downloads' ? join(process.env.USERPROFILE ?? '', 'Downloads') : (process.env.USERPROFILE ?? ''),
  getVersion: () => 'maintenance',
  isPackaged: true,
}
const controller = createDesktopRuntimeController({
  window: { getWindow: () => undefined },
  app,
  process,
  effects: {
    writeLog: (source, value) => process.stdout.write(`[${source}] ${value}`),
  },
  runtime: {
    app,
    process,
    env: runtimeEnvironment,
    dshHome,
    runtimeRoot,
    repositoryRoot,
    initialRuntime,
    resolvePnpmEntry: () => pnpmEntry,
    resolveDshEntry,
  },
})

try {
  const recovery = await controller.recoverPendingRelease()
  if (recovery?.status !== 'idle') throw new Error(`Release recovery is not idle: ${JSON.stringify(recovery)}`)

  const result = await controller.pluginMarketUpdate({
    name: DOCTOR_PACKAGE,
    kind: 'npm',
    target: DOCTOR_VERSION,
  })
  if (result?.ok !== true) throw new Error(result?.error ?? 'Doctor market promotion failed')

  const candidateId = result.report?.candidateId ?? result.report?.candidate?.id
  if (typeof candidateId !== 'string') throw new Error('Doctor market promotion returned no candidate id')
  const candidateRoot = join(runtimeRoot, 'candidates', candidateId)
  const profile = JSON.parse(readFileSync(join(candidateRoot, 'profile', 'package.json'), 'utf8'))
  if (profile?.dependencies?.[DOCTOR_PACKAGE] !== DOCTOR_VERSION) {
    throw new Error(`Candidate dependency is not ${DOCTOR_PACKAGE}@${DOCTOR_VERSION}`)
  }

  const releaseManifest = JSON.parse(readFileSync(join(candidateRoot, 'manifest.json'), 'utf8'))
  const physicalProfileName = releaseManifest?.profile?.physicalName
  if (typeof physicalProfileName !== 'string' || physicalProfileName.length === 0) {
    throw new Error('Candidate release manifest has no physical profile name')
  }
  const doctorRoot = join(candidateRoot, 'profiles', physicalProfileName, 'node_modules', '@linxin666', 'dsh-doctor')
  const doctorManifest = JSON.parse(readFileSync(join(doctorRoot, 'package.json'), 'utf8'))
  const expectedCli = join(repositoryRoot, 'src', 'plugins', 'dsh-doctor-desktop-compat', 'lib', 'cli.mjs')
  const expectedIndex = join(repositoryRoot, 'src', 'plugins', 'dsh-doctor-desktop-compat', 'lib', 'index.js')
  const actualCli = join(doctorRoot, 'lib', 'cli.mjs')
  const actualIndex = join(doctorRoot, 'lib', 'index.js')
  if (doctorManifest.version !== DOCTOR_VERSION) throw new Error(`Candidate Doctor version is ${doctorManifest.version}`)
  if (sha256(actualCli) !== sha256(expectedCli) || sha256(actualIndex) !== sha256(expectedIndex)) {
    throw new Error('Candidate Doctor compatibility assets do not match the audited desktop assets')
  }

  const staged = JSON.parse(readFileSync(join(runtimeRoot, 'release-state', 'plugin-candidate.json'), 'utf8'))
  if (staged.candidateId !== candidateId) throw new Error('Staged candidate journal does not match the verified candidate')

  process.stdout.write(`${JSON.stringify({
    ok: true,
    candidateId,
    dependency: profile.dependencies[DOCTOR_PACKAGE],
    doctorVersion: doctorManifest.version,
    compatibilityHashesMatch: true,
    staged: true,
  })}\n`)
} finally {
  await controller.shutdown(new Error('Doctor market promotion verification complete'))
}
