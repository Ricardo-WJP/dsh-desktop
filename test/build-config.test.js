import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { desktopBuildPlan } from '../src/build-plan.js'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const require = createRequire(import.meta.url)
const suiteBuild = require('../build/electron-builder.suite.cjs')

test('Windows build produces installer and portable packages', () => {
  assert.deepEqual(packageJson.build.win.target, ['nsis', 'portable'])
  assert.equal(packageJson.build.productName, 'DeepSeek Harness Desktop')
  assert.equal(packageJson.build.asar, false)
  assert.equal(packageJson.build.compression, 'normal')
  assert.equal(packageJson.build.win.requestedExecutionLevel, 'asInvoker')
  assert.equal(packageJson.build.nsis.artifactName, 'DSH-Desktop-v${version}-windows-${arch}-setup.${ext}')
  assert.equal(packageJson.build.portable.artifactName, 'DSH-Desktop-v${version}-windows-${arch}-portable.${ext}')
  assert.equal(packageJson.build.portable.requestExecutionLevel, 'user')
  assert.notEqual(packageJson.build.nsis.artifactName, packageJson.build.portable.artifactName)
})

test('Windows installer stays user-safe and omits unused differential updater payloads', () => {
  const nsis = packageJson.build.nsis
  assert.equal(nsis.oneClick, false)
  assert.equal(nsis.perMachine, false)
  assert.equal(nsis.selectPerMachineByDefault, false)
  assert.equal(nsis.allowElevation, true)
  assert.equal(nsis.deleteAppDataOnUninstall, false)
  assert.equal(nsis.differentialPackage, false)
  assert.equal(nsis.packElevateHelper, false)
  assert.equal(nsis.runAfterFinish, true)
  assert.equal(nsis.unicode, true)
  assert.equal(nsis.warningsAsErrors, true)
  assert.match(packageJson.homepage, /^https:\/\/github\.com\/liguobao\/dsh-desktop/)
  assert.equal(packageJson.repository.url, 'https://github.com/liguobao/dsh-desktop.git')
  assert.equal(packageJson.bugs.url, 'https://github.com/liguobao/dsh-desktop/issues')
})

test('installer configuration references only files that are present in the release tree', () => {
  const requiredFiles = [
    packageJson.build.win.icon,
    packageJson.build.nsis.installerIcon,
    packageJson.build.nsis.uninstallerIcon,
    packageJson.build.nsis.installerHeader,
    packageJson.build.nsis.installerSidebar,
    packageJson.build.nsis.uninstallerSidebar,
    packageJson.build.mac.icon,
    packageJson.build.mac.entitlements,
    packageJson.build.mac.entitlementsInherit,
    ...packageJson.build.extraResources.map(resource => resource.from),
    'build/renderer/index.html',
    'build/preload/preload.cjs',
    'build/preload/workspace-preload.cjs',
    'build/preload/splash-preload.cjs',
  ]
  for (const path of new Set(requiredFiles)) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, `missing packaged resource: ${path}`)
  }
})

test('release builds bundle pnpm for profile plugin management', () => {
  assert.match(packageJson.dependencies.pnpm, /^\d+\.\d+\.\d+$/)
})

test('release does not bundle optional plugins by default', () => {
  assert.equal(packageJson.dependencies['dsh-remote'], undefined)
  assert.equal(packageJson.dependencies['dsh-file-viewer'], undefined)
})

test('suite release is a distinct flavor with complete installer artifact names', () => {
  assert.equal(suiteBuild.extraMetadata.dshDesktopFlavor, 'suite')
  assert.ok(suiteBuild.files.includes('build/plugin-suite/**/*'))
  assert.equal(suiteBuild.nsis.artifactName, 'DSH-Desktop-Suite-v${version}-windows-${arch}-setup.${ext}')
  assert.equal(suiteBuild.portable.artifactName, 'DSH-Desktop-Suite-v${version}-windows-${arch}-portable.${ext}')
  assert.equal(suiteBuild.mac.artifactName, 'DSH-Desktop-Suite-v${version}-macos-${arch}.${ext}')
  assert.equal(packageJson.scripts['dist:windows:suite'], 'node scripts/build-desktop.mjs windows --suite')
  assert.equal(packageJson.scripts['dist:mac:suite'], 'node scripts/build-desktop.mjs mac --suite')
  assert.match(packageJson.build.mac.extendInfo.NSMicrophoneUsageDescription, /microphone/i)
})

test('release builds publish only user-facing installers', () => {
  assert.equal(packageJson.build.publish, undefined)
  assert.ok(packageJson.build.files.includes('build/preload/**/*'), 'packaged app must ship generated preloads')
  assert.deepEqual(packageJson.build.mac.target, ['dmg'])
  for (const [scriptName, target] of Object.entries({ dist: 'all', 'dist:linux': 'linux', 'dist:mac': 'mac', 'dist:windows': 'windows' })) {
    assert.equal(packageJson.scripts[scriptName], `node scripts/build-desktop.mjs ${target}`)
    const plan = desktopBuildPlan(target, 'darwin', [], { root: '/workspace', nodeExecutable: '/node' })
    assert.equal(plan.renderer.command, '/node')
    assert.match(plan.renderer.args[0], /node_modules[\\/]vite[\\/]bin[\\/]vite\.js$/)
    assert.deepEqual(plan.renderer.args.slice(-1), ['build'])
    assert.equal(plan.packager.command, '/node')
    assert.match(plan.packager.args[0], /node_modules[\\/]electron-builder[\\/]cli\.js$/)
    assert.deepEqual(plan.packager.args.slice(-2), ['--publish', 'never'])
  }
  assert.equal(packageJson.build.mac.artifactName, 'DSH-Desktop-v${version}-macos-${arch}.${ext}')
  assert.equal(packageJson.dependencies['electron-updater'], undefined)
})

test('macOS DMG ships the install notes with the copyable quarantine command', () => {
  const contents = packageJson.build.dmg.contents
  assert.ok(Array.isArray(contents), 'dmg.contents should be configured')
  const notes = contents.find((item) => item.name === '安装说明.txt')
  assert.ok(notes, 'DMG contents should include 安装说明.txt')
  assert.equal(notes.type, 'file')
  assert.equal(notes.path, 'build/macos-install-notes.txt')
  assert.ok(
    contents.some((item) => item.type === 'link' && item.path === '/Applications'),
    'DMG should keep the /Applications link'
  )
  assert.ok(
    contents.some((item) => item.path == null),
    'DMG should keep the app entry (path omitted, defaults to the built app)'
  )
})

test('macOS install notes contain the xattr quarantine command', () => {
  const notesUrl = new URL('../build/macos-install-notes.txt', import.meta.url)
  assert.equal(existsSync(notesUrl), true)
  const text = readFileSync(notesUrl, 'utf8')
  assert.match(text, /xattr -dr com\.apple\.quarantine "\/Applications\/DeepSeek Harness Desktop\.app"/)
  assert.match(text, /Gatekeeper/)
})
