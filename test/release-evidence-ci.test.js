import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'

const WORKFLOW_PATH = new URL('../.github/workflows/build.yml', import.meta.url)
const PACKAGE_PATH = new URL('../package.json', import.meta.url)

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function readWorkflow() {
  return (await readWorkflowDocument()).workflow
}

async function readWorkflowDocument() {
  const workflow = await readFile(WORKFLOW_PATH, 'utf8')
  return { workflow, document: parse(workflow) }
}

async function expectedWindowsArtifactGlobs() {
  const packageJson = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'))
  const asGlob = value => value
    .replaceAll('${version}', '*')
    .replaceAll('${arch}', '*')
    .replaceAll('${ext}', 'exe')
  return {
    setup: asGlob(packageJson.build.nsis.artifactName),
    portable: asGlob(packageJson.build.portable.artifactName),
  }
}

test('manual CI packages the Suite variants only after the test job and passes explicit evidence paths', async () => {
  const { workflow, document } = await readWorkflowDocument()
  const globs = await expectedWindowsArtifactGlobs()

  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /build_packages:[\s\S]*default: false[\s\S]*type: boolean/)
  assert.doesNotMatch(workflow, /^\s*(pull_request|push):/m)
  assert.match(workflow, /if: \$\{\{ inputs\.build_packages == true \}\}/)
  assert.match(workflow, /needs: test/)
  assert.match(workflow, /permissions:\n  contents: read/)
  assert.doesNotMatch(workflow, /^\s+release:/m)
  assert.equal([...workflow.matchAll(/name: Use canonical temporary paths for security tests/g)].length, 2)
  assert.match(workflow, /name: Upload release acceptance failure evidence/)
  assert.match(workflow, /if: \$\{\{ failure\(\) \}\}/)
  assert.match(workflow, /name: Upload release acceptance failure evidence\n\s+if: \$\{\{ failure\(\) \}\}\n\s+uses: actions\/upload-artifact@[0-9a-f]{40}/)
  assert.match(workflow, /npm test[\s\S]*tee output\/release-acceptance\/ci-test\.stdout\.log[\s\S]*tee output\/release-acceptance\/ci-test\.stderr\.log/)
  for (const path of [
    'output/release-acceptance/ci-test.stdout.log',
    'output/release-acceptance/ci-test.stderr.log',
    'output/release-acceptance/**/report.json',
    'output/release-acceptance/**/receipt.json',
    'output/release-acceptance/**/release-acceptance-artifact.json',
    'output/release-acceptance/**/*.stdout.log',
    'output/release-acceptance/**/*.stderr.log',
    '!output/release-acceptance/**/electron-user-data/**',
    '!output/release-acceptance/**/electron-tmp/**',
    '!output/release-acceptance/**/home*/**',
    '!output/release-acceptance/home*/**',
    '!output/release-acceptance/**/temp*/**',
    '!output/release-acceptance/temp*/**',
    '!output/release-acceptance/**/tmp*/**',
    '!output/release-acceptance/tmp*/**',
    '!output/release-acceptance/**/credential*/**',
    '!output/release-acceptance/credential*/**',
    '!output/release-acceptance/**/.credentials*/**',
    '!output/release-acceptance/.credentials*/**',
    '!output/release-acceptance/**/credentials*',
    '!output/release-acceptance/**/.credentials*',
    '!output/release-acceptance/**/*secret*',
  ]) {
    assert.match(workflow, new RegExp(escapeRegExp(path)))
  }

  assert.match(workflow, /npm run dist:windows:suite -- \$\{\{ matrix\.arch \}\}/)
  assert.match(workflow, /npm run dist:mac:suite -- \$\{\{ matrix\.arch \}\} --macos-test/)
  assert.doesNotMatch(workflow, /--config\.extends build\/electron-builder\.macos-test\.cjs/)
  const packageSteps = document.jobs.package.steps
  const testSteps = document.jobs.test.steps
  const currentGate = packageSteps.findIndex(step => step.name === 'Validate current release input before packaging')
  assert.ok(currentGate >= 0, 'package job must contain the current release input gate')
  assert.equal(testSteps.some(step => step.name === 'Validate current release input before packaging'), false, 'test job must not require release acceptance')
  assert.ok(currentGate > packageSteps.findIndex(step => step.name === 'Install dependencies'), 'current release input gate must follow dependency installation')
  assert.ok(currentGate < packageSteps.findIndex(step => step.name === 'Build Windows setup and portable packages'), 'current release input gate must precede Windows packaging')
  assert.ok(currentGate < packageSteps.findIndex(step => step.name === 'Build macOS unsigned test DMG'), 'current release input gate must precede macOS packaging')
  assert.match(workflow, /node scripts\/verify-current-release-input\.mjs/)
  assert.match(workflow, /RELEASE_VALIDATION_PATH: .*compatibility\/release-validation\.json/)
  assert.match(workflow, /printf 'RELEASE_ID=%s\\n' "\$release_id" >> "\$GITHUB_ENV"/)
  assert.match(workflow, /name: Stage Windows release artifacts for evidence/)
  assert.match(workflow, /RELEASE_STAGING_ROOT: \$\{\{ github\.workspace \}\}\\release-staging/)
  assert.match(workflow, /DSH-Desktop-Suite-v\*-windows-\*-setup\.exe/)
  assert.match(workflow, /DSH-Desktop-Suite-v\*-windows-\*-portable\.exe/)
  assert.match(workflow, /Copy-Item -LiteralPath \$setup\[0\]\.FullName/)
  assert.match(workflow, /Copy-Item -LiteralPath \$portable\[0\]\.FullName/)
  assert.match(workflow, /SETUP_RELATIVE=windows\//)
  assert.match(workflow, /PORTABLE_RELATIVE=windows\//)
  assert.equal([...workflow.matchAll(new RegExp(`-Filter '${escapeRegExp(globs.setup.replace('DSH-Desktop-', 'DSH-Desktop-Suite-'))}'`, 'g'))].length, 2)
  assert.equal([...workflow.matchAll(new RegExp(`-Filter '${escapeRegExp(globs.portable.replace('DSH-Desktop-', 'DSH-Desktop-Suite-'))}'`, 'g'))].length, 2)
  assert.match(workflow, /artifact_glob: dist\/DSH-Desktop-Suite-v\*-windows-\*\.exe/)
  assert.match(workflow, /artifact_glob: dist\/DSH-Desktop-Suite-v\*-macos-\*\.dmg/)

  assert.match(workflow, /node scripts\/generate-release-evidence\.mjs/)
  for (const flag of [
    '--staging-root "$env:RELEASE_STAGING_ROOT"',
    '--output-dir "$env:RELEASE_EVIDENCE_DIR"',
    '--package-lock "$env:PACKAGE_LOCK_PATH"',
    '--package-json "$env:PACKAGE_JSON_PATH"',
    '--release-manifest "$env:RELEASE_MANIFEST_PATH"',
    '--setup "$env:SETUP_RELATIVE"',
    '--portable "$env:PORTABLE_RELATIVE"',
    '--required-artifact "$env:SETUP_RELATIVE"',
    '--required-artifact "$env:PORTABLE_RELATIVE"',
  ]) {
    assert.match(workflow, new RegExp(escapeRegExp(flag)))
  }
})

test('current release gate and unsigned evidence integrity checks fail closed', async () => {
  const workflow = await readWorkflow()

  assert.match(workflow, /name: Copy validated release manifest input for Windows evidence/)
  assert.match(workflow, /RELEASE_MANIFEST_SOURCE: .*release-manifest\.json/)
  assert.match(workflow, /trusted release manifest input is missing[\s\S]*refusing to fabricate release metadata/)
  assert.match(workflow, /Copy-Item -LiteralPath \$env:RELEASE_MANIFEST_SOURCE -Destination \$env:RELEASE_MANIFEST_PATH -Force/)
  assert.doesNotMatch(workflow, /compatibility\\matrix\.json/)
  assert.match(workflow, /\$evidence\.signing\.status -ne 'unsigned'/)
  assert.match(workflow, /Unsigned release evidence must not carry detached signature or public key material/)
  assert.match(workflow, /verifyReleaseEvidence\(/)
  assert.match(workflow, /Published release manifest differs from the trusted input/)
  assert.doesNotMatch(workflow, /RELEASE_(?:PRIVATE_KEY|SIGNING_KEY|SIGNATURE)/)
})

test('evidence artifact and Suite package uploads include every required asset without public release writes', async () => {
  const workflow = await readWorkflow()
  const requiredAssets = [
    'release-evidence/artifact-manifest.json',
    'release-evidence/bom.cdx.json',
    'release-evidence/THIRD-PARTY-NOTICES.md',
    'release-evidence/release-evidence.json',
    'release-evidence/release-manifest.json',
  ]

  assert.match(workflow, /name: dsh-release-evidence-windows-x64/)
  for (const asset of requiredAssets) assert.match(workflow, new RegExp(escapeRegExp(asset)))
  assert.match(workflow, /name: Upload Windows release evidence/)
  assert.match(workflow, /name: Upload package artifacts/)
  assert.match(workflow, /artifact: windows-x64/)
  assert.match(workflow, /artifact: macos-x64/)
  assert.match(workflow, /artifact: macos-arm64/)
  assert.doesNotMatch(workflow, /gh release (?:view|create|upload)/)
  assert.doesNotMatch(workflow, /contents:\s*write/)
})

test('all GitHub Actions references stay pinned to full commit SHAs', async () => {
  const workflow = await readWorkflow()
  const actionRefs = [...workflow.matchAll(/^\s*uses:\s+(actions\/[^@\s]+)@([0-9a-f]{40})(?:\s|$)/gim)]

  assert.ok(actionRefs.length >= 4, 'expected checkout, setup-node and both evidence/package upload pins')
  assert.doesNotMatch(workflow, /^\s*uses:\s+actions\/[^@\s]+@v\d+/im)
  assert.doesNotMatch(workflow, /^\s*uses:\s+actions\/[^@\s]+@main/im)
  assert.doesNotMatch(workflow, /^\s*uses:\s+actions\/[^@\s]+@master/im)
})
