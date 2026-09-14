import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCandidateRuntimeGate } from '../src/profile/runtime-gate.js'
import { inspectCandidateProfile } from '../src/profile/compatibility-gate.js'

// Test only generated profiles; never edit or activate a user candidate.
const repository = fileURLToPath(new URL('../', import.meta.url))
const runtimeRoot = resolve(process.argv[2])
const output = resolve(process.argv[3] ?? 'output/native-runtime-gate')
const statePath = join(runtimeRoot, 'release-state', 'active.json')
const before = await readFile(statePath, 'utf8')
const active = JSON.parse(before)
const candidate = join(runtimeRoot, 'candidates', active.releaseId)
const manifest = JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8'))
const entry = join(candidate, 'runtime', 'versions', manifest.dsh.version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const scratch = await mkdtemp(join(tmpdir(), 'dsh-native-gate-proof-'))
const results = []
await mkdir(output, { recursive: true })
for (const broken of [false, true]) {
  const home = join(scratch, broken ? 'broken' : 'working')
  const profilePath = join(home, 'profile')
  const packageRoot = join(profilePath, 'node_modules', 'desktop-native-test-plugin')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(profilePath, 'package.json'), JSON.stringify({ name: 'native-gate-proof', type: 'module', private: true,
    dependencies: { 'desktop-native-test-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'desktop-native-test-plugin'] } },
  }))
  await writeFile(join(profilePath, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'desktop-native-test-plugin', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(packageRoot, 'cordis.patch.yml'), '- insert:\n    - id: desktop-native-test-plugin\n      name: desktop-native-test-plugin\n')
  await writeFile(join(packageRoot, 'index.js'), broken
    ? 'export function apply() { throw new Error("DSH_EXPECTED_PLUGIN_FAILURE"); }\n'
    : 'export function apply() { console.log("DSH_NATIVE_PLUGIN_READY"); }\n')
  const staticResult = await inspectCandidateProfile({ profilePath, dshVersion: manifest.dsh.version })
  assert.equal(staticResult.ok, true)
  let sawPlugin = false
  let result
  try {
    result = await runCandidateRuntimeGate({
      recipe: { entry, profileHome: home, profilePath, physicalProfileName: 'native-gate-proof', cwd: profilePath,
        runtimeArgs: ['--expose-internals', '--require', join(repository, 'src', 'runtime', 'windows-hidden-child-process.cjs')] },
      candidateId: broken ? 'broken-plugin-proof' : 'native-plugin-proof',
      execPath: process.execPath,
      startupTimeoutMs: 60_000,
      onOutput: (_source, text) => { if (/DSH_NATIVE_PLUGIN_READY|DSH_EXPECTED_PLUGIN_FAILURE/.test(text)) sawPlugin = true },
    })
  } catch (error) {
    result = { ok: false, code: error.code, message: error.message, cleanupStatus: error.cleanupStatus }
  }
  await result.cleanupStatus?.home?.completion
  assert.equal(sawPlugin, true, 'Real plugin code must execute before testing its outcome')
  assert.equal(result.ok, !broken, `${broken ? 'Broken' : 'Native'} plugin: ${JSON.stringify(result)}`)
  const { origin: _secretOrigin, ...safeResult } = result
  results.push({ broken, sawPlugin, result: safeResult })
  console.log(JSON.stringify(results.at(-1)))
}
assert.equal(await readFile(statePath, 'utf8'), before, 'Preflight must not change the active release')
const cleanupVerified = results.every(({ result }) => result.cleanupStatus?.server?.status === 'complete'
  && result.cleanupStatus?.home?.status === 'complete')
await writeFile(join(output, 'report.json'), JSON.stringify({ ok: cleanupVerified, startupChecksPassed: true, cleanupVerified, runtime: manifest.dsh.version, activeUnchanged: true, results, scratch }, null, 2))
console.log(JSON.stringify({ ok: cleanupVerified, startupChecksPassed: true, cleanupVerified, report: join(output, 'report.json') }))
if (!cleanupVerified) process.exitCode = 1
