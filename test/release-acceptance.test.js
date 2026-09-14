import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  discoverReleaseAcceptanceInputFiles,
  hashReleaseInputFiles,
  runReleaseAcceptance,
} from '../scripts/release-acceptance.mjs'
import releaseUiFixture from '../test-support/release-ui-fixture.cjs'

const {
  CLIENT_SOURCE_RELATIVE_PATH,
  FIXTURE_SIMULATION_NOTE,
  buildFixtureHtml,
  extractClientUiContract,
} = releaseUiFixture

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fakeFixture(context) {
  return {
    ok: true,
    simulation: true,
    actualDshE2E: false,
    note: FIXTURE_SIMULATION_NOTE,
    inputFingerprint: context.inputFingerprint,
    client: {
      sourceSha256: context.inputManifest.files.find(file => file.path === CLIENT_SOURCE_RELATIVE_PATH)?.sha256,
      cssSha256: 'fake-fixture-css-is-not-used-by-the-default-runner',
    },
    checks: { injectedFixture: { ok: true } },
    networkRequests: [],
  }
}

function validGate(context) {
  return {
    ok: true,
    inputFingerprint: context.inputFingerprint,
    artifactBytesSha256: context.artifact.bytesSha256,
    ...(context.candidate === undefined ? {} : { candidateBytesSha256: context.candidate.bytesSha256 }),
    ...(context.nativeDataSmoke === undefined ? {} : {
      nativeReportSha256: context.nativeDataSmoke.reportSha256,
      nativeRuntimeEntrySha256: context.nativeDataSmoke.runtimeEntrySha256,
    }),
  }
}

