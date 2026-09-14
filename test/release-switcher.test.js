import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SnapshotStore } from '../src/release/snapshot-store.js'
import { ReleaseStateStore } from '../src/release/state-store.js'
import { ReleaseSwitcher } from '../src/release/switcher.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const TIME = '2026-08-22T00:00:00.000Z'

function pointer(releaseId, manifestSha256, activatedAt = TIME) {
  return { schemaVersion: 1, releaseId, manifestSha256, activatedAt }
}

function resolved(releaseId, manifestSha256) {
  return {
    candidate: { status: 'ready', releaseId, manifestSha256 },
    pointer: pointer(releaseId, manifestSha256),
    recipe: { releaseId, physicalProfileName: `${releaseId}-profile` },
  }
}

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-switcher-test-'))
  const state = new ReleaseStateStore(join(root, 'state'))
  const dataRoot = join(root, 'data')
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(join(dataRoot, 'marker.txt'), 'old-data')

  const old = resolved('stable-old', HASH_A)
  const target = resolved('stable-target', HASH_B)
  state.writeActive(old.pointer)
  state.writeLastKnownGood(old.pointer)

  const events = []
  const phases = []
  const created = []
  const restored = []
  const published = new Set()
  const starts = []
  const observations = []
  const resolutions = []
  let stopCalls = 0

  const stateAdapter = {
    readActive: () => state.readActive(),
    readLastKnownGood: () => state.readLastKnownGood(),
    writeActive: value => {
      events.push({ type: 'active', releaseId: value.releaseId })
      return state.writeActive(value)
    },
    writeLastKnownGood: value => {
      events.push({ type: 'lkg', releaseId: value.releaseId })
      return state.writeLastKnownGood(value)
    },
    readPending: () => state.readPending(),
    writePending: value => {
      phases.push(value.phase)
      events.push({ type: 'pending', phase: value.phase, snapshotId: value.snapshotId, rescueSnapshotId: value.rescueSnapshotId })
      return state.writePending(value)
    },
    clearPending: () => {
      events.push({ type: 'clear' })
      return state.clearPending()
    },
  }

  const snapshotStore = {
    async create(options) {
      events.push({ type: 'snapshot', kind: options.kind, snapshotId: options.snapshotId })
      created.push(options)
      published.add(options.snapshotId)
      return { snapshotId: options.snapshotId, kind: options.kind }
    },
    async restore(options) {
      events.push({ type: 'restore', snapshotId: options.snapshotId })
      restored.push(options)
      if (options.snapshotId === 'target-snapshot' && options.failTargetRestore === true) throw new Error('target restore failure')
      return { snapshotId: options.snapshotId }
    },
  }

  const releaseMap = new Map([
    [old.pointer.releaseId, old],
    [target.pointer.releaseId, target],
  ])
  const resolver = async (candidateId, options) => {
    resolutions.push({ candidateId, options })
    const value = releaseMap.get(candidateId)
    if (value === undefined) throw new Error(`unknown candidate ${candidateId}`)
    return value
  }

  const switcher = new ReleaseSwitcher({
    stateStore: stateAdapter,
    snapshotStore,
    dataRoot,
    candidateResolver: options.candidateResolver ?? resolver,
    stopOwned: async () => {
      stopCalls += 1
      events.push({ type: 'stop', call: stopCalls })
      if (typeof options.stopOwned === 'function') return options.stopOwned(stopCalls)
      return options.stopResult ?? true
    },
    startRelease: async release => {
      starts.push(release.pointer.releaseId)
      events.push({ type: 'start', releaseId: release.pointer.releaseId })
      if (typeof options.startRelease === 'function') return options.startRelease(release)
      if (typeof options.startResult === 'function') return options.startResult(release)
      return options.startResult ?? true
    },
    observeRelease: async (release, observeOptions) => {
      observations.push({ releaseId: release.pointer.releaseId, durationMs: observeOptions.durationMs })
      events.push({ type: 'observe', releaseId: release.pointer.releaseId, durationMs: observeOptions.durationMs })
      if (typeof options.observeRelease === 'function') return options.observeRelease(release, observeOptions)
      if (typeof options.observeResult === 'function') return options.observeResult(release)
      return options.observeResult ?? true
    },
    now: () => TIME,
    observeDuration: options.observeDuration ?? 120_000,
    preserveDataOnSwitch: options.preserveDataOnSwitch,
    faults: options.faults,
    randomUUID: () => `uuid-${created.length + 1}`,
  })

  t.after(() => rmSync(root, { recursive: true, force: true }))
  return {
    root,
    state,
    stateAdapter,
    dataRoot,
    snapshotStore,
    old,
    target,
    switcher,
    events,
    phases,
    created,
    restored,
    published,
    starts,
    observations,
    resolutions,
  }
}

