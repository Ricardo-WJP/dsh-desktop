import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { desktopBuildPlan, BUILD_TARGETS } from '../src/build-plan.js'
import { createChildSupervisor, createSpawnOptions } from '../src/process-tree.js'
import { generatePreloads } from '../src/ipc/preload-generator.js'
import { runReleaseAcceptance } from './release-acceptance.mjs'
import { preparePluginSuiteAssets } from './prepare-plugin-suite-assets.mjs'

const target = process.argv[2] ?? 'all'
const suite = process.argv.slice(3).includes('--suite')
const macosTest = process.argv.slice(3).includes('--macos-test')
const packagerExtraArgs = process.argv.slice(3).filter(argument => argument !== '--suite' && argument !== '--macos-test')

if (!BUILD_TARGETS.includes(target) || (macosTest && (!suite || target !== 'mac'))) {
  console.error(`Usage: node scripts/build-desktop.mjs ${BUILD_TARGETS.join('|')} [--suite] [--macos-test (mac Suite only)] [electron-builder options]`)
  process.exitCode = 2
} else {
  const root = fileURLToPath(new URL('../', import.meta.url))
  let suiteReceipt
  if (suite) {
    suiteReceipt = await preparePluginSuiteAssets({ root })
    // Select the test config directly: using it as a parent lets the normal
    // Suite child override notarize:false and identity:null again.
    packagerExtraArgs.unshift('--config', macosTest ? 'build/electron-builder.macos-test.cjs' : 'build/electron-builder.suite.cjs')
  }
  const plan = desktopBuildPlan(target, process.platform, packagerExtraArgs, { root, nodeExecutable: process.execPath })
  const supervisor = createChildSupervisor({ cwd: root, env: process.env, windowsHide: true })
  let interrupted = false
  let finished = false
  let cleanupPromise

  const stopSupervisor = () => {
    cleanupPromise ??= supervisor.stopAll()
    return cleanupPromise
  }

  const onSignal = signal => {
    if (finished || interrupted) return
    interrupted = true
    // Handling the signal keeps Node alive long enough for the owned process
    // tree to receive graceful-first cleanup and its force timeout.
    process.exitCode = signal === 'SIGINT' ? 130 : 143
    void stopSupervisor().catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
    })
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  async function run(command, args) {
    if (interrupted) throw new Error('Desktop build interrupted')
    const child = supervisor.spawn(command, args, createSpawnOptions({ cwd: root, env: process.env, windowsHide: true }))
    const result = await supervisor.waitForChild(child, { signal: supervisor.signal })
    if (result?.code !== 0 || result?.signal !== null) {
      supervisor.releaseExitedRootUnverified(child)
      throw new Error(`${command} exited with code ${String(result?.code ?? 1)} and signal ${String(result?.signal ?? null)}`)
    }
    // A normal tool exit proves only its own status. Without an explicit
    // descendant contract, release the exited root as unverified so a reused
    // PID is never targeted by cleanup and no tree-complete claim is made.
    const released = supervisor.releaseExitedRootUnverified(child)
    if (released?.released !== true) throw new Error(`${command} exited but its owned root could not be released safely`)
  }

  try {
    generatePreloads(root)
    await run(plan.renderer.command, plan.renderer.args)
    await runReleaseAcceptance({
      root,
      target,
      flavor: suite ? 'suite' : 'base',
      suiteReceipt,
      timeoutMs: 180_000,
      nativeSmoke: true,
      nativeTimeoutMs: 120_000,
      signal: supervisor.signal,
    })
    await run(plan.packager.command, plan.packager.args)
  } catch (error) {
    if (!interrupted) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  } finally {
    finished = true
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    // The signal handler starts cleanup immediately; this await is the
    // completion fence that prevents the build script from exiting first.
    try { await supervisor.stopAll() } catch (cleanupError) {
      console.error(cleanupError instanceof Error ? cleanupError.message : String(cleanupError))
      process.exitCode = 1
    }
  }
}
