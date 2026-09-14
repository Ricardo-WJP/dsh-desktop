import { createRequire } from 'node:module'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { desktopDevPlan } from '../src/build-plan.js'
import { createChildSupervisor, createSpawnOptions, waitForHttp } from '../src/desktop-launcher.js'
import { generatePreloads } from '../src/ipc/preload-generator.js'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const electronBinary = require('electron')
const plan = desktopDevPlan({
  root,
  nodeExecutable: process.execPath,
  electronExecutable: electronBinary,
})
const supervisor = createChildSupervisor({ cwd: root, env: process.env, windowsHide: false })
let interrupted = false
let finished = false
let cleanupPromise

const stopSupervisor = () => {
  cleanupPromise ??= supervisor.stopAll()
  return cleanupPromise
}

const onSignal = () => {
  if (finished || interrupted) return
  interrupted = true
  // Do not exit synchronously: stopAll owns the descendant tree and must be
  // awaited by the finally fence below.
  void stopSupervisor().catch(error => console.error(error instanceof Error ? error.message : String(error)))
}
process.once('SIGINT', onSignal)
process.once('SIGTERM', onSignal)

try {
  generatePreloads(root)
  const vite = supervisor.spawn(
    plan.renderer.command,
    plan.renderer.args,
    createSpawnOptions({ cwd: root, env: process.env, windowsHide: false }),
  )
  const viteExit = supervisor.waitForChild(vite, { signal: supervisor.signal }).then(
    result => ({ kind: 'vite', result }),
    error => ({ kind: 'vite-error', error }),
  )
  const readiness = await Promise.race([
    waitForHttp(plan.readinessUrl, {
      signal: supervisor.signal,
      expectedContent: plan.rendererMarkers,
    }).then(response => ({ kind: 'ready', response })),
    viteExit,
  ])
  if (readiness.kind !== 'ready') {
    if (readiness.kind === 'vite-error') throw readiness.error
    throw new Error(`Vite exited before Electron started (code: ${String(readiness.result?.code ?? 1)}, signal: ${String(readiness.result?.signal ?? 'none')}).`)
  }

  const electron = supervisor.spawn(
    plan.electron.command,
    plan.electron.args,
    createSpawnOptions({
      cwd: root,
      env: { ...process.env, DSH_DESKTOP_RENDERER_URL: plan.rendererUrl },
      windowsHide: false,
    }),
  )
  const electronExit = supervisor.waitForChild(electron, { signal: supervisor.signal }).then(
    result => ({ kind: 'electron', result }),
    error => ({ kind: 'electron-error', error }),
  )
  const firstExit = await Promise.race([viteExit, electronExit])
  if (firstExit.kind === 'vite-error') throw firstExit.error
  if (firstExit.kind === 'vite') {
    // A live Electron child must never be orphaned when its renderer server
    // exits after readiness. Stop the owned tree before returning nonzero.
    if (!interrupted) {
      await supervisor.stopAll()
      throw new Error(`Vite exited while Electron was running (code: ${String(firstExit.result?.code ?? 1)}, signal: ${String(firstExit.result?.signal ?? 'none')}).`)
    }
  }
  if (firstExit.kind === 'electron-error') throw firstExit.error
  const result = firstExit.result
  if (!interrupted && result?.code !== 0) {
    throw new Error(`Electron exited with code ${String(result?.code ?? 1)}.`)
  }
} catch (error) {
  if (!interrupted) console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = interrupted ? 0 : 1
} finally {
  finished = true
  process.removeListener('SIGINT', onSignal)
  process.removeListener('SIGTERM', onSignal)
  // The signal handler may already have initiated this promise. Awaiting
  // supervisor.stopAll guarantees graceful/force cleanup completes before exit.
  await supervisor.stopAll()
}