test('switch publishes every durable phase in order and observes for the injected duration', async t => {
  const h = fixture(t)
  const result = await h.switcher.switch(h.target.pointer.releaseId)

  assert.equal(result.status, 'switched')
  assert.deepEqual(h.created[0].excludedRelativePaths, ['profiles/node_modules'])
  assert.deepEqual(h.phases, ['prepared', 'snapshot-published', 'active-published', 'observing'])
  assert.deepEqual(h.events.map(event => event.type), [
    'pending', 'stop', 'snapshot', 'pending', 'lkg', 'active', 'pending',
    'start', 'pending', 'observe', 'lkg', 'clear',
  ])
  assert.equal(h.events.find(event => event.type === 'snapshot').kind, 'pre-switch')
  assert.deepEqual(h.observations, [{ releaseId: h.target.pointer.releaseId, durationMs: 120_000 }])
  assert.equal(h.state.readActive().releaseId, h.target.pointer.releaseId)
  assert.equal(h.state.readLastKnownGood().releaseId, h.target.pointer.releaseId)
  assert.equal(h.state.readPending(), undefined)
})

test('an abort delivered as observation completes cannot publish the candidate as last-known-good', async t => {
  const operation = new AbortController()
  const h = fixture(t, {
    observeRelease: async release => {
      if (release.pointer.releaseId === 'stable-target') operation.abort(new Error('observation cancelled'))
      return true
    },
  })

  await assert.rejects(
    h.switcher.switch(h.target.pointer.releaseId, { signal: operation.signal }),
    /observation cancelled|abort/i,
  )
  assert.equal(h.state.readActive().releaseId, h.old.pointer.releaseId)
  assert.equal(h.state.readLastKnownGood().releaseId, h.old.pointer.releaseId)
  assert.equal(h.state.readPending(), undefined)
})

test('switch refuses a candidate whose manifest changed after the plugin transaction was staged', async t => {
  const h = fixture(t)

  await assert.rejects(
    h.switcher.switch('stable-target', { expectedManifestSha256: 'c'.repeat(64) }),
    /manifest changed after verification/i,
  )
  assert.equal(h.state.readActive().releaseId, 'stable-old')
  assert.equal(h.state.readPending(), undefined)
  assert.deepEqual(h.starts, [])
  assert.deepEqual(h.created, [])
})

test('stop failure is fail-closed at prepared and does not publish a snapshot or active pointer', async t => {
  const h = fixture(t, { stopResult: false })

  await assert.rejects(h.switcher.switch(h.target.pointer.releaseId), /stopOwned.*confirm/i)
  assert.equal(h.state.readPending().phase, 'prepared')
  assert.deepEqual(h.created, [])
  assert.equal(h.state.readActive().releaseId, h.old.pointer.releaseId)
  assert.deepEqual(h.starts, [])
  assert.deepEqual(h.observations, [])
})

test('snapshot failure restarts the old release and retires the failed prepared journal', async t => {
  const h = fixture(t)
  h.snapshotStore.create = async () => {
    throw new Error('snapshot create failure')
  }

  await assert.rejects(h.switcher.switch(h.target.pointer.releaseId), /snapshot create failure/)
  assert.equal(h.state.readActive().releaseId, h.old.pointer.releaseId)
  assert.equal(h.state.readLastKnownGood().releaseId, h.old.pointer.releaseId)
  assert.equal(h.state.readPending(), undefined)
  assert.deepEqual(h.starts, [h.old.pointer.releaseId])
  assert.deepEqual(h.observations, [{ releaseId: h.old.pointer.releaseId, durationMs: 5_000 }])
  assert.deepEqual(h.created, [])
  assert.deepEqual(h.restored, [])
})

