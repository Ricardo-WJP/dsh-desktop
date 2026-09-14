import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CandidateGateError,
  RemovalConfirmationError,
  createPluginTransactionService,
} from '../src/profile/transaction-service.js'

const integrity = `sha512-${'a'.repeat(24)}`
const commit = 'b'.repeat(40)

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]))
  return value
}

function initialProfile() {
  return {
    packageJson: {
      name: 'candidate-profile',
      private: true,
      dependencies: {
        existing: '1.0.0',
        other: '2.0.0',
      },
      dsh: { profile: { bundles: ['existing', 'other'] } },
    },
    config: {
      existing: { enabledByDefault: true },
    },
    packageGraph: {
      existing: [],
      other: ['existing'],
    },
    bundleDependencies: {
      other: ['existing'],
    },
  }
}

async function makeHarness(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-transaction-'))
  const localRoot = join(root, 'local')
  await mkdir(localRoot, { recursive: true })
  const localPlugin = join(localRoot, 'local-plugin')
  await mkdir(localPlugin)
  const active = initialProfile()
  const candidates = new Map()
  const calls = {
    clone: [],
    read: [],
    write: [],
    invoke: [],
    inventory: [],
    gate: [],
    runtimeGate: [],
    finalize: [],
    discard: [],
    pack: [],
    activeRead: [],
    npm: [],
    git: [],
  }
  const defaults = {
    mode: 'stable',
    allowedRoots: [localRoot],
    runPnpm: async request => {
      calls.npm.push(request)
      return { output: JSON.stringify({ version: '1.2.3', dist: { integrity } }) }
    },
    runGit: async request => {
      calls.git.push(request)
      return { output: `${commit}\trefs/heads/main\n` }
    },
    cloneActiveProfile: async request => {
      calls.clone.push(request)
      candidates.set(request.candidatePath, clone(active))
      return { candidatePath: request.candidatePath }
    },
    discardCandidate: async request => {
      calls.discard.push(request)
      candidates.delete(request.candidatePath)
      return { ok: true }
    },
    readCandidateProfile: async request => {
      calls.read.push(request)
      return clone(candidates.get(request.candidatePath) ?? {})
    },
    writeCandidateProfile: async request => {
      calls.write.push(request)
      candidates.set(request.candidatePath, clone(request.profile))
    },
    inventoryScripts: async request => {
      calls.inventory.push(request)
      return []
    },
    invokeDshPlugin: async request => {
      calls.invoke.push(request)
      return { ok: true, argv: [...request.argv] }
    },
    runCandidateGate: async request => {
      calls.gate.push(request)
      return { ok: true, checks: ['profile', 'compatibility'] }
    },
    packLocalSource: async request => {
      calls.pack.push(request)
      return {
        package: request.packageName ?? 'local-plugin',
        version: '3.0.0',
        integrity,
        sha256: 'c'.repeat(64),
        artifactPath: join(request.candidatePath, 'packages', 'local-plugin-3.0.0.tgz'),
        specifier: 'file:./packages/local-plugin-3.0.0.tgz',
      }
    },
    idFactory: () => 'generated-candidate',
  }
  const service = createPluginTransactionService({ ...defaults, ...overrides, candidateRoot: root })
  return {
    root,
    localRoot,
    localPlugin,
    active,
    candidates,
    calls,
    service,
    async close() { await rm(root, { recursive: true, force: true }) },
  }
}

