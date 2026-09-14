import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const SHA512 = /^sha512-[A-Za-z0-9+/]+={0,2}$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const COMMIT_URL = /(?:\/tar\.gz\/|\.git#)([a-f0-9]{40})(?:$|\()/i
const CORE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

export function localPackageTarballName(name, version) {
  if (typeof name !== 'string' || name.length === 0 || typeof version !== 'string' || !EXACT_VERSION.test(version)) {
    throw new TypeError('Invalid local package identity')
  }
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${label}`)
  return value
}

function safeReleaseId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(value)) throw new TypeError('Invalid releaseId')
  return value
}

function importerVersion(entry, name) {
  const value = typeof entry === 'string' ? entry : entry?.version
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing locked version for ${name}`)
  return value.replace(/\([^)]*\)$/u, '')
}

function packageRecord(packages, name, version) {
  return Object.entries(packages).find(([key]) => key === `${name}@${version}` || key.startsWith(`${name}@${version}(`))?.[1]
}

function exactRemote(name, entry, packages) {
  const version = importerVersion(entry, name)
  const commit = version.match(COMMIT_URL)?.[1]
  const record = packageRecord(packages, name, version)
  const integrity = record?.resolution?.integrity
  if (commit !== undefined) {
    return {
      spec: version,
      resolved: version,
      integrityOrCommit: commit.toLowerCase(),
      ...(SHA512.test(integrity ?? '') ? { integrity } : {}),
    }
  }
  if (!EXACT_VERSION.test(version)) throw new Error(`Floating registry dependency for ${name}: ${version}`)
  if (!SHA512.test(integrity ?? '')) throw new Error(`Missing registry integrity for ${name}@${version}`)
  return { spec: version, resolved: version, integrityOrCommit: integrity, integrity }
}

export function createProfilePlan({ mode, releaseId, sourcePackage, sourceLock, compatibility, localPackageVersions = {} }) {
  if (mode !== 'stable' && mode !== 'dev') throw new TypeError('Profile mode must be stable or dev')
  const id = safeReleaseId(releaseId)
  const manifest = plainObject(sourcePackage, 'source package')
  const lock = typeof sourceLock === 'string' ? parseYaml(sourceLock) : plainObject(sourceLock, 'source lock')
  const policy = plainObject(compatibility, 'compatibility policy')
  const importer = lock?.importers?.['.']?.dependencies ?? {}
  const packages = lock?.packages ?? {}
  const order = policy.defaultOrder ?? policy.order
  if (!Array.isArray(order) || new Set(order).size !== order.length) throw new Error('Compatibility order must be unique')
  const dependencies = {}
  const bundles = []
  for (const name of order) {
    if (!(name in (manifest.dependencies ?? {}))) throw new Error(`Source package is missing ${name}`)
    if (policy.localPackages?.[name] !== undefined) {
      const version = localPackageVersions[name]
      if (!EXACT_VERSION.test(version ?? '')) throw new Error(`Missing exact local package version for ${name}`)
      const artifact = localPackageTarballName(name, version)
      const spec = mode === 'stable' ? `file:./packages/${artifact}` : `link:./packages/${name}`
      dependencies[name] = spec
      bundles.push({ name, resolved: spec, integrityOrCommit: `local-package:${version}` })
      continue
    }
    const exact = exactRemote(name, importer[name], packages)
    dependencies[name] = exact.spec
    bundles.push({ name, resolved: exact.resolved, integrityOrCommit: exact.integrityOrCommit })
  }
  const logicalName = `ricardo-${mode}`
  const physicalName = `${logicalName}-${id}`
  return Object.freeze({
    mode,
    releaseId: id,
    logicalName,
    physicalName,
    packageJson: {
      name: physicalName,
      private: true,
      type: 'module',
      dependencies,
      dsh: { profile: { bundles: [...CORE_BUNDLES, ...bundles.map(bundle => bundle.name)] } },
    },
    bundles,
  })
}

export function assertStableProfilePlan(plan) {
  if (plan?.mode !== 'stable') throw new TypeError('Expected stable profile plan')
  for (const [name, spec] of Object.entries(plan.packageJson?.dependencies ?? {})) {
    if (/^(link:|workspace:)/.test(spec) || (/^file:/.test(spec) && !spec.endsWith('.tgz'))) {
      throw new Error(`Stable profile contains mutable local dependency ${name}: ${spec}`)
    }
    if (/github:/i.test(spec) || /#(?:main|master|next|dev)$/i.test(spec)) throw new Error(`Stable profile contains floating Git dependency ${name}: ${spec}`)
  }
  return true
}

export async function materializeProfileTemplate({ plan, outputDir, evidenceDir }) {
  if (plan.mode === 'stable') assertStableProfilePlan(plan)
  const root = resolve(outputDir)
  await mkdir(join(root, 'packages'), { recursive: true })
  const packageText = `${JSON.stringify(plan.packageJson, null, 2)}\n`
  await writeFile(join(root, 'package.json'), packageText, 'utf8')
  for (const name of ['cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
    await copyFile(join(resolve(evidenceDir), name), join(root, name))
  }
  const report = {
    schemaVersion: 1,
    mode: plan.mode,
    releaseId: plan.releaseId,
    logicalName: plan.logicalName,
    physicalName: plan.physicalName,
    manifestSha256: sha256(packageText),
    bundles: plan.bundles,
  }
  await writeFile(join(root, 'profile-plan.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return report
}

export async function readProfileInputs({ recipePath, repositoryRoot }) {
  const root = resolve(repositoryRoot)
  const recipe = JSON.parse(await readFile(resolve(recipePath), 'utf8'))
  const compatibilityPath = resolve(root, recipe.compatibility)
  const evidenceDir = resolve(root, recipe.sourceEvidence)
  const [compatibility, sourcePackage, sourceLock] = await Promise.all([
    readFile(compatibilityPath, 'utf8').then(JSON.parse),
    readFile(join(evidenceDir, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(evidenceDir, 'pnpm-lock.yaml'), 'utf8'),
  ])
  return { recipe, compatibility, sourcePackage, sourceLock, evidenceDir, compatibilityPath: basename(compatibilityPath) }
}
