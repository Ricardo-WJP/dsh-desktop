import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'
import { desktopBuildPlan, desktopDevPlan, validateDesktopDevEndpoint } from '../src/build-plan.js'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const workflow = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8')
const devScript = readFileSync(new URL('../scripts/dev-desktop.mjs', import.meta.url), 'utf8')
const buildScript = readFileSync(new URL('../scripts/build-desktop.mjs', import.meta.url), 'utf8')

test('macOS test packages select a direct Suite test configuration without re-enabling notarization', async () => {
  const require = createRequire(import.meta.url)
  const { getConfig } = require('app-builder-lib/out/util/config/config.js')
  const root = fileURLToPath(new URL('../', import.meta.url))
  const config = await getConfig(root, 'build/electron-builder.macos-test.cjs')
  assert.equal(config.mac.notarize, false)
  assert.equal(config.mac.identity, null)
  assert.equal(config.dmg.sign, false)
  assert.equal(config.extraMetadata.dshDesktopFlavor, 'suite')
  assert.match(buildScript, /macosTest \? 'build\/electron-builder\.macos-test\.cjs' : 'build\/electron-builder\.suite\.cjs'/)
  assert.match(buildScript, /macosTest && \(!suite \|\| target !== 'mac'\)/)
})

 test('every packaging target plans the renderer before electron-builder with direct Node CLI execution', () => {
  const targets = { dist: 'all', 'dist:windows': 'windows', 'dist:mac': 'mac', 'dist:linux': 'linux' }
  for (const [scriptName, target] of Object.entries(targets)) {
    assert.equal(packageJson.scripts[scriptName], `node scripts/build-desktop.mjs ${target}`)
    const plan = desktopBuildPlan(target, 'win32', [], { root: 'C:\\work', nodeExecutable: 'C:\\node.exe' })
    assert.equal(plan.renderer.command, 'C:\\node.exe')
    assert.match(plan.renderer.args[0], /node_modules[\\/]vite[\\/]bin[\\/]vite\.js$/)
    assert.deepEqual(plan.renderer.args.at(-1), 'build')
    assert.equal(plan.packager.command, 'C:\\node.exe')
    assert.match(plan.packager.args[0], /node_modules[\\/]electron-builder[\\/]cli\.js$/)
    assert.doesNotMatch(plan.renderer.command, /(?:\.cmd|npx)/i)
    assert.doesNotMatch(plan.packager.command, /(?:\.cmd|npx)/i)
    assert.deepEqual(plan.packager.args.slice(-2), ['--publish', 'never'])
  }
  assert.match(desktopBuildPlan('linux', 'linux', [], { root: '/work', nodeExecutable: '/node' }).renderer.args[0], /vite[\\/]bin[\\/]vite\.js$/)
  assert.deepEqual(desktopBuildPlan('windows', 'win32', ['--x64'], { root: '/work', nodeExecutable: '/node' }).packager.args.slice(1), ['--win', '--x64', '--publish', 'never'])
  assert.throws(() => desktopBuildPlan('linux', 'linux', [42]), /Invalid desktop packager arguments/)
})

test('development plans derive Vite and Electron from one strict loopback endpoint', () => {
  const plan = desktopDevPlan({ root: 'C:\\work', nodeExecutable: 'C:\\node.exe', electronExecutable: 'C:\\electron.exe' })
  assert.equal(plan.renderer.command, 'C:\\node.exe')
  assert.match(plan.renderer.args[0], /node_modules[\\/]vite[\\/]bin[\\/]vite\.js$/)
  assert.deepEqual(plan.renderer.args.slice(-5), ['--host', '127.0.0.1', '--port', '5173', '--strictPort'])
  assert.equal(plan.endpoint.url, 'http://127.0.0.1:5173')
  assert.equal(plan.readinessUrl, plan.endpoint.url)
  assert.equal(plan.strictPort, true)
  assert.equal(plan.electron.env.DSH_DESKTOP_RENDERER_URL, plan.endpoint.url)
  assert.equal(plan.electron.command, 'C:\\electron.exe')
  assert.deepEqual(plan.electron.args, ['.'])
  assert.doesNotMatch(plan.renderer.command, /(?:\.cmd|npx)/i)
  assert.doesNotMatch(plan.electron.command, /(?:\.cmd|npx)/i)
})