test('install resolves exact npm metadata and invokes official DSH with argv and shell:false', async t => {
  const harness = await makeHarness()
  t.after(harness.close)

  const report = await harness.service.install({
    candidateId: 'install-001',
    name: 'new-plugin',
    source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
  })

  const invocation = harness.calls.invoke[0]
  assert.deepEqual(invocation.argv, [
    'plugin',
    '--profile',
    join(harness.root, 'install-001'),
    'add',
    '--workspace-root',
    '--save-prod',
    '--reporter',
    'append-only',
    '--config.strict-dep-builds=false',
    'new-plugin@1.2.3',
  ])
  assert.equal(invocation.shell, false)
  assert.equal(Object.hasOwn(invocation, 'command'), false)
  assert.equal(harness.calls.npm[0].shell, false)
  assert.deepEqual(report.sourceExact, {
    type: 'npm',
    package: 'new-plugin',
    version: '1.2.3',
    integrity,
    specifier: 'new-plugin@1.2.3',
    promotable: true,
  })
  assert.deepEqual(report.packages.added, ['new-plugin'])
  assert.equal(harness.calls.write[0].profile.packageJson.dependencies['new-plugin'], '1.2.3')
  assert.deepEqual(report.candidate, {
    id: 'install-001',
    path: join(harness.root, 'install-001'),
  })
  assert.deepEqual(harness.active, initialProfile())
  assert.deepEqual(report.gate, { ok: true, checks: ['profile', 'compatibility'] })
  assert.equal(harness.calls.runtimeGate.length, 0)
})

test('desktop owner can explicitly retire a successfully returned but unstaged candidate', async t => {
  const harness = await makeHarness()
  t.after(harness.close)
  const candidateId = 'unstaged-candidate'
  const candidatePath = join(harness.root, candidateId)
  harness.candidates.set(candidatePath, initialProfile())

  const retired = await harness.service.discardCandidateRelease({
    candidateId,
    candidatePath,
    action: 'journal-write-failed',
  })

  assert.equal(retired.ok, true)
  assert.equal(harness.candidates.has(candidatePath), false)
  assert.equal(harness.calls.discard.at(-1).candidateId, candidateId)
  assert.equal(harness.calls.discard.at(-1).action, 'journal-write-failed')
})

test('installMany resolves, finalizes, and gates selected plugins once in one candidate transaction', async t => {
  const progress = []
  const harness = await makeHarness({
    finalizeCandidate: async request => {
      harness.calls.finalize.push(request)
      request.onProgress?.({ phase: 'runtime-verify', completed: 1, total: 2 })
      return { ok: true, manifestSha256: 'd'.repeat(64) }
    },
  })
  t.after(harness.close)

  const report = await harness.service.installMany({
    sources: [
      { name: 'first-plugin', source: { type: 'npm', package: 'first-plugin', versionOrTag: 'latest' } },
      { name: 'second-plugin', source: { type: 'npm', package: 'second-plugin', versionOrTag: 'latest' } },
    ],
    buildPermissions: { 'first-plugin': true, 'second-plugin': true },
    onProgress: update => progress.push(update),
  })

  assert.deepEqual(harness.calls.invoke[0].argv, [
    'plugin',
    '--profile',
    join(harness.root, 'generated-candidate'),
    'add',
    '--workspace-root',
    '--save-prod',
    '--reporter',
    'append-only',
    '--config.strict-dep-builds=false',
    '--allow-build=first-plugin',
    '--allow-build=second-plugin',
    'first-plugin@1.2.3',
    'second-plugin@1.2.3',
  ])
  assert.deepEqual(report.packageNames, ['first-plugin', 'second-plugin'])
  assert.equal(report.gates.length, 1)
  assert.equal(harness.calls.write.length, 1)
  assert.equal(harness.calls.gate.length, 1)
  assert.equal(harness.calls.finalize.length, 1)
  assert.equal(report.finalization.length, 1)
  assert.deepEqual(harness.calls.finalize[0].packages.map(entry => entry.packageName), ['first-plugin', 'second-plugin'])
  assert.deepEqual(report.packages.added, ['first-plugin', 'second-plugin'])
  assert.equal(harness.calls.write[0].profile.packageJson.dependencies['first-plugin'], '1.2.3')
  assert.equal(harness.calls.write[0].profile.packageJson.dependencies['second-plugin'], '1.2.3')
  assert.deepEqual(progress.map(update => update.phase), [
    'candidate-clone',
    'candidate-clone',
    'source-resolve',
    'source-resolve',
    'plugin-install',
    'plugin-install',
    'candidate-finalize',
    'runtime-verify',
    'candidate-finalize',
    'static-gate',
    'static-gate',
    'complete',
  ])
  assert.deepEqual(progress.find(update => update.phase === 'runtime-verify'), {
    phase: 'runtime-verify',
    completed: 1,
    total: 2,
  })
})

