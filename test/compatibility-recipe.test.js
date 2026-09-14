import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DSH_RC2_COMPATIBILITY_RECIPE } from '../compatibility/recipes/dsh-0.1.1-rc.2.js'
import {
  applyCompatibilityRecipe,
  verifyCompatibilityEvidence,
} from '../src/release/compatibility-recipe.js'

const repositoryRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compat-recipe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('rc.2 recipe dry-runs, applies exact anchors, and is idempotent', async t => {
  const root = await temporaryRoot(t)
  for (const target of DSH_RC2_COMPATIBILITY_RECIPE.targets) {
    const destination = join(root, ...target.path.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    const repositoryPath = join(repositoryRoot, ...target.path.split('/'))
    let fixture = await readFile(repositoryPath, 'utf8')
    if (target.operations.length > 0 && sha256(fixture) === target.appliedSha256) {
      for (const patch of [...target.operations].reverse()) fixture = fixture.replace(patch.replace, patch.find)
    }
    const sourceSha256s = Array.isArray(target.sourceSha256) ? target.sourceSha256 : [target.sourceSha256]
    assert.ok(sourceSha256s.includes(sha256(fixture)), `${target.id} fixture must reconstruct an accepted npm source`)
    await writeFile(destination, fixture)
  }

  const dryRun = await applyCompatibilityRecipe({
    root,
    recipe: DSH_RC2_COMPATIBILITY_RECIPE,
    dshVersion: '0.1.1-rc.2',
    write: false,
  })
  const patchTargets = DSH_RC2_COMPATIBILITY_RECIPE.targets.filter(target => target.operations.length > 0)
  assert.equal(dryRun.targets.filter(target => target.state === 'patched').length, patchTargets.length)
  for (const target of patchTargets) {
    const sourceSha256s = Array.isArray(target.sourceSha256) ? target.sourceSha256 : [target.sourceSha256]
    assert.ok(sourceSha256s.includes(sha256(await readFile(join(root, ...target.path.split('/'))))))
  }

  const applied = await applyCompatibilityRecipe({ root, recipe: DSH_RC2_COMPATIBILITY_RECIPE, dshVersion: '0.1.1-rc.2' })
  assert.deepEqual(applied.targets.map(target => target.sha256), DSH_RC2_COMPATIBILITY_RECIPE.targets.map(target => target.appliedSha256))
  const repeated = await applyCompatibilityRecipe({ root, recipe: DSH_RC2_COMPATIBILITY_RECIPE, dshVersion: '0.1.1-rc.2' })
  assert.ok(repeated.targets.every(target => target.state === 'already-applied'))
  assert.deepEqual(
    repeated.targets.filter(target => target.id.startsWith('windows-directory-picker-')).map(target => target.state),
    ['already-applied', 'already-applied'],
  )
})

test('rc.2 recipe migrates the previously grounded minimal Windows preset', async t => {
  const root = await temporaryRoot(t)
  const target = DSH_RC2_COMPATIBILITY_RECIPE.targets.find(entry => entry.id === 'minimal-windows-workspace-shell')
  assert.ok(target)
  const destination = join(root, ...target.path.split('/'))
  await mkdir(dirname(destination), { recursive: true })
  const repositoryPath = join(repositoryRoot, ...target.path.split('/'))
  const original = await readFile(repositoryPath, 'utf8')
  const previous = original
    .replace(
      '    text: You are a helpful software engineer assistant.',
      '    text: You are a helpful software engineer assistant. Your working directory is {{cwd}}. Use this exact absolute path for workspace operations and inspect it before trying other locations.',
    )
    .replace(
      '        shellDialect: pwsh\n        timeoutMs: 300000',
      "        shellDialect: pwsh\n        shellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'\n        timeoutMs: 300000",
    )
  assert.equal(sha256(previous), target.sourceSha256[1])
  await writeFile(destination, previous)
  const recipe = {
    ...DSH_RC2_COMPATIBILITY_RECIPE,
    targets: [target],
  }
  const applied = await applyCompatibilityRecipe({ root, recipe, dshVersion: '0.1.1-rc.2' })
  assert.equal(applied.targets[0].state, 'patched')
  assert.equal(applied.targets[0].sha256, target.appliedSha256)
})

test('unknown anchors and source drift fail before any write', async t => {
  const root = await temporaryRoot(t)
  const path = join(root, 'runtime.js')
  await writeFile(path, 'before\n')
  const recipe = {
    schemaVersion: 1,
    id: 'fixture',
    dsh: { version: '0.1.1-rc.2' },
    targets: [{
      id: 'runtime',
      package: 'runtime',
      path: 'runtime.js',
      sourceSha256: sha256('before\n'),
      appliedSha256: sha256('after\n'),
      operations: [{ id: 'missing', find: 'unknown anchor', replace: 'after\n' }],
      assertions: [{ id: 'after', anchor: 'after', count: 1 }],
    }],
  }
  await assert.rejects(
    applyCompatibilityRecipe({ root, recipe, dshVersion: '0.1.1-rc.2' }),
    error => error?.code === 'COMPATIBILITY_ANCHOR_MISMATCH',
  )
  assert.equal(await readFile(path, 'utf8'), 'before\n')

  recipe.targets[0].sourceSha256 = sha256('different\n')
  await assert.rejects(
    applyCompatibilityRecipe({ root, recipe, dshVersion: '0.1.1-rc.2' }),
    error => error?.code === 'COMPATIBILITY_SOURCE_MISMATCH',
  )
  assert.equal(await readFile(path, 'utf8'), 'before\n')
})

test('recipe rejects version mismatch and paths escaping the candidate root', async t => {
  const root = await temporaryRoot(t)
  await assert.rejects(
    applyCompatibilityRecipe({ root, recipe: DSH_RC2_COMPATIBILITY_RECIPE, dshVersion: '0.1.1-rc.3' }),
    error => error?.code === 'COMPATIBILITY_VERSION_MISMATCH',
  )
  const recipe = {
    schemaVersion: 1,
    id: 'escape',
    dsh: { version: '0.1.1-rc.2' },
    targets: [{ id: 'escape', path: '../outside.js', sourceSha256: 'a'.repeat(64), appliedSha256: 'a'.repeat(64), operations: [], assertions: [] }],
  }
  await assert.rejects(applyCompatibilityRecipe({ root, recipe, dshVersion: '0.1.1-rc.2' }), /Invalid Compatibility target path/)
})

test('restart goal-ticket evidence is hash-pinned and asserts resume semantics', async () => {
  const evidence = await verifyCompatibilityEvidence({ root: repositoryRoot, target: DSH_RC2_COMPATIBILITY_RECIPE.restartGoalTicket.target })
  assert.equal(evidence.verified, true)
  assert.equal(evidence.package, 'dsh-restart-tool')
  assert.equal(evidence.sha256, DSH_RC2_COMPATIBILITY_RECIPE.restartGoalTicket.target.appliedSha256)
})