test('ready failure after active publication retires the recovered journal and retains its snapshot', async t => {
  const h = fixture(t, {
    startResult: release => release.pointer.releaseId === 'stable-target' ? false : true,
  })

  await assert.rejects(h.switcher.switch(h.target.pointer.releaseId), /did not become ready|ready/i)
  assert.equal(h.state.readPending(), undefined)
  assert.equal(h.state.readActive().releaseId, h.old.pointer.releaseId)
  assert.deepEqual(h.starts, [h.target.pointer.releaseId, h.old.pointer.releaseId])
  assert.deepEqual(h.observations, [{ releaseId: h.old.pointer.releaseId, durationMs: 5_000 }])
  assert.deepEqual(h.restored.map(item => item.snapshotId), [h.created[0].snapshotId])
  assert.equal(h.published.has(h.created[0].snapshotId), true)
  assert.deepEqual(h.events.slice(-2).map(event => event.type), ['lkg', 'clear'])
})

test('observe failure after the observing phase restores the old release without guessing target readiness', async t => {
  const h = fixture(t, {
    observeResult: release => release.pointer.releaseId !== 'stable-target',
  })

  await assert.rejects(h.switcher.switch(h.target.pointer.releaseId), /failed observation|observation/i)
  assert.equal(h.state.readPending(), undefined)
  assert.equal(h.state.readActive().releaseId, h.old.pointer.releaseId)
  assert.deepEqual(h.starts, [h.target.pointer.releaseId, h.old.pointer.releaseId])
  assert.deepEqual(h.observations.map(item => item.releaseId), [h.target.pointer.releaseId, h.old.pointer.releaseId])
  assert.equal(h.state.readLastKnownGood().releaseId, h.old.pointer.releaseId)
})

test('active-published checkpoint enters deterministic restoration and keeps artifacts', async t => {
  const h = fixture(t, {
    faults: { 'after-active-published': () => { throw new Error('checkpoint active published') } },
  })

  await assert.rejects(h.switcher.switch(h.target.pointer.releaseId), /checkpoint active published/)
  assert.equal(h.state.readPending(), undefined)
  assert.equal(h.state.readActive().releaseId, h.old.pointer.releaseId)
  assert.equal(h.created.length, 1)
  assert.equal(h.restored.length, 1)
  assert.equal(h.published.has(h.created[0].snapshotId), true)
})

test('manual rollback stops writers before creating rescue and clears only after target readiness', async t => {
  const h = fixture(t)
  h.published.add('target-snapshot')

  const result = await h.switcher.manualRollback('target-snapshot', { candidateId: h.target.pointer.releaseId })

  assert.equal(result.status, 'rolled-back')
  assert.equal(h.created.length, 1)
  assert.equal(h.created[0].kind, 'rescue')
  assert.equal(h.restored[0].snapshotId, 'target-snapshot')
  assert.deepEqual(h.events.map(event => event.type), [
    'pending', 'stop', 'snapshot', 'pending', 'restore', 'active', 'pending',
    'start', 'pending', 'observe', 'lkg', 'clear',
  ])
  assert.equal(h.state.readActive().releaseId, h.target.pointer.releaseId)
  assert.equal(h.state.readLastKnownGood().releaseId, h.target.pointer.releaseId)
  assert.equal(h.state.readPending(), undefined)
})

test('program rollback with independent data preserves writes made after preparation', async t => {
  let h
  h = fixture(t, {
    preserveDataOnSwitch: true,
    startRelease: release => {
      if (release.pointer.releaseId === 'stable-target') {
        writeFileSync(join(h.dataRoot, 'marker.txt'), 'new-user-data')
        throw new Error('target startup failed')
      }
      return true
    },
  })
  await assert.rejects(h.switcher.switch('stable-target'), /target startup failed/)
  assert.equal(h.restored.length, 0)
  assert.equal(readFileSync(join(h.dataRoot, 'marker.txt'), 'utf8'), 'new-user-data')
  assert.equal(h.state.readActive().releaseId, 'stable-old')
  assert.equal(h.state.readPending(), undefined)
})

test('successful program switch records its previous program without rolling back data', async t => {
  const h = fixture(t, { preserveDataOnSwitch: true })
  h.stateAdapter.writePrevious = pointer => h.state.writePrevious(pointer)
  const result = await h.switcher.switch('stable-target')
  assert.equal(result.status, 'switched')
  assert.equal(h.state.readPrevious().releaseId, 'stable-old')
  assert.equal(h.restored.length, 0)
  h.published.add('target-snapshot')
  await h.switcher.manualRollback('target-snapshot')
  assert.equal(h.restored.at(-1).snapshotId, 'target-snapshot')
})

