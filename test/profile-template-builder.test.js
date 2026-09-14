import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  assertStableProfilePlan,
  createProfilePlan,
  localPackageTarballName,
  materializeProfileTemplate,
  readProfileInputs,
} from '../src/profile/template-builder.js'

const root = resolve(import.meta.dirname, '..')

async function stablePlan(releaseId = '2026.08.22-test') {
  const inputs = await readProfileInputs({ recipePath: join(root, 'profiles', 'ricardo-stable.json'), repositoryRoot: root })
  const localPackageVersions = {}
  for (const [name, relative] of Object.entries(inputs.compatibility.localPackages)) {
    localPackageVersions[name] = JSON.parse(await readFile(join(root, relative, 'package.json'), 'utf8')).version
  }
  return { inputs, plan: createProfilePlan({
    mode: 'stable', releaseId, sourcePackage: inputs.sourcePackage, sourceLock: inputs.sourceLock,
    compatibility: inputs.compatibility, localPackageVersions,
  }) }
}

test('stable recipe resolves a blank profile with only the DSH core bundles', async () => {
  const { inputs, plan } = await stablePlan()
  assert.deepEqual(plan.bundles, [])
  assert.deepEqual(plan.packageJson.dependencies, {})
  assert.deepEqual(plan.packageJson.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
  ])
  assert.notDeepEqual(plan.bundles.map(bundle => bundle.name), inputs.compatibility.order)
  assert.equal(plan.physicalName, 'ricardo-stable-2026.08.22-test')
  assertStableProfilePlan(plan)
  for (const [name, spec] of Object.entries(plan.packageJson.dependencies)) {
    assert.doesNotMatch(spec, /github:|#main|#master|^link:|^workspace:/i, name)
    if (spec.startsWith('file:')) assert.match(spec, /\.tgz$/, name)
  }
})

test('stable plan is canonical and template materialization is byte-reproducible', async t => {
  const { inputs, plan } = await stablePlan('repeatable-001')
  const first = await mkdtemp(join(tmpdir(), 'dsh-profile-a-'))
  const second = await mkdtemp(join(tmpdir(), 'dsh-profile-b-'))
  t.after(() => Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]))
  const a = await materializeProfileTemplate({ plan, outputDir: first, evidenceDir: inputs.evidenceDir })
  const b = await materializeProfileTemplate({ plan, outputDir: second, evidenceDir: inputs.evidenceDir })
  assert.deepEqual(a, b)
  for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'profile-plan.json']) {
    assert.deepEqual(await readFile(join(first, name)), await readFile(join(second, name)), name)
  }
})

test('stable validation rejects mutable local directories and floating Git branches', () => {
  const base = { mode: 'stable', packageJson: { dependencies: {} } }
  assert.throws(() => assertStableProfilePlan({ ...base, packageJson: { dependencies: { bad: 'file:./node_modules/bad' } } }), /mutable local/)
  assert.throws(() => assertStableProfilePlan({ ...base, packageJson: { dependencies: { bad: 'github:user/repo#main' } } }), /floating Git/)
})

test('scoped local package tarballs use npm pack filename semantics', () => {
  assert.equal(localPackageTarballName('@liustack/modlens', '3.18.1-ricardo.1'), 'liustack-modlens-3.18.1-ricardo.1.tgz')
  assert.equal(localPackageTarballName('dsh-update-button', '0.1.0'), 'dsh-update-button-0.1.0.tgz')
})
