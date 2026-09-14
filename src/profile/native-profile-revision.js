import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { parse } from 'yaml'
import semver from 'semver'
import { inspectCandidateProfile } from './compatibility-gate.js'
import { runCandidateRuntimeGate } from './runtime-gate.js'

const files = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']
const digest = data => createHash('sha256').update(data).digest('hex')
async function inputs(directory) {
  const result = {}
  for (const name of files) {
    if (!(await lstat(join(directory, name))).isFile()) throw new Error(`Native profile input is not a regular file: ${name}`)
    result[name] = await readFile(join(directory, name), 'utf8')
  }
  return result
}

// A native plugin update changes the running profile, not the immutable release
// snapshot. Accept only a complete, install-consistent revision after preflight.
export async function acceptNativeProfileRevision({ candidateDir, sourcePath, profilePath,
  inspect = inspectCandidateProfile, gate = runCandidateRuntimeGate }) {
  try {
    const [source, live] = await Promise.all([inputs(sourcePath), inputs(profilePath)])
    const before = JSON.parse(source['package.json'])
    const after = JSON.parse(live['package.json'])
    const { dependencies: oldDeps, ...oldMetadata } = before
    const { dependencies: deps, ...metadata } = after
    if (!isDeepStrictEqual(oldMetadata, metadata) || source['cordis.patch.yml'] !== live['cordis.patch.yml']) {
      throw new Error('Native profile changes include runtime configuration; use a staged plugin transaction')
    }
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) throw new Error('Invalid native profile dependencies')
    const lock = parse(live['pnpm-lock.yaml'])
    const locked = lock?.importers?.['.']?.dependencies
    if (!locked || !isDeepStrictEqual(Object.keys(deps).sort(), Object.keys(locked).sort())) throw new Error('Native profile lockfile dependency set is incomplete')
    for (const [name, spec] of Object.entries(deps)) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || name.includes('..')) throw new Error('Invalid native package name')
      if (locked[name]?.specifier !== spec) throw new Error(`Native lockfile does not match ${name}`)
      // Existing Git/local sources remain governed by the original release.
      // Changed sources must be registry versions, not arbitrary replacement URLs.
      if (spec !== oldDeps?.[name] && !semver.valid(spec)) throw new Error(`Native source change needs staged validation: ${name}`)
      if (semver.valid(spec)) {
        const installed = JSON.parse(await readFile(join(profilePath, 'node_modules', name, 'package.json'), 'utf8'))
        if (installed.name !== name || installed.version !== spec || String(locked[name].version).split('(')[0] !== spec) {
          throw new Error(`Native installation is incomplete for ${name}`)
        }
      }
    }
    const manifest = JSON.parse(await readFile(join(candidateDir, 'manifest.json'), 'utf8'))
    const version = manifest.dsh.version
    if (!semver.valid(version)) throw new Error('Invalid native runtime version')
    await inspect({ profilePath, dshVersion: version })
    const identity = digest(JSON.stringify({ version, source, live }))
    const revisionPath = join(candidateDir, 'native-profile-revisions', identity)
    // Always run preflight: installed modules may have changed independently of
    // manifests, so a previous receipt alone cannot authorize this launch.
    const result = await gate({ candidateId: `native-${identity.slice(0, 16)}`, recipe: {
      entry: join(candidateDir, 'runtime', 'versions', version, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      profilePath, profileHome: candidateDir, physicalProfileName: manifest.profile.physicalName, cwd: profilePath,
      runtimeArgs: ['--expose-internals', '--require', fileURLToPath(new URL('../runtime/windows-hidden-child-process.cjs', import.meta.url))],
    } })
    if (result?.ok !== true) throw new Error('Native profile runtime preflight failed')
    if (!isDeepStrictEqual(live, await inputs(profilePath)) || !isDeepStrictEqual(source, await inputs(sourcePath))) throw new Error('Native profile changed during validation; retry after update completes')
    await mkdir(revisionPath, { recursive: true })
    for (const name of files) await writeFile(join(revisionPath, name), live[name])
    const temp = join(revisionPath, `receipt-${randomUUID()}.tmp`)
    await writeFile(temp, JSON.stringify({ identity, checkedAt: new Date().toISOString(), runtimeVersion: version, staticPassed: true, runtimePassed: true }))
    await rename(temp, join(revisionPath, 'receipt.json'))
    return profilePath
  } catch (cause) {
    const error = new Error(`Native plugin update could not be validated: ${cause.message}`, { cause })
    error.code = 'NATIVE_PROFILE_REVISION_REJECTED'
    throw error
  }
}