test('manual rollback restore failure restores rescue before retiring the failed journal', async t => {
  const h = fixture(t, {
    observeResult: true,
  })
  const original = h.state.readActive()
  h.published.add('target-snapshot')
  const originalMarker = join(h.dataRoot, 'marker.txt')

  h.snapshotStore.restore = async options => {
    h.restored.push(options)
    if (options.snapshotId === 'target-snapshot') throw new Error('target restore failure')
    return { snapshotId: options.snapshotId }
  }

  await assert.rejects(h.switcher.manualRollback('target-snapshot', { candidateId: h.target.pointer.releaseId }), /target restore failure/)
  assert.equal(h.state.readPending(), undefined)
  assert.equal(h.restored.at(-1).snapshotId, h.created[0].snapshotId)
  assert.equal(h.state.readActive().releaseId, original.releaseId)
  assert.equal(h.published.has('target-snapshot'), true)
  assert.equal(h.created[0].kind, 'rescue')
  assert.equal(h.starts.at(-1), original.releaseId)
  assert.equal(h.observations.at(-1).releaseId, original.releaseId)
  assert.equal(readFileSync(originalMarker, 'utf8'), 'old-data')
})

test('manual rollback cancellation uses an independent signal to restore the previous release', async t => {
  const operation = new AbortController()
  const h = fixture(t, {
    faults: {
      'after-active-published': () => operation.abort(new Error('rollback cancelled')),
    },
  })
  h.published.add('target-snapshot')

  await assert.rejects(
    h.switcher.manualRollback('target-snapshot', {
      candidateId: h.target.pointer.releaseId,
      signal: operation.signal,
    }),
    /rollback cancelled|abort/i,
  )

  assert.equal(h.state.readActive().releaseId, h.old.pointer.releaseId)
  assert.equal(h.state.readLastKnownGood().releaseId, h.old.pointer.releaseId)
  assert.equal(h.starts.at(-1), h.old.pointer.releaseId)
  assert.equal(h.observations.at(-1).releaseId, h.old.pointer.releaseId)
  assert.equal(h.state.readPending(), undefined)
  assert.equal(h.published.has('target-snapshot'), true)
  assert.equal(h.published.has(h.created[0].snapshotId), true)
})

test('manual rollback failure before active publication retires the journal only after rescue restoration succeeds', async t => {
  for (const failRescue of [false, true]) {
    await t.test(failRescue ? 'rescue restore fails' : 'rescue restored', async subtest => {
      const primaryFailure = new Error('injected failure after target restoration')
      const rescueFailure = new Error('injected rescue restore failure')
      const h = fixture(subtest, { faults: { 'rollback:target-restored': primaryFailure } })
      h.published.add('target-snapshot')
      const originalRestore = h.snapshotStore.restore
      h.snapshotStore.restore = async options => {
        if (failRescue && options.snapshotId !== 'target-snapshot') throw rescueFailure
        return originalRestore(options)
      }

      await assert.rejects(
        h.switcher.manualRollback('target-snapshot', { candidateId: h.target.pointer.releaseId }),
        error => error === primaryFailure && error.recoveryError === (failRescue ? rescueFailure : undefined),
      )
      assert.deepEqual(h.state.readActive(), h.old.pointer)
      assert.equal(h.published.has('target-snapshot'), true)
      assert.equal(h.published.has(h.created[0].snapshotId), true)
      if (failRescue) {
        assert.equal(h.state.readPending().rescueSnapshotId, h.created[0].snapshotId)
        await assert.rejects(h.switcher.switch(h.target.pointer.releaseId), /Pending release transaction must be recovered/)
      } else {
        assert.equal(h.state.readPending(), undefined)
        assert.deepEqual(h.restored.map(entry => entry.snapshotId), ['target-snapshot', h.created[0].snapshotId])
        assert.deepEqual(await h.switcher.recoverPending(), { status: 'idle', pending: null })
      }
    })
  }
})

