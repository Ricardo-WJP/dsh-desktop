import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  assertStableProfilePlan,
  createProfilePlan,
  localPackageTarballName,
  materializeProfileTemplate,
  readProfileInputs,
} from '../src/profile/template-builder.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [mode = 'stable', releaseId, outputArg] = process.argv.slice(2)
if (!releaseId || !outputArg) throw new Error('usage: npm run build:profile -- <stable|dev> <release-id> <output-dir>')

const recipePath = join(repositoryRoot, 'profiles', `ricardo-${mode}.json`)
const inputs = await readProfileInputs({ recipePath, repositoryRoot })
const localPackageVersions = {}
for (const [name, relative] of Object.entries(inputs.compatibility.localPackages ?? {})) {
  localPackageVersions[name] = JSON.parse(await readFile(join(repositoryRoot, relative, 'package.json'), 'utf8')).version
}
const plan = createProfilePlan({
  mode,
  releaseId,
  sourcePackage: inputs.sourcePackage,
  sourceLock: inputs.sourceLock,
  compatibility: inputs.compatibility,
  localPackageVersions,
})
if (mode === 'stable') assertStableProfilePlan(plan)
const outputDir = resolve(outputArg)
const report = await materializeProfileTemplate({ plan, outputDir, evidenceDir: inputs.evidenceDir })

function runNodeCli(entry, args, cwd) {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8', windowsHide: true, shell: false })
  if (result.status !== 0) throw new Error(`${entry} failed: ${(result.stderr || result.stdout || '').trim()}`)
  return result.stdout
}

const npmCli = process.env.npm_execpath
if (!npmCli || !npmCli.endsWith('.js')) throw new Error('Run through npm so npm_execpath is an exact JavaScript CLI path')
const selectedBundles = new Set(plan.bundles.map(bundle => bundle.name))
for (const [name, relative] of Object.entries(inputs.compatibility.localPackages ?? {})) {
  if (!selectedBundles.has(name)) continue
  const packageDir = join(repositoryRoot, relative)
  const output = runNodeCli(npmCli, ['pack', '--json', '--pack-destination', join(outputDir, 'packages')], packageDir)
  const packed = JSON.parse(output)?.[0]?.filename
  const expected = localPackageTarballName(name, localPackageVersions[name])
  if (packed !== expected) throw new Error(`Unexpected packed artifact for ${name}: ${String(packed)}`)
}

const pnpmCli = join(repositoryRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
runNodeCli(pnpmCli, ['install', '--lockfile-only', '--prefer-offline', '--ignore-scripts'], outputDir)

// pnpm can omit cached Git integrity metadata depending on store history.
// Rehydrate matching exact records from the checked-in evidence lock, then
// serialize canonically so clean builds do not depend on cache warmth.
const generatedLockPath = join(outputDir, 'pnpm-lock.yaml')
const generatedLock = parseYaml(await readFile(generatedLockPath, 'utf8'))
const evidenceLock = parseYaml(inputs.sourceLock)
for (const [key, evidence] of Object.entries(evidenceLock.packages ?? {})) {
  const generated = generatedLock.packages?.[key]
  if (generated === undefined || evidence?.resolution?.integrity === undefined) continue
  generated.resolution = { ...generated.resolution, integrity: evidence.resolution.integrity }
}
await writeFile(generatedLockPath, stringifyYaml(generatedLock, { lineWidth: 0 }), 'utf8')

const hashFile = async name => createHash('sha256').update(await readFile(join(outputDir, name))).digest('hex')
const completed = {
  ...report,
  lockSha256: await hashFile('pnpm-lock.yaml'),
  patchSha256: await hashFile('cordis.patch.yml'),
}
await writeFile(join(outputDir, 'profile-plan.json'), `${JSON.stringify(completed, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(completed, null, 2))