test('development endpoint validation rejects non-loopback and mismatched compatibility overrides', () => {
  assert.equal(validateDesktopDevEndpoint({ host: '127.0.0.1', port: 5180 }).url, 'http://127.0.0.1:5180')
  assert.equal(
    desktopDevPlan({ electronExecutable: 'C:\\electron.exe', rendererUrlOverride: 'http://127.0.0.1:5173/' }).rendererUrl,
    'http://127.0.0.1:5173',
  )
  assert.throws(() => validateDesktopDevEndpoint('http://0.0.0.0:5173'), /127\.0\.0\.1/)
  assert.throws(
    () => desktopDevPlan({ electronExecutable: 'C:\\electron.exe', rendererUrlOverride: 'http://127.0.0.1:5174' }),
    /must match the planned renderer endpoint/,
  )
  assert.throws(
    () => desktopDevPlan({ electronExecutable: 'C:\\electron.exe', rendererUrlOverride: 'http://localhost:5173' }),
    /127\.0\.0\.1/,
  )
  assert.throws(
    () => desktopDevPlan({
      electronExecutable: 'C:\\electron.exe',
      rendererUrlOverride: 'http://127.0.0.1:5173',
      rendererUrl: 'http://127.0.0.1:5174',
    }),
    /conflicting|must match the planned renderer endpoint/i,
  )
})

test('development supervision stops owned Electron when Vite exits after readiness', () => {
  assert.match(devScript, /Promise\.race\(\[viteExit, electronExit\]\)/)
  assert.match(devScript, /Vite exited while Electron was running/)
  assert.match(devScript, /await (?:stopSupervisor|supervisor\.stopAll)\(\)/)
  assert.match(devScript, /expectedContent: plan\.rendererMarkers/)
  assert.doesNotMatch(devScript, /rendererUrlOverride/)
  assert.doesNotMatch(devScript, /shell\s*:\s*true/)
})

test('packaging supervision handles signals and awaits owned cleanup', () => {
  assert.match(buildScript, /process\.once\('SIGINT'/)
  assert.match(buildScript, /process\.once\('SIGTERM'/)
  assert.match(buildScript, /await supervisor\.stopAll\(\)/)
  assert.match(buildScript, /waitForChild\(child, \{ signal: supervisor\.signal \}\)/)
  assert.doesNotMatch(buildScript, /shell\s*:\s*true/)
})

test('start builds the deterministic renderer before Electron', () => {
  assert.equal(packageJson.scripts.start, 'npm run build:renderer && electron .')
  assert.equal(packageJson.scripts.prestart, 'npm run build:preloads')
})

test('CI typechecks and builds the renderer before every matrix package command', () => {
  const config = parseYaml(workflow)
  assert.deepEqual(Object.keys(config.on), ['workflow_dispatch'])
  assert.equal(config.on.workflow_dispatch.inputs.build_packages.default, false)
  assert.equal(config.jobs.package.if, '${{ inputs.build_packages == true }}')
  assert.equal(config.jobs.package.needs, 'test')
  assert.equal(config.permissions.contents, 'read')
  const steps=config.jobs.package.steps
  const typecheckStep=steps.findIndex(s=>s.run==='npm run renderer:typecheck')
  const rendererStep=steps.findIndex(s=>s.run==='npm run build:renderer')
  assert.ok(typecheckStep >= 0 && rendererStep > typecheckStep)
  const packaging=steps.map((s,i)=>({s,i})).filter(({s})=>/npm run dist:/.test(s.run??''))
  assert.equal(packaging.length,2)
  assert.ok(packaging.every(({i})=>i>rendererStep))
  assert.ok(packaging.some(({s})=>s.run.includes('dist:windows:suite')))
  assert.ok(packaging.some(({s})=>s.run.includes('dist:mac:suite')))
  assert.deepEqual(config.jobs.package.strategy.matrix.include.map(x=>x.artifact).sort(), ['macos-arm64','macos-x64','windows-x64'])
})