test('completed automatic recovery never replays its real snapshot over newly saved data', async t => {
  let failTarget = true
  const h = fixture(t, {
    startRelease: release => {
      if (release.pointer.releaseId === 'stable-target' && failTarget) {
        writeFileSync(join(h.dataRoot, 'marker.txt'), 'failed-target-data')
        return false
      }
      return true
    },
  })
  const snapshots = new SnapshotStore({ sourceRoot: h.dataRoot, snapshotRoot: join(h.root, 'snapshots') })
  h.snapshotStore.create = async options => {
    h.created.push(options)
    return snapshots.create(options)
  }
  h.snapshotStore.restore = async options => {
    h.restored.push(options)
    return snapshots.restore(options)
  }

  await assert.rejects(h.switcher.switch(h.target.pointer.releaseId), /did not become ready/)
  assert.equal(readFileSync(join(h.dataRoot, 'marker.txt'), 'utf8'), 'old-data')
  assert.equal(h.state.readPending(), undefined)
  writeFileSync(join(h.dataRoot, 'marker.txt'), 'saved-after-recovery')
  const eventsBeforeRecovery = h.events.length

  assert.deepEqual(await h.switcher.recoverPending(), { status: 'idle', pending: null })
  assert.equal(h.events.length, eventsBeforeRecovery)
  assert.equal(h.restored.length, 1)
  assert.equal(readFileSync(join(h.dataRoot, 'marker.txt'), 'utf8'), 'saved-after-recovery')
  const auditSnapshots = await snapshots.list()
  assert.equal(auditSnapshots.length, 1)
  assert.equal(auditSnapshots[0].snapshotId, h.created[0].snapshotId)
  assert.equal(auditSnapshots[0].kind, 'pre-switch')

  failTarget = false
  assert.equal((await h.switcher.switch(h.target.pointer.releaseId)).status, 'switched')
  assert.equal((await snapshots.list()).length, 2)
  assert.equal(readFileSync(join(h.dataRoot, 'marker.txt'), 'utf8'), 'saved-after-recovery')
})

test('new switch and manual rollback preserve every unfinished journal before any side effect', async t => {
  for (const phase of ['prepared', 'snapshot-published', 'active-published', 'observing', 'restoring']) {
    for (const action of ['switch', 'manualRollback']) {
      await t.test(`${action}: ${phase}`, async subtest => {
        const h = fixture(subtest)
        h.state.writePending({
          operation: 'rollback', phase, previousActive: h.old.pointer,
          targetActive: phase === 'restoring' ? null : h.target.pointer,
          snapshotId: 'original-snapshot', rescueSnapshotId: 'original-rescue', startedAt: TIME,
        })
        const originalJournal = readFileSync(h.state.path('pending'), 'utf8')
        const invoke = () => action === 'switch'
          ? h.switcher.switch(h.target.pointer.releaseId)
          : h.switcher.manualRollback('new-snapshot', { candidateId: h.target.pointer.releaseId })

        await assert.rejects(invoke(), error => /Pending release transaction must be recovered/.test(error.message) && error.phase === phase)
        assert.equal(readFileSync(h.state.path('pending'), 'utf8'), originalJournal)
        assert.deepEqual(h.state.readActive(), h.old.pointer)
        assert.deepEqual(h.state.readLastKnownGood(), h.old.pointer)
        assert.deepEqual(h.resolutions, [])
        assert.deepEqual(h.events, [])
      })
    }
  }
})

test('new transactions recheck pending after asynchronous candidate resolution', async t => {
  for (const action of ['switch', 'manualRollback']) {
    await t.test(action, async subtest => {
      const h = fixture(subtest)
      let originalJournal
      h.switcher.candidateResolver = async () => {
        await Promise.resolve()
        h.state.writePending({
          operation: 'switch', phase: 'restoring', previousActive: h.old.pointer,
          targetActive: null, snapshotId: 'intervening-snapshot', rescueSnapshotId: null, startedAt: TIME,
        })
        originalJournal = readFileSync(h.state.path('pending'), 'utf8')
        return h.target
      }

      await assert.rejects(
        action === 'switch'
          ? h.switcher.switch(h.target.pointer.releaseId)
          : h.switcher.manualRollback('new-snapshot', { candidateId: h.target.pointer.releaseId }),
        /Pending release transaction must be recovered/,
      )
      assert.equal(readFileSync(h.state.path('pending'), 'utf8'), originalJournal)
      assert.deepEqual(h.events, [])
    })
  }
})

