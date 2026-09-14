import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import process from 'node:process'
import test from 'node:test'
import { waitForChild } from '../src/process-tree.js'
import { OwnedProcessTree } from '../src/runtime/process-owner.js'

const SUPPORTED_PLATFORMS = new Set([
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
])
const TEST_TIMEOUT_MS = 30_000
const PROCESS_WAIT_TIMEOUT_MS = 5_000
const ROLE = 'task4-integration-role'
const LIVE_SCRIPT = 'setInterval(() => {}, 1000)'

function isLive(child) {
  return child.exitCode === null && child.signalCode === null
}

function wait(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs))
}

async function waitForSpawn(child, label) {
  if (child.spawnfile !== undefined && child.spawnfile !== null) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`${label} did not emit spawn within the bounded timeout`))
    }, PROCESS_WAIT_TIMEOUT_MS)
    const onSpawn = () => {
      cleanup()
      resolve()
    }
    const onError = error => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.removeListener('spawn', onSpawn)
      child.removeListener('error', onError)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

async function waitUntilLive(child, label) {
  await waitForSpawn(child, label)
  const deadline = Date.now() + PROCESS_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (isLive(child)) return
    await wait(10)
  }
  throw new Error(`${label} did not remain live: exitCode=${String(child.exitCode)} signalCode=${String(child.signalCode)}`)
}

async function waitUntilExited(child, label) {
  const result = await waitForChild(child, { timeoutMs: PROCESS_WAIT_TIMEOUT_MS })
  assert.notEqual(result, undefined, `${label} did not exit within the bounded timeout`)
  assert.equal(isLive(child), false, `${label} still appears live after exit wait`)
  return result
}

async function stopExactChild(child, label) {
  if (isLive(child)) {
    try { child.kill('SIGTERM') } catch {}
  }
  let result = await waitForChild(child, { timeoutMs: PROCESS_WAIT_TIMEOUT_MS })
  if (result === undefined && isLive(child)) {
    try { child.kill('SIGKILL') } catch {}
    result = await waitForChild(child, { timeoutMs: PROCESS_WAIT_TIMEOUT_MS })
  }
  assert.notEqual(result, undefined, `${label} cleanup exceeded the bounded timeout`)
  assert.equal(isLive(child), false, `${label} remained live after exact-handle cleanup`)
}

const integrationTest = SUPPORTED_PLATFORMS.has(process.platform)
  ? test
  : test.skip

integrationTest('Task4 owns and restarts only its exact real process roots', { timeout: TEST_TIMEOUT_MS }, async t => {
  // Keep this child intentionally outside OwnedProcessTree. Its captured handle
  // is the only authority used for its final cleanup in t.after.
  const unrelated = spawn(process.execPath, ['-e', LIVE_SCRIPT], {
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
  })
  t.after(async () => {
    await stopExactChild(unrelated, 'unrelated child')
  })

  let owner
  const ownedChildren = []
  try {
    await waitUntilLive(unrelated, 'unrelated child')
    assert.equal(Number.isSafeInteger(unrelated.pid) && unrelated.pid > 0, true)
    assert.equal(unrelated.killed, false)

    owner = new OwnedProcessTree({
      terminationTimeoutMs: 2_000,
    })
    const first = owner.spawn(ROLE, process.execPath, ['-e', LIVE_SCRIPT], {
      stdio: 'ignore',
    })
    const firstChild = first.child
    ownedChildren.push(firstChild)
    await waitUntilLive(firstChild, 'first owned root')
    assert.notEqual(first.pid, unrelated.pid)

    // Two concurrent calls must coalesce to one exact replacement root.
    const overlappingA = owner.restart(ROLE, process.execPath, ['-e', LIVE_SCRIPT], {
      stdio: 'ignore',
    })
    const overlappingB = owner.restart(ROLE, process.execPath, ['-e', LIVE_SCRIPT], {
      stdio: 'ignore',
    })
    const [second, coalesced] = await Promise.all([overlappingA, overlappingB])
    const secondChild = second.child
    ownedChildren.push(secondChild)
    assert.equal(second, coalesced)
    await waitUntilExited(firstChild, 'first owned root')
    await waitUntilLive(secondChild, 'coalesced replacement root')
    assert.notEqual(second.pid, unrelated.pid)

    const newest = await owner.restart(ROLE, process.execPath, ['-e', LIVE_SCRIPT], {
      stdio: 'ignore',
    })
    const newestChild = newest.child
    ownedChildren.push(newestChild)
    await waitUntilExited(secondChild, 'coalesced replacement root')
    await waitUntilLive(newestChild, 'newest owned root')
    assert.notEqual(newest.pid, unrelated.pid)

    // The owner has only seen its exact roots; the unrelated child remains live
    // and has not been sent a signal by any owner operation.
    assert.equal(unrelated.killed, false)
    assert.equal(isLive(unrelated), true)
    assert.equal(owner.status(ROLE).descriptor.pid, newest.pid)
    assert.equal(owner.status(ROLE).state, 'running')
  } finally {
    if (owner !== undefined) {
      let ownerError
      try {
        await owner.stopAll(new Error('Task4 integration test cleanup'))
      } catch (error) {
        ownerError = error
      }

      // If production cleanup itself fails, use only the exact captured root
      // handles to prevent an assertion failure from leaking test processes,
      // then rethrow the owner failure so the integration test still fails.
      const fallback = await Promise.allSettled(ownedChildren.map((child, index) => stopExactChild(child, `owned root ${String(index + 1)}`)))
      if (ownerError !== undefined) throw ownerError
      const fallbackFailure = fallback.find(result => result.status === 'rejected')
      if (fallbackFailure !== undefined) throw fallbackFailure.reason
    }
  }
})