async function temporaryOutput(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-release-acceptance-test-'))
  try {
    return await callback(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function expectReject(factory) {
  let caught
  await assert.rejects(async () => {
    try {
      await factory()
    } catch (error) {
      caught = error
      throw error
    }
  })
  assert.ok(caught instanceof Error)
  return caught
}

function runInjected(options = {}) {
  return runReleaseAcceptance({
    root: ROOT,
    outputRoot: options.outputRoot,
    inputFiles: options.inputFiles,
    fixtureRunner: options.fixtureRunner ?? fakeFixture,
    // Success tests hash the complete source tree and also run in parallel
    // with the full suite. Keep deliberate timeout cases explicit below.
    timeoutMs: options.timeoutMs ?? 10_000,
    target: options.target ?? 'all',
    signal: options.signal,
    candidatePath: options.candidatePath,
    flavor: options.flavor,
    suiteReceipt: options.suiteReceipt,
    nativeSmoke: options.nativeSmoke ?? false,
    nativeTimeoutMs: options.nativeTimeoutMs,
    nativeExecutor: options.nativeExecutor,
    gate: options.gate ?? validGate,
  })
}

test('release gate is directly between the renderer build and packager', () => {
  const build = source('../scripts/build-desktop.mjs')
  const renderer = build.indexOf('await run(plan.renderer.command, plan.renderer.args)')
  const acceptance = build.indexOf('await runReleaseAcceptance({')
  const packager = build.indexOf('await run(plan.packager.command, plan.packager.args)')
  assert.ok(renderer >= 0)
  assert.ok(acceptance > renderer)
  assert.ok(packager > acceptance)
  assert.match(build, /import \{ runReleaseAcceptance \} from '\.\/release-acceptance\.mjs'/)
  assert.match(build, /signal: supervisor\.signal/)
  assert.match(build, /flavor: suite \? 'suite' : 'base'/)
  assert.match(build, /suiteReceipt/)
  assert.match(build, /nativeSmoke: true/)
  assert.match(build, /timeoutMs: 180_000/)
  assert.match(build, /nativeTimeoutMs: 120_000/)
  assert.match(build, /releaseExitedRootUnverified/)
  assert.doesNotMatch(build, /releaseCompletedRoot\(/)
  const runner = source('../scripts/release-acceptance.mjs')
  assert.match(runner, /releaseCompletedRoot\(child, completionContract\)/)
  assert.match(runner, /releaseExitedRootUnverified\(child\)/)
})

test('fixture extracts the current client CSS and pure label function without evaluating client.js', () => {
  const contract = extractClientUiContract(ROOT)
  assert.ok(contract.cssEntryCount >= 100)
  assert.match(contract.css, /\.dcu-root>\[data-dsh-mnemon-entry\]/)
  assert.match(contract.css, /section\[data-dsh-mnemon-view\].*data-dsh-desktop-external-page/)
  assert.match(contract.css, /data-dsh-desktop-settings-dialog/)
  assert.match(contract.normalizedLabelSource, /function normalizedLabel\(value\)/)
  assert.equal(contract.sourceSha256, digest(readFileSync(join(ROOT, CLIENT_SOURCE_RELATIVE_PATH))))
  const html = buildFixtureHtml({ contract, inputFingerprint: 'a'.repeat(64) })
  assert.match(html, /data-fixture-css="dsh-client-extracted"/)
  assert.match(html, /data-dsh-sidebar-width|--dsh-sidebar-width/)
})

test('successful acceptance writes a new hash-bound artifact and report for every run', async () => {
  await temporaryOutput(async outputRoot => {
    const first = await runInjected({ outputRoot })
    const second = await runInjected({ outputRoot })
    assert.equal(first.ok, true)
    assert.equal(first.status, 'passed')
    assert.notEqual(first.runId, second.runId)
    assert.notEqual(first.reportPath, second.reportPath)
    assert.equal(first.inputFingerprint, first.inputFingerprintAfter)

    const report = JSON.parse(await readFile(first.reportPath, 'utf8'))
    const artifact = JSON.parse(await readFile(first.artifactPath, 'utf8'))
    const receipt = JSON.parse(await readFile(first.receiptPath, 'utf8'))
    assert.equal(report.ok, true)
    assert.equal(report.inputFingerprint, artifact.inputFingerprint)
    assert.equal(report.inputFingerprint, first.inputFingerprint)
    assert.deepEqual(receipt.selection, { target: 'all', flavor: 'base', suite: false, suiteReceipt: null })
    assert.equal(receipt.inputFingerprint, first.inputFingerprint)
    assert.equal(artifact.verification.fixtureSimulation, true)
    assert.equal(artifact.verification.actualDshE2E, false)
    assert.match(artifact.verification.fullE2E, /not-run/)
    const client = report.inputFiles.find(file => file.path === CLIENT_SOURCE_RELATIVE_PATH)
    assert.equal(client.sha256, digest(readFileSync(join(ROOT, CLIENT_SOURCE_RELATIVE_PATH))))
    assert.equal(report.artifact.bytesSha256, digest(await readFile(first.artifactPath)))
  })
})

test('caller abort signal reaches both the fixture and the gate', async () => {
  await temporaryOutput(async outputRoot => {
    const controller = new AbortController()
    let fixtureSignal
    let gateSignal
    const report = await runInjected({
      outputRoot,
      signal: controller.signal,
      fixtureRunner: async context => {
        fixtureSignal = context.signal
        return fakeFixture(context)
      },
      gate: async context => {
        gateSignal = context.signal
        return validGate(context)
      },
    })
    assert.equal(report.ok, true)
    assert.ok(fixtureSignal instanceof AbortSignal)
    assert.strictEqual(fixtureSignal, gateSignal)
  })
})

test('suite flavor, selected target, and suite receipt are part of the fingerprint and receipt', async () => {
  await temporaryOutput(async outputRoot => {
    const base = await runInjected({ outputRoot, target: 'windows' })
    const suiteReceipt = {
      schemaVersion: 1,
      platform: 'win32',
      arch: 'x64',
      version: '0.2.3',
      executable: 'mnemon.exe',
      archive: 'mnemon-test.zip',
      archiveSha256: 'a'.repeat(64),
      binarySha256: 'b'.repeat(64),
      source: 'https://example.invalid/mnemon-test.zip',
    }
    const suite = await runInjected({ outputRoot, target: 'windows', flavor: 'suite', suiteReceipt })
    const suiteOtherTarget = await runInjected({ outputRoot, target: 'mac', flavor: 'suite', suiteReceipt })
    assert.notEqual(base.inputFingerprint, suite.inputFingerprint)
    assert.notEqual(suite.inputFingerprint, suiteOtherTarget.inputFingerprint)
    const receipt = JSON.parse(await readFile(suite.receiptPath, 'utf8'))
    const artifact = JSON.parse(await readFile(suite.artifactPath, 'utf8'))
    assert.deepEqual(receipt.selection, { target: 'windows', flavor: 'suite', suite: true, suiteReceipt })
    assert.equal(receipt.flavor, 'suite')
    assert.equal(receipt.target, 'windows')
    assert.deepEqual(artifact.selection, receipt.selection)
    assert.ok(receipt.inputFiles.some(file => file.path === 'build/electron-builder.suite.cjs'))
    assert.ok(receipt.inputFiles.some(file => file.path === 'build/plugin-suite/mnemon-assets.json'))
    assert.equal(receipt.inputFingerprint, suite.inputFingerprint)
  })
})

test('native data smoke uses an injectable executor and the completed script CLI contract', async () => {
  await temporaryOutput(async outputRoot => {
    let received
    const report = await runInjected({
      outputRoot,
      nativeSmoke: true,
      nativeTimeoutMs: 120_000,
      nativeExecutor: async spec => {
        received = spec
        await writeFile(spec.reportPath, JSON.stringify({
          ok: true,
          userStateRead: false,
          activeUserReleaseUnchanged: null,
          dataRestorePreservesProgram: true,
          rescueRestorePassed: true,
          checks: ['release-a', 'release-b', 'release-a'].map(release => ({ release, httpStatus: 200, pluginExecuted: true, sharedDataPreserved: true })),
        }), 'utf8')
        return { ok: true, reportPath: spec.reportPath, completionContract: { oneShot: true, descendants: 'none' } }
      },
    })
    const runtimeEntry = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    assert.equal(report.ok, true)
    assert.equal(received.command, process.execPath)
    assert.equal(received.timeoutMs, 120_000)
    assert.deepEqual(received.args.slice(-4), ['--runtime-entry', runtimeEntry, '--report', received.reportPath])
    assert.equal(received.signal.aborted, false)
    assert.equal(report.nativeDataSmoke.bootCount, 3)
    assert.deepEqual(report.nativeDataSmoke.completionContract, { oneShot: true, descendants: 'none' })
    assert.equal(report.nativeDataSmoke.userStateRead, false)
    assert.equal(report.nativeDataSmoke.activeUserReleaseUnchanged, null)
    const nativeReport = JSON.parse(await readFile(report.nativeDataSmoke.reportPath, 'utf8'))
    assert.equal(nativeReport.ok, true)
    assert.equal(JSON.parse(await readFile(report.receiptPath, 'utf8')).nativeDataSmoke.reportSha256, report.nativeDataSmoke.reportSha256)
  })
})

test('default input discovery covers all safe source and related build inputs while excluding generated/temp/secret paths', async () => {
  const files = await discoverReleaseAcceptanceInputFiles(ROOT)
  const required = [
    'src/storage/managed-data-home.js',
    'src/process-tree.js',
    'src/release/manifest.js',
    'src/ipc/contracts.js',
    'package.json',
    'package-lock.json',
    'scripts/verify-managed-data-native.mjs',
    'vite.config.ts',
    'tsconfig.json',
  ]
  for (const path of required) assert.ok(files.includes(path), path)
  assert.ok(files.length > 13)
  assert.equal(files.some(path => /(?:^|\/)(?:output|temp|tmp|dist|artifacts|backups|node_modules|\.git|\.playwright-cli)(?:\/|$)/iu.test(path)), false)
  assert.ok(files.includes('src/renderer/styles/tokens.css'))
  assert.equal(files.some(path => path.endsWith('.credentials.yaml')), false)
  assert.equal(files.some(path => path.startsWith('build/renderer/')), false)
  assert.equal(files.some(path => path.startsWith('build/preload/')), false)
  assert.equal(files.some(path => path.startsWith('build/plugin-suite/bin/')), false)
})

test('source token/auth code remains bound while explicit credential data is excluded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-input-filter-test-'))
  try {
    await mkdir(join(root, 'src', 'renderer', 'styles'), { recursive: true })
    await writeFile(join(root, 'src', 'renderer', 'styles', 'tokens.css'), ':root { --fixture-token: 1; }')
    await writeFile(join(root, 'src', 'token-parser.js'), 'export function parseToken(value) { return value }')
    await writeFile(join(root, 'src', 'auth-client.js'), 'export const authClient = true')
    await writeFile(join(root, 'src', '.credentials.yaml'), 'token: do-not-read')
    await writeFile(join(root, 'src', 'client-secret.json'), '{"secret":"do-not-read"}')
    const files = await discoverReleaseAcceptanceInputFiles(root)
    assert.ok(files.includes('src/renderer/styles/tokens.css'))
    assert.ok(files.includes('src/token-parser.js'))
    assert.ok(files.includes('src/auth-client.js'))
    assert.equal(files.includes('src/.credentials.yaml'), false)
    assert.equal(files.includes('src/client-secret.json'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('gate rejects throw, timeout, undefined, and explicit false results', async () => {
  const cases = [
    ['throw', async () => { throw new Error('injected gate throw') }, /gate threw/i],
    ['timeout', () => new Promise(() => {}), /timed out/i],
    ['undefined', async () => undefined, /empty|undefined|fingerprint/i],
    ['false', async () => ({ ok: false, error: 'injected false' }), /rejected|false/i],
  ]
  for (const [name, gate, message] of cases) {
    await temporaryOutput(async outputRoot => {
      const error = await expectReject(() => runInjected({
        outputRoot,
        inputFiles: name === 'timeout' ? [CLIENT_SOURCE_RELATIVE_PATH] : undefined,
        timeoutMs: name === 'timeout' ? 500 : 2_000,
        gate,
      }))
      assert.match(error.message, message, name)
      assert.equal(error.reportPath !== undefined, true)
      const report = JSON.parse(await readFile(error.reportPath, 'utf8'))
      assert.equal(report.ok, false, name)
      assert.equal(report.status, 'failed', name)
      assert.equal(report.inputFingerprint !== null, true, name)
    })
  }
})

test('gate rejects a stale input fingerprint and a candidate whose bytes changed', async () => {
  await temporaryOutput(async outputRoot => {
    const stale = await expectReject(() => runInjected({
      outputRoot,
      gate: async context => ({
        ok: true,
        inputFingerprint: '0'.repeat(64),
        artifactBytesSha256: context.artifact.bytesSha256,
      }),
    }))
    assert.match(stale.message, /stale.*fingerprint/i)
  })

  await temporaryOutput(async outputRoot => {
    const candidatePath = join(outputRoot, 'candidate.bin')
    await writeFile(candidatePath, 'candidate-before', 'utf8')
    const changed = await expectReject(() => runInjected({
      outputRoot,
      candidatePath,
      gate: async context => {
        await writeFile(context.candidate.path, 'candidate-after', 'utf8')
        return validGate(context)
      },
    }))
    assert.match(changed.message, /candidate.*changed/i)
    const report = JSON.parse(await readFile(changed.reportPath, 'utf8'))
    assert.equal(report.ok, false)
    assert.equal(report.candidate.bytesSha256 !== digest(Buffer.from('candidate-after')), true)
  })
})

test('gate rejects an artifact changed after the gate received its hash', async () => {
  await temporaryOutput(async outputRoot => {
    const changed = await expectReject(() => runInjected({
      outputRoot,
      gate: async context => {
        await writeFile(context.artifact.path, `${await readFile(context.artifact.path, 'utf8')}\nchanged`, 'utf8')
        return validGate(context)
      },
    }))
    assert.match(changed.message, /artifact.*changed/i)
  })
})

test('cross-platform packaging reports the target as unverified when it is not the host', async () => {
  await temporaryOutput(async outputRoot => {
    const target = process.platform === 'win32' ? 'mac' : 'windows'
    const report = await runInjected({ outputRoot, target })
    assert.equal(report.ok, true)
    assert.equal(report.verification.targetPlatformVerified, false)
    assert.match(report.verification.note, /not verified|未验证|not verified/i)
  })
})

test('real acceptance uses one hidden isolated Electron window and records fixture scope', { timeout: 60_000 }, async () => {
  await temporaryOutput(async outputRoot => {
    const report = await runReleaseAcceptance({
      root: ROOT,
      target: 'all',
      outputRoot,
      timeoutMs: 30_000,
    })
    assert.equal(report.ok, true)
    assert.equal(report.fixtureSimulation, true)
    assert.equal(report.actualDshE2E, false)
    assert.match(report.fullE2E, /main agent integration remains required/)
    const artifact = JSON.parse(await readFile(report.artifactPath, 'utf8'))
    assert.equal(artifact.fixture.browserWindow.show, false)
    assert.equal(artifact.fixture.browserWindow.isVisible, false)
    assert.equal(artifact.fixture.browserWindow.userDataIsolated, true)
    assert.equal(artifact.fixture.browserWindow.tempIsolated, true)
    assert.deepEqual(artifact.fixture.networkRequests, [])
    assert.equal(artifact.verification.actualDshE2E, false)
    assert.match(artifact.verification.fullE2E, /not-run/)
    assert.equal(artifact.inputFingerprint, report.inputFingerprint)
    assert.deepEqual(artifact.inputFiles.map(file => file.path), await discoverReleaseAcceptanceInputFiles(ROOT))
    const png = artifact.screenshot
    assert.equal(typeof png.path, 'string')
    const imageStat = await stat(png.path)
    assert.ok(imageStat.size > 1_000)
    assert.equal(png.sha256, digest(await readFile(png.path)))
    const html = await readFile(join(report.outputDir, 'release-ui-fixture.html'), 'utf8')
    assert.doesNotMatch(html, /3080|127\.0\.0\.1:5173/)
    assert.equal(report.fixture.checks['right-sidebar-single-reservation'].ok, true)
    assert.equal(report.fixture.checks['mnemon-independent-page-avoids-panels'].ok, true)
    assert.equal(report.fixture.checks['settings-hierarchy-and-scroll-contract'].ok, true)
    assert.equal(report.fixture.checks['controlled-input-preserves-draft-on-optimizer-failure'].ok, true)
  })
})

test('default Electron fixture failures persist bounded child diagnostics without isolated directories', async () => {
  await temporaryOutput(async outputRoot => {
    let diagnosticsDir
    try {
      const failure = await expectReject(() => runReleaseAcceptance({
        root: ROOT,
        outputRoot,
        electronExecutable: process.execPath,
        timeoutMs: 30_000,
      }))
      diagnosticsDir = failure.failureDiagnosticsDir
      assert.equal(failure.code, 'RELEASE_ACCEPTANCE_ELECTRON_FAILED')
      assert.equal(typeof diagnosticsDir, 'string')
      const diagnostics = JSON.parse(await readFile(join(diagnosticsDir, 'failure-diagnostics.json'), 'utf8'))
      assert.deepEqual(diagnostics.files.sort(), [
        'receipt.json',
        'release-ui-fixture.stderr.log',
        'release-ui-fixture.stdout.log',
        'report.json',
      ])
      assert.notEqual((await readFile(join(diagnosticsDir, 'release-ui-fixture.stderr.log'), 'utf8')).trim(), '')
      for (const excluded of ['electron-user-data', 'electron-tmp', 'cache', 'secret']) {
        await assert.rejects(stat(join(diagnosticsDir, excluded)), { code: 'ENOENT' })
      }
    } finally {
      if (diagnosticsDir !== undefined) await rm(diagnosticsDir, { recursive: true, force: true })
    }
  })
})

test('input fingerprints are content-derived rather than git state', async () => {
  const manifest = await hashReleaseInputFiles(ROOT, [CLIENT_SOURCE_RELATIVE_PATH])
  const bytes = await fs.readFile(join(ROOT, CLIENT_SOURCE_RELATIVE_PATH))
  assert.equal(manifest.files[0].sha256, digest(bytes))
  assert.equal(manifest.fingerprint, digest(`${CLIENT_SOURCE_RELATIVE_PATH}\0${String(bytes.byteLength)}\0${digest(bytes)}`))
})