test('failed automatic restoration preserves its original recovery target until explicit recovery succeeds', async t => {
  const h = fixture(t, { startResult: release => release.pointer.releaseId !== 'stable-target' })
  const originalRestore = h.snapshotStore.restore
  const recoveryFailure = new Error('injected snapshot restore failure')
  h.snapshotStore.restore = async () => { throw recoveryFailure }

  await assert.rejects(h.switcher.switch(h.target.pointer.releaseId), error => /did not become ready/.test(error.message) && error.recoveryError === recoveryFailure)
  const originalJournal = readFileSync(h.state.path('pending'), 'utf8')
  const pending = h.state.readPending()
  assert.equal(pending.phase, 'restoring')
  assert.deepEqual(pending.previousActive, h.old.pointer)
  assert.equal(pending.snapshotId, h.created[0].snapshotId)
  assert.deepEqual(h.state.readActive(), h.target.pointer)
  const eventsBeforeRetry = h.events.length

  await assert.rejects(h.switcher.switch(h.old.pointer.releaseId), /Pending release transaction must be recovered/)
  await assert.rejects(h.switcher.manualRollback('another-snapshot', { candidateId: h.old.pointer.releaseId }), /Pending release transaction must be recovered/)
  assert.equal(readFileSync(h.state.path('pending'), 'utf8'), originalJournal)
  assert.equal(h.events.length, eventsBeforeRetry)
  assert.equal(h.published.has(pending.snapshotId), true)

  h.snapshotStore.restore = originalRestore
  assert.equal((await h.switcher.recoverPending()).status, 'recovered')
  assert.equal(h.state.readPending(), undefined)
  assert.deepEqual(h.state.readActive(), h.old.pointer)
  assert.deepEqual(h.state.readLastKnownGood(), h.old.pointer)
  assert.equal(h.published.has(pending.snapshotId), true)
})

test('recovery start, observation, and journal-commit failures retain a retryable journal', async t => {
  for (const failurePoint of ['start', 'observe', 'old-observed', 'lkg', 'clear']) {
    await t.test(failurePoint, async subtest => {
      const primaryFailure = new Error('injected target failure')
      const recoveryFailure = new Error(`injected recovery ${failurePoint} failure`)
      const h = fixture(subtest, { faults: { 'switch:active-published': primaryFailure } })
      const reset = []
      const failAdapter = (owner, method) => {
        const original = owner[method]
        owner[method] = () => { throw recoveryFailure }
        reset.push(() => { owner[method] = original })
      }
      if (failurePoint === 'start') failAdapter(h.switcher, 'startRelease')
      if (failurePoint === 'observe') failAdapter(h.switcher, 'observeRelease')
      if (failurePoint === 'old-observed') {
        h.switcher.faults['recovery:old-observed'] = recoveryFailure
        reset.push(() => { delete h.switcher.faults['recovery:old-observed'] })
      }
      if (failurePoint === 'lkg') {
        const original = h.stateAdapter.writeLastKnownGood
        let writes = 0
        h.stateAdapter.writeLastKnownGood = value => {
          if (++writes > 1) throw recoveryFailure
          return original(value)
        }
        reset.push(() => { h.stateAdapter.writeLastKnownGood = original })
      }
      if (failurePoint === 'clear') failAdapter(h.stateAdapter, 'clearPending')

      await assert.rejects(h.switcher.switch(h.target.pointer.releaseId), error => error === primaryFailure && error.recoveryError === recoveryFailure)
      assert.equal(h.state.readPending().phase, 'restoring')
      assert.deepEqual(h.state.readPending().previousActive, h.old.pointer)
      assert.equal(h.published.has(h.state.readPending().snapshotId), true)
      assert.equal(h.events.some(event => event.type === 'clear'), false)
      await assert.rejects(h.switcher.switch(h.old.pointer.releaseId), /Pending release transaction must be recovered/)

      for (const restore of reset) restore()
      assert.equal((await h.switcher.recoverPending()).status, 'recovered')
      assert.equal(h.state.readPending(), undefined)
      assert.deepEqual(h.state.readLastKnownGood(), h.old.pointer)
    })
  }
})

test('recovery repairs last-known-good if committing the target journal failed', async t => {
  const h = fixture(t)
  const originalClear = h.stateAdapter.clearPending
  const commitFailure = new Error('injected target pending unlink failure')
  let clears = 0
  h.stateAdapter.clearPending = () => {
    if (++clears === 1) throw commitFailure
    return originalClear()
  }

  await assert.rejects(h.switcher.switch(h.target.pointer.releaseId), error => error === commitFailure)
  assert.equal(h.state.readPending(), undefined)
  assert.deepEqual(h.state.readActive(), h.old.pointer)
  assert.deepEqual(h.state.readLastKnownGood(), h.old.pointer)
  assert.equal(h.published.has(h.created[0].snapshotId), true)
})

