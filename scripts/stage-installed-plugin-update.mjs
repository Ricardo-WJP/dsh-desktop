import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createDesktopRuntimeController } from '../src/desktop-runtime-controller.js'
import { prepareHarnessToolchain } from '../src/desktop-integration.js'
import { readActiveDshRuntime, resolveManagedDshRuntimeRoot } from '../src/dsh-runtime.js'

const require = createRequire(import.meta.url)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const userData = join(process.env.APPDATA ?? '', 'dsh-desktop')
const runtimeRoot = resolveManagedDshRuntimeRoot({
  userProfile: process.env.USERPROFILE,
  userData,
})
const packageName = process.argv[2]
const selector = process.argv[3]

if (typeof packageName !== 'string' || !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(packageName)) {
  throw new Error('Usage: node scripts/stage-installed-plugin-update.mjs <package> <exact-version-or-github-specifier>')
}
const github = typeof selector === 'string'
  ? /^github:([a-z0-9._-]+\/[a-z0-9._-]+)#([a-f0-9]{40})$/i.exec(selector)
  : undefined
if (github === undefined && (typeof selector !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/.test(selector))) {
  throw new Error('The plugin selector must be an exact npm version or github:owner/repository#commit')
}
const source = github === undefined
  ? { type: 'npm', package: packageName, versionOrTag: selector }
  : { type: 'github', repository: github[1], ref: github[2].toLowerCase() }

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
const windows = { getWindow: () => undefined }
const app = {
  getAppPath: () => repositoryRoot,
  getPath: name => name === 'downloads' ? join(process.env.USERPROFILE ?? '', 'Downloads') : (process.env.USERPROFILE ?? ''),
  getVersion: () => 'maintenance',
  isPackaged: true,
}
const controller = createDesktopRuntimeController({
  window: windows,
  app,
  process,
  effects: {
    writeLog: (source, text) => process.stdout.write(`[${source}] ${text}`),
  },
  runtime: {
    app,
    process,
    env: runtimeEnvironment,
    dshHome: userData,
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
  const result = await controller.pluginTransaction({
    action: 'replaceSource',
    name: packageName,
    source,
    // The exact target package was explicitly selected by the caller. Its
    // lifecycle scripts are inventoried before this permission is consumed,
    // and the candidate still has to pass static and runtime gates.
    buildPermissions: { [packageName]: true },
  })
  process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`)
  if (result?.ok !== true) process.exitCode = 1
} finally {
  await controller.shutdown(new Error('Maintenance transaction complete'))
}