test('installMany seals a curated local plugin into the same immutable candidate', async t => {
  const harness = await makeHarness({ mode: 'stable' })
  t.after(harness.close)

  const report = await harness.service.installMany({
    sources: [
      { name: 'local-plugin', source: { type: 'local-dev', path: harness.localPlugin } },
      { name: 'remote-plugin', source: { type: 'npm', package: 'remote-plugin', versionOrTag: '1.2.3' } },
    ],
    buildPermissions: { 'local-plugin': true, 'remote-plugin': true },
  })

  assert.equal(harness.calls.pack.length, 1)
  assert.equal(harness.calls.inventory[0].source.type, 'local-dev')
  assert.deepEqual(harness.calls.invoke[0].argv.slice(-2), [
    'file:./packages/local-plugin-3.0.0.tgz',
    'remote-plugin@1.2.3',
  ])
  assert.equal(report.sources[0].type, 'local-pack')
  assert.equal(harness.calls.write[0].profile.packageJson.dependencies['local-plugin'], 'file:./packages/local-plugin-3.0.0.tgz')
})

test('installMany ignores progress callback failures without corrupting the transaction', async t => {
  const harness = await makeHarness()
  t.after(harness.close)

  const report = await harness.service.installMany({
    sources: [
      { name: 'new-plugin', source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' } },
    ],
    onProgress: () => { throw new Error('renderer closed') },
  })

  assert.equal(report.candidateId, 'generated-candidate')
  assert.deepEqual(report.packages.added, ['new-plugin'])
})

test('candidate finalization runs before the compatibility gate and is reported', async t => {
  const harness = await makeHarness({
    finalizeCandidate: async request => {
      harness?.calls?.finalize?.push(request)
      return { ok: true, manifestSha256: 'd'.repeat(64) }
    },
  })
  t.after(harness.close)

  const report = await harness.service.install({
    candidateId: 'finalize-001',
    name: 'new-plugin',
    source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
  })

  assert.equal(report.finalization.ok, true)
  assert.equal(harness.calls.finalize.length, 1)
  assert.equal(harness.calls.gate.length, 1)
})

test('runtime candidate gate runs after static compatibility and is reported separately', async t => {
  const order = []
  const harness = await makeHarness({
    runCandidateGate: async request => {
      order.push('static')
      return { ok: true, checks: ['profile'] }
    },
    runCandidateRuntimeGate: async request => {
      order.push('runtime')
      harness.calls.runtimeGate.push(request)
      return { ok: true, gate: 'candidate-runtime-smoke-v1', httpStatus: 200 }
    },
  })
  t.after(harness.close)

  const report = await harness.service.install({
    candidateId: 'runtime-gated-001',
    name: 'new-plugin',
    source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
  })

  assert.deepEqual(order, ['static', 'runtime'])
  assert.equal(report.gate.runtime.httpStatus, 200)
  assert.equal(harness.calls.runtimeGate.length, 1)
})

test('runtime candidate gate failure rejects installation without touching the active profile', async t => {
  const harness = await makeHarness({
    runCandidateRuntimeGate: async request => {
      harness.calls.runtimeGate.push(request)
      return { ok: false, code: 'CANDIDATE_RUNTIME_GATE_FAILED', failed: 'host-exit' }
    },
  })
  t.after(harness.close)
  const activeBefore = clone(harness.active)

  await assert.rejects(
    harness.service.install({
      candidateId: 'runtime-gate-fails',
      name: 'new-plugin',
      source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
    }),
    error => error instanceof CandidateGateError && error.receipt.code === 'CANDIDATE_RUNTIME_GATE_FAILED',
  )
  assert.deepEqual(harness.active, activeBefore)
  assert.equal(harness.calls.runtimeGate.length, 1)
  assert.equal(harness.calls.discard.length, 1)
  assert.equal(harness.calls.discard[0].candidateId, 'runtime-gate-fails')
  assert.equal(harness.candidates.has(join(harness.root, 'runtime-gate-fails')), false)
})

for (const [label, receipt] of [
  ['undefined', undefined],
  ['null', null],
  ['empty object', {}],
  ['missing ok', { status: 'passed' }],
  ['bare true', true],
  ['bare false', false],
  ['array', []],
  ['truthy number', { ok: 1 }],
  ['truthy string', { ok: 'true' }],
  ['candidate mismatch', { ok: true, candidateId: 'another-candidate' }],
]) {
  test(`runtime candidate gate rejects ${label} and discards only the failed candidate`, async t => {
    const harness = await makeHarness({
      runCandidateRuntimeGate: async request => {
        harness.calls.runtimeGate.push(request)
        return receipt
      },
    })
    t.after(harness.close)
    const activeBefore = clone(harness.active)
    const candidateId = 'invalid-runtime-receipt'
    const unrelatedPath = join(harness.root, 'unrelated-candidate')
    harness.candidates.set(unrelatedPath, clone(activeBefore))

    await assert.rejects(
      harness.service.install({
        candidateId,
        name: 'new-plugin',
        source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
      }),
      error => {
        assert.ok(error instanceof CandidateGateError)
        assert.deepEqual(error.receipt, receipt)
        if (label === 'candidate mismatch') assert.match(error.message, /candidate.*mismatch/i)
        return true
      },
    )
    assert.equal(harness.calls.runtimeGate.length, 1)
    assert.equal(harness.calls.discard.length, 1)
    assert.equal(harness.calls.discard[0].candidateId, candidateId)
    assert.equal(harness.candidates.has(join(harness.root, candidateId)), false)
    assert.deepEqual(harness.candidates.get(unrelatedPath), activeBefore)
    assert.deepEqual(harness.active, activeBefore)
  })
}

for (const asynchronous of [false, true]) {
  test(`runtime candidate gate preserves a ${asynchronous ? 'rejected promise' : 'synchronous exception'} and cleans up`, async t => {
    const failure = Object.assign(new Error('injected runtime startup failure'), { code: 'CANDIDATE_RUNTIME_GATE_FAILED' })
    const harness = await makeHarness({
      runCandidateRuntimeGate: request => {
        harness.calls.runtimeGate.push(request)
        if (asynchronous) return Promise.reject(failure)
        throw failure
      },
    })
    t.after(harness.close)
    const activeBefore = clone(harness.active)
    const candidateId = 'runtime-exception'

    await assert.rejects(
      harness.service.install({
        candidateId,
        name: 'new-plugin',
        source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
      }),
      error => error === failure,
    )
    assert.equal(harness.calls.runtimeGate.length, 1)
    assert.equal(harness.calls.discard.length, 1)
    assert.equal(harness.calls.discard[0].candidateId, candidateId)
    assert.equal(harness.candidates.has(join(harness.root, candidateId)), false)
    assert.deepEqual(harness.active, activeBefore)
  })
}

for (const includeCandidateId of [false, true]) {
  test(`runtime candidate gate accepts explicit ok:true ${includeCandidateId ? 'with matching candidateId' : 'without optional fields'}`, async t => {
    const candidateId = 'valid-runtime-receipt'
    const receipt = { ok: true, ...(includeCandidateId ? { candidateId } : {}) }
    const harness = await makeHarness({ runCandidateRuntimeGate: async () => receipt })
    t.after(harness.close)

    const report = await harness.service.install({
      candidateId,
      name: 'new-plugin',
      source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
    })
    assert.equal(report.gate.ok, true)
    assert.deepEqual(report.gate.runtime, receipt)
    assert.notEqual(report.gate.runtime, receipt)
    assert.equal(harness.calls.discard.length, 0)
    assert.equal(harness.candidates.has(join(harness.root, candidateId)), true)
    assert.deepEqual(harness.active, initialProfile())
  })
}

test('installMany discards a failed candidate while preserving the original finalization error', async t => {
  const harness = await makeHarness({
    finalizeCandidate: async () => { throw new Error('manifest identity mismatch') },
  })
  t.after(harness.close)

  await assert.rejects(
    harness.service.installMany({
      sources: [{ name: 'new-plugin', source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' } }],
    }),
    /manifest identity mismatch/,
  )
  assert.equal(harness.calls.discard.length, 1)
  assert.equal(harness.calls.discard[0].candidateId, 'generated-candidate')
  assert.equal(harness.candidates.has(join(harness.root, 'generated-candidate')), false)
})

test('candidate clone parent identity is preserved through the transaction report', async t => {
  const finalizations = []
  const harness = await makeHarness({
    cloneActiveProfile: async request => ({
      candidatePath: request.candidatePath,
      parentReleaseId: 'stable-parent-release',
    }),
    finalizeCandidate: async request => {
      finalizations.push(request)
      return { ok: true, manifestSha256: 'd'.repeat(64) }
    },
  })
  t.after(harness.close)

  const report = await harness.service.install({
    candidateId: 'parent-bound-candidate',
    name: 'new-plugin',
    source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
  })

  assert.equal(report.parentReleaseId, 'stable-parent-release')
  assert.equal(report.candidate.parentReleaseId, 'stable-parent-release')
  assert.equal(finalizations.length, 1)
  assert.equal(finalizations[0].parentReleaseId, 'stable-parent-release')
})

test('a nonzero DSH plugin command result fails closed and discards the candidate', async t => {
  const harness = await makeHarness({
    invokeDshPlugin: async request => {
      harness.calls.invoke.push(request)
      return { exitCode: 7 }
    },
  })
  t.after(harness.close)

  await assert.rejects(
    harness.service.install({
      candidateId: 'command-failed-candidate',
      name: 'new-plugin',
      source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
    }),
    error => error?.code === 'DSH_PLUGIN_COMMAND_FAILED' && error?.exitCode === 7,
  )
  assert.equal(harness.calls.write.length, 0)
  assert.equal(harness.calls.gate.length, 0)
  assert.equal(harness.calls.discard.length, 1)
})

test('abort waits for an adapter to drain before the transaction rejects and cleans up', async t => {
  let resolveStarted
  let resolveAdapter
  const started = new Promise(resolve => { resolveStarted = resolve })
  const adapter = new Promise(resolve => { resolveAdapter = resolve })
  const harness = await makeHarness({
    invokeDshPlugin: async request => {
      harness.calls.invoke.push(request)
      resolveStarted()
      await adapter
      return { ok: true }
    },
  })
  t.after(harness.close)
  const controller = new AbortController()
  const cancellation = new Error('transaction canceled while adapter owned files')
  const pending = harness.service.install({
    candidateId: 'abort-drain-candidate',
    name: 'new-plugin',
    source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
    signal: controller.signal,
  })
  const observed = pending.then(
    value => ({ status: 'resolved', value }),
    error => ({ status: 'rejected', error }),
  )

  await started
  controller.abort(cancellation)
  const settledBeforeDrain = await Promise.race([
    observed.then(() => true),
    new Promise(resolve => setImmediate(() => resolve(false))),
  ])
  assert.equal(settledBeforeDrain, false)
  assert.equal(harness.calls.discard.length, 0)

  resolveAdapter()
  const outcome = await observed
  assert.equal(outcome.status, 'rejected')
  assert.equal(outcome.error, cancellation)
  assert.equal(harness.calls.write.length, 0)
  assert.equal(harness.calls.gate.length, 0)
  assert.equal(harness.calls.discard.length, 1)
})

test('update resolves GitHub to an exact commit and preserves a disabled bundle', async t => {
  const harness = await makeHarness()
  t.after(harness.close)
  const active = harness.active
  active.packageJson.dsh.profile.bundles = ['other']
  active.packageJson.dependencies.existing = `github:owner/repo#${commit}`

  const report = await harness.service.update({
    candidateId: 'update-001',
    name: 'existing',
    source: { type: 'github', repository: 'owner/repo', ref: 'main' },
  })

  assert.equal(harness.calls.git[0].shell, false)
  assert.deepEqual(harness.calls.git[0].args, ['ls-remote', '--refs', 'https://github.com/owner/repo.git', 'main'])
  assert.equal(report.sourceExact.commit, commit)
  assert.deepEqual(harness.calls.invoke[0].argv.slice(-1), [`github:owner/repo#${commit}`])
  assert.deepEqual(report.bundles.after, ['other'])
})

test('setEnabled, reorder, and configure share candidate write and gate semantics', async t => {
  const harness = await makeHarness()
  t.after(harness.close)

  const disabled = await harness.service.setEnabled({ candidateId: 'enabled-001', name: 'existing', enabled: false })
  assert.deepEqual(disabled.bundles.after, ['other'])

  const reordered = await harness.service.reorder({ candidateId: 'reorder-001', order: ['other', 'existing'] })
  assert.equal(reordered.order.changed, true)
  assert.deepEqual(reordered.order.after, ['other', 'existing'])

  const configured = await harness.service.configure({
    candidateId: 'configure-001',
    name: 'existing',
    config: { enabledByDefault: false, panel: 'compact' },
  })
  assert.deepEqual(configured.config.after, { enabledByDefault: false, panel: 'compact' })
  assert.equal(harness.calls.invoke.length, 3)
  for (const invocation of harness.calls.invoke) {
    assert.deepEqual(invocation.argv.slice(-6), ['install', '--prefer-offline', '--frozen-lockfile', '--reporter', 'append-only', '--config.strict-dep-builds=false'])
    assert.equal(invocation.shell, false)
  }
  assert.equal(harness.calls.write.length, 3)
  assert.equal(harness.calls.gate.length, 3)
  assert.equal(harness.calls.inventory.length, 0)
})

test('replaceSource and promoteLocal use the same candidate transaction owner', async t => {
  const harness = await makeHarness()
  t.after(harness.close)

  const replaced = await harness.service.replaceSource({
    candidateId: 'replace-001',
    name: 'existing',
    source: { type: 'npm', package: 'existing', versionOrTag: 'latest' },
  })
  assert.equal(replaced.sourceExact.version, '1.2.3')
  assert.deepEqual(replaced.bundles.after, ['existing', 'other'])

  const promoted = await harness.service.promoteLocal({
    candidateId: 'promote-001',
    name: 'local-plugin',
    source: { type: 'local-dev', path: harness.localPlugin },
  })
  assert.equal(promoted.sourceExact.type, 'local-pack')
  assert.equal(promoted.sourceExact.sha256, 'c'.repeat(64))
  assert.equal(harness.calls.pack.length, 1)
  assert.equal(harness.calls.pack[0].candidatePath.startsWith(harness.root), true)
  assert.equal(harness.calls.inventory.at(-1).source.type, 'local-dev')
  assert.equal(harness.calls.invoke.at(-1).argv.at(-1), 'file:./packages/local-plugin-3.0.0.tgz')
})

test('install and prepare scripts are inventoried and blocked unless each package is explicitly allowed', async t => {
  const scripts = {
    packages: [{ package: 'new-plugin', scripts: { prepare: 'npm run build', postinstall: 'node build.js' } }],
  }
  const blockedHarness = await makeHarness({ inventoryScripts: async () => scripts })
  t.after(blockedHarness.close)
  await assert.rejects(
    blockedHarness.service.install({
      candidateId: 'scripts-blocked',
      name: 'new-plugin',
      source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
    }),
    error => error?.code === 'BUILD_PERMISSION_REQUIRED',
  )
  assert.equal(blockedHarness.calls.invoke.length, 0)
  assert.equal(blockedHarness.calls.write.length, 0)
  assert.equal(blockedHarness.calls.gate.length, 0)

  const allowedHarness = await makeHarness({ inventoryScripts: async () => scripts })
  t.after(allowedHarness.close)
  const report = await allowedHarness.service.install({
    candidateId: 'scripts-allowed',
    name: 'new-plugin',
    source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
    buildPermissions: { 'new-plugin': true },
  })
  assert.equal(report.scripts.blocked.length, 0)
  assert.equal(report.scripts.allowed.length, 2)
  assert.equal(allowedHarness.calls.invoke.length, 1)
  assert.equal(allowedHarness.calls.invoke[0].argv.includes('--allow-build=new-plugin'), true)
})

test('explicit audited transitive build permissions are forwarded without enabling unrelated scripts', async t => {
  const harness = await makeHarness()
  t.after(harness.close)

  await harness.service.installMany({
    sources: [
      { name: 'new-plugin', source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' } },
    ],
    buildPermissions: { protobufjs: true, unrelated: false },
  })

  const argv = harness.calls.invoke[0].argv
  assert.equal(argv.includes('--config.strict-dep-builds=false'), true)
  assert.equal(argv.includes('--allow-build=protobufjs'), true)
  assert.equal(argv.includes('--allow-build=unrelated'), false)
})

test('publish-only scripts do not require install-time permission', async t => {
  const harness = await makeHarness({
    inventoryScripts: async () => ({
      packages: [{
        package: 'new-plugin',
        scripts: {
          prepublish: 'npm run check',
          prepack: 'npm run build',
          publish: 'npm publish',
        },
      }],
    }),
  })
  t.after(harness.close)

  const report = await harness.service.install({
    candidateId: 'publish-scripts-ignored',
    name: 'new-plugin',
    source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
  })

  assert.deepEqual(report.scripts.entries, [])
  assert.deepEqual(report.scripts.blocked, [])
  assert.equal(harness.calls.invoke.length, 1)
})

test('invalid package identities in build-script inventory fail closed', async t => {
  const harness = await makeHarness({
    inventoryScripts: async () => ({ packages: [{ package: '../unknown', scripts: { prepare: 'npm run build' } }] }),
  })
  t.after(harness.close)

  await assert.rejects(
    harness.service.install({
      candidateId: 'scripts-invalid-owner',
      name: 'new-plugin',
      source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
      buildPermissions: { 'new-plugin': true },
    }),
    /invalid package name/i,
  )
  assert.equal(harness.calls.invoke.length, 0)
})

test('all candidate and packed-artifact paths are constrained to candidateRoot', async t => {
  const harness = await makeHarness()
  t.after(harness.close)

  await assert.rejects(
    harness.service.install({
      candidateId: '../outside',
      name: 'new-plugin',
      source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
    }),
    /candidate id/i,
  )
  await assert.rejects(
    harness.service.install({
      candidateId: 'outside-001',
      candidatePath: join(harness.root, '..', 'outside-001'),
      name: 'new-plugin',
      source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
    }),
    /candidateRoot/i,
  )

  const outsideArtifact = await makeHarness({
    packLocalSource: async () => ({
      package: 'local-plugin',
      version: '3.0.0',
      sha256: 'd'.repeat(64),
      artifactPath: join(tmpdir(), 'outside.tgz'),
      specifier: 'file:./outside.tgz',
    }),
  })
  t.after(outsideArtifact.close)
  await assert.rejects(
    outsideArtifact.service.promoteLocal({
      candidateId: 'pack-outside',
      name: 'local-plugin',
      source: { type: 'local-dev', path: outsideArtifact.localPlugin },
    }),
    /candidateRoot/i,
  )
  assert.equal(outsideArtifact.calls.invoke.length, 0)
})

test('clone adapters cannot substitute a different candidate identity', async t => {
  const harness = await makeHarness({
    cloneActiveProfile: async request => ({
      candidateId: 'different-candidate',
      candidatePath: request.candidatePath,
    }),
  })
  t.after(harness.close)

  await assert.rejects(
    harness.service.install({
      candidateId: 'expected-candidate',
      name: 'new-plugin',
      source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
    }),
    /different candidate id/i,
  )
  assert.equal(harness.calls.invoke.length, 0)
})

test('candidate gate failure never writes or changes the active profile', async t => {
  let gateCalled = false
  const harness = await makeHarness({ runCandidateGate: async () => { gateCalled = true; return { ok: false, failed: 'compatibility' } } })
  t.after(harness.close)
  const activeBefore = clone(harness.active)
  await assert.rejects(
    harness.service.install({
      candidateId: 'gate-fails',
      name: 'new-plugin',
      source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
    }),
    error => error instanceof CandidateGateError && error.receipt.ok === false,
  )
  assert.deepEqual(harness.active, activeBefore)
  assert.equal(harness.calls.write.length, 1)
  assert.equal(gateCalled, true)
})

test('abort propagates through resolver and stops before candidate write or gate', async t => {
  let resolverRequest
  const harness = await makeHarness({
    runPnpm: request => new Promise((resolve, reject) => {
      resolverRequest = request
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
    }),
  })
  t.after(harness.close)
  const controller = new AbortController()
  const pending = harness.service.install({
    candidateId: 'abort-001',
    name: 'new-plugin',
    source: { type: 'npm', package: 'new-plugin', versionOrTag: 'latest' },
    signal: controller.signal,
  })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('transaction canceled'))
  await assert.rejects(pending, /transaction canceled/)
  assert.equal(resolverRequest.signal, controller.signal)
  assert.equal(harness.calls.write.length, 0)
  assert.equal(harness.calls.gate.length, 0)
})

test('removePreview returns exact impact and confirmRemove is fail-closed on a wrong token', async t => {
  const harness = await makeHarness()
  t.after(harness.close)
  const preview = await harness.service.removePreview({
    name: 'existing',
    candidateId: 'removal-preview',
    profile: initialProfile(),
  })
  assert.equal(preview.type, 'removal-preview')
  assert.equal(preview.packages[0].specifier, '1.0.0')
  assert.deepEqual(preview.dependentPackages, ['other'])
  assert.deepEqual(preview.dependentBundles, ['other'])
  assert.equal(preview.snapshotPath.startsWith(harness.root), true)
  assert.equal(preview.recoveryPath.startsWith(harness.root), true)
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/)
  assert.equal(harness.calls.clone.length, 0)
  assert.equal(harness.calls.invoke.length, 0)
  assert.equal(harness.calls.write.length, 0)

  await assert.rejects(
    harness.service.confirmRemove({
      name: 'existing',
      previewDigest: preview.previewDigest,
      confirmationToken: 'remove:wrong',
    }),
    error => error instanceof RemovalConfirmationError,
  )
  assert.equal(harness.calls.clone.length, 0)
  assert.equal(harness.calls.invoke.length, 0)
  assert.equal(harness.calls.write.length, 0)

  const report = await harness.service.confirmRemove({
    name: 'existing',
    previewDigest: preview.previewDigest,
    confirmationToken: preview.confirmationToken,
  })
  assert.equal(report.removal.confirmed, true)
  assert.equal(report.candidateId, preview.candidateId)
  assert.equal(report.removal.snapshotPath, preview.snapshotPath)
  assert.equal(report.removal.recoveryPath, preview.recoveryPath)
  assert.deepEqual(harness.calls.invoke.at(-1).argv.slice(-1), ['existing'])
  assert.equal(harness.calls.invoke.at(-1).shell, false)
})

test('removal confirmation is bound to the preview candidate and exact dependency direction', async t => {
  const harness = await makeHarness()
  t.after(harness.close)
  harness.active.packageJson.dependencies.child = '3.0.0'
  harness.active.packageGraph.existing = ['unrelated-dependency']
  harness.active.packageGraph.child = ['existing']
  const preview = await harness.service.removePreview({ name: 'existing', candidateId: 'bound-preview' })

  assert.deepEqual(preview.dependentPackages, ['child', 'other'])
  assert.equal(preview.dependentPackages.includes('unrelated-dependency'), false)
  await assert.rejects(
    harness.service.confirmRemove({
      name: 'existing',
      previewDigest: preview.previewDigest,
      confirmationToken: preview.confirmationToken,
      candidateId: 'different-candidate',
    }),
    /preview candidate/i,
  )
  assert.equal(harness.calls.invoke.length, 0)
})

test('structured sources reject command text before DSH invocation', async t => {
  const harness = await makeHarness()
  t.after(harness.close)
  await assert.rejects(
    harness.service.install({
      candidateId: 'injection-001',
      name: 'safe-plugin',
      source: { type: 'npm', package: 'safe-plugin;echo pwned', versionOrTag: 'latest' },
    }),
    /shell metacharacters|npm package/i,
  )
  await assert.rejects(
    harness.service.transaction({ action: 'install', name: 'safe-plugin', source: 'npm install safe-plugin' }),
    /structured object|Source/i,
  )
  assert.equal(harness.calls.invoke.length, 0)
})
