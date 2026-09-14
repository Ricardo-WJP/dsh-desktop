import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const buildWorkflow = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8')
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const EXACT_GITHUB = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[a-f0-9]{40}$/i

test('desktop dependencies are exact and package-lock root mirrors every declaration', () => {
  const lockedRoot = packageLock.packages?.['']
  assert.ok(lockedRoot)
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const declared = packageJson[section] ?? {}
    const locked = lockedRoot[section] ?? {}
    assert.deepEqual(locked, declared, `package-lock root ${section} must exactly mirror package.json`)
    for (const [name, specifier] of Object.entries(declared)) {
      assert.ok(
        EXACT_SEMVER.test(specifier) || EXACT_GITHUB.test(specifier),
        `${section}.${name} must be an exact version or 40-character GitHub commit, received ${specifier}`,
      )
    }
  }
})

test('packaged desktop includes immutable profile and compatibility inputs', () => {
  const files = new Set(packageJson.build?.files ?? [])
  for (const required of ['profiles/**/*', 'compatibility/**/*', 'build/renderer/**/*', 'build/preload/**/*']) {
    assert.equal(files.has(required), true, `build.files is missing ${required}`)
  }
  assert.match(packageJson.dependencies['@deepseek-ai/dsh'], EXACT_SEMVER)
})

test('GitHub Actions dependencies are pinned to immutable commits', () => {
  const uses = [...buildWorkflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map(match => match[1])
  assert.ok(uses.length > 0)
  for (const action of uses) {
    assert.match(action, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/i, `${action} is not commit-pinned`)
  }
})