test('recoverPending handles each durable phase without treating an uncertain target as ready', async t => {
  for (const phase of ['prepared', 'snapshot-published', 'active-published', 'observing', 'restoring']) {
    await t.test(phase, async subtest => {
      const h = fixture(subtest)
      const preSwitchId = 'pre-existing'
      h.published.add(preSwitchId)
      const pending = {
        operation: 'switch',
        phase,
        previousActive: h.old.pointer,
        targetActive: phase === 'restoring' ? null : h.target.pointer,
        snapshotId: preSwitchId,
        rescueSnapshotId: null,
        startedAt: TIME,
      }
      h.state.writePending(pending)
      if (phase === 'active-published' || phase === 'observing' || phase === 'restoring') h.state.writeActive(h.target.pointer)

      const result = await h.switcher.recoverPending()
      assert.equal(result.status, phase === 'prepared' || phase === 'snapshot-published' ? 'switched' : 'recovered')
      assert.equal(h.state.readPending(), undefined)
      if (phase === 'active-published' || phase === 'observing' || phase === 'restoring') {
        assert.deepEqual(h.starts, [h.old.pointer.releaseId])
        assert.deepEqual(h.observations.map(item => item.releaseId), [h.old.pointer.releaseId])
        assert.equal(h.state.readActive().releaseId, h.old.pointer.releaseId)
      } else {
        assert.deepEqual(h.starts, [h.target.pointer.releaseId])
        assert.deepEqual(h.observations.map(item => item.releaseId), [h.target.pointer.releaseId])
      }
    })
  }
})

test('recoverPending proves the previous release before clearing a restoring journal whose snapshot disappeared', async t => {
  const h = fixture(t)
  const missing = Object.assign(new Error('snapshot directory is missing'), { code: 'ENOENT' })
  h.snapshotStore.restore = async options => {
    h.restored.push(options)
    throw new Error('Unable to inspect Snapshot root', { cause: missing })
  }
  h.state.writePending({
    operation: 'switch',
    phase: 'restoring',
    previousActive: h.old.pointer,
    targetActive: null,
    snapshotId: 'missing-snapshot',
    rescueSnapshotId: null,
    startedAt: TIME,
  })

  const result = await h.switcher.recoverPending()

  assert.equal(result.status, 'recovered')
  assert.equal(result.snapshotMissing, true)
  assert.deepEqual(h.starts, [h.old.pointer.releaseId])
  assert.deepEqual(h.observations.map(item => item.releaseId), [h.old.pointer.releaseId])
  assert.equal(h.state.readActive().releaseId, h.old.pointer.releaseId)
  assert.equal(h.state.readLastKnownGood().releaseId, h.old.pointer.releaseId)
  assert.equal(h.state.readPending(), undefined)
  assert.equal(h.resolutions.at(-1)?.options?.verifyRuntime, false)
})

test('recoverPending restarts the known-good release when a restoring snapshot disappeared before startup', async t => {
  const h = fixture(t)
  const missing = Object.assign(new Error('snapshot directory is missing'), { code: 'ENOENT' })
  h.snapshotStore.restore = async () => {
    throw new Error('Unable to inspect Snapshot root', { cause: missing })
  }
  h.state.writeActive(h.target.pointer)
  h.state.writePending({
    operation: 'switch',
    phase: 'restoring',
    previousActive: h.old.pointer,
    targetActive: null,
    snapshotId: 'missing-snapshot',
    rescueSnapshotId: null,
    startedAt: TIME,
  })

  const result = await h.switcher.recoverPending()

  assert.equal(result.status, 'recovered')
  assert.equal(result.snapshotMissing, true)
  assert.deepEqual(h.starts, [h.old.pointer.releaseId])
  assert.deepEqual(h.observations.map(item => item.releaseId), [h.old.pointer.releaseId])
  assert.equal(h.state.readActive().releaseId, h.old.pointer.releaseId)
  assert.equal(h.state.readLastKnownGood().releaseId, h.old.pointer.releaseId)
  assert.equal(h.state.readPending(), undefined)
})
