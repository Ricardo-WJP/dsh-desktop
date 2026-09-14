import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const matrixPath = path.join(repoRoot, 'compatibility', 'matrix.json')
const pluginsPath = path.join(repoRoot, 'compatibility', 'plugins.json')
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'))
const pluginConfig = JSON.parse(fs.readFileSync(pluginsPath, 'utf8'))

const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const GIT_COMMIT = /^[0-9a-f]{40}$/i
const SRI = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/
const NON_EMPTY = (value) => typeof value === 'string' && value.trim() !== ''

function evidencePath(value) {
  if (path.isAbsolute(value)) return value
  return path.join(repoRoot, value)
}

function readEvidence(item, rowName, field) {
  assert.equal(typeof item, 'object', `${rowName}.${field} evidence must be an object`)
  assert.ok(NON_EMPTY(item.kind), `${rowName}.${field} evidence.kind must be non-empty`)
  assert.ok(NON_EMPTY(item.path), `${rowName}.${field} evidence.path must be non-empty`)
  assert.notEqual(item.kind, 'module-import', `${rowName}.${field} cannot use module import as evidence`)
  const resolved = evidencePath(item.path)
  assert.ok(fs.existsSync(resolved), `${rowName}.${field} evidence file is missing: ${item.path}`)
  const text = fs.readFileSync(resolved, 'utf8')
  if (item.contains !== undefined) {
    assert.ok(NON_EMPTY(item.contains), `${rowName}.${field} evidence.contains must be non-empty`)
    assert.ok(text.includes(item.contains), `${rowName}.${field} evidence does not contain ${item.contains}: ${item.path}`)
  }
  if (item.absent !== undefined) {
    const parsed = JSON.parse(text)
    assert.equal(parsed?.dsh?.[item.absent], undefined, `${rowName}.${field} unexpectedly declares ${item.absent}`)
  }
}

function assertEvidence(value, rowName, field) {
  assert.ok(Array.isArray(value) && value.length > 0, `${rowName}.${field} must have static evidence`)
  for (const item of value) readEvidence(item, rowName, field)
}

function assertOptionalEvidence(value, rowName, field) {
  assert.ok(Array.isArray(value), `${rowName}.${field} evidence must be an array`)
  for (const item of value) readEvidence(item, rowName, field)
}

function rowByName(name) {
  const row = matrix.rows.find((item) => item.name === name)
  assert.ok(row, `missing matrix row ${name}`)
  return row
}

test('matrix has exactly the two base bundles plus compatibility.order in exact order', () => {
  assert.equal(matrix.schemaVersion, 1)
  assert.deepEqual(matrix.pluginOrder, pluginConfig.order)
  assert.deepEqual(matrix.order, [...BASE_BUNDLES, ...pluginConfig.order])
  assert.equal(matrix.rows.length, 21)
  assert.deepEqual(matrix.rows.map((row) => row.name), matrix.order)
  assert.equal(new Set(matrix.rows.map((row) => row.name)).size, 21)
  assert.equal(new Set(matrix.pluginOrder).size, 19)
})

test('every row records traceable source, loader, inject, assertions, action, effect, version note and owner', () => {
  for (const row of matrix.rows) {
    assert.ok(NON_EMPTY(row.name), 'row.name must be non-empty')
    assert.equal(row.evidenceCapturedAt, matrix.evidenceCapturedAt, `${row.name} must carry the matrix evidence timestamp`)
    assert.equal(Number.isNaN(Date.parse(row.evidenceCapturedAt)), false, `${row.name}.evidenceCapturedAt must be an ISO timestamp`)
    assert.ok(['base-bundle', 'plugin'].includes(row.kind), `${row.name}.kind is invalid`)
    assert.ok(['pending', 'blocked'].includes(row.status), `${row.name}.status must stay pending or blocked before Task 11`)

    const source = row.source
    assert.ok(source && typeof source === 'object', `${row.name}.source must be an object`)
    for (const field of ['kind', 'requested', 'resolved', 'version', 'commit', 'integrity', 'status']) {
      assert.ok(NON_EMPTY(source[field]), `${row.name}.source.${field} must be explicit; use unresolved instead of guessing`)
    }
    assert.ok(['npm', 'github', 'local'].includes(source.kind), `${row.name}.source.kind is invalid`)
    assert.ok(['passed', 'blocked'].includes(source.status), `${row.name}.source.status is invalid`)
    assertEvidence(source.evidence, row.name, 'source')
    assert.ok(Array.isArray(source.issues), `${row.name}.source.issues must be an array`)

    assert.ok(NON_EMPTY(row.loaderId), `${row.name}.loaderId must be explicit`)
    assert.ok(NON_EMPTY(row.clientLoaderId), `${row.name}.clientLoaderId must be explicit`)
    assert.ok(Array.isArray(row.clientInjectDependencies), `${row.name}.clientInjectDependencies must be an array`)
    assert.ok(row.hostActivationAssertion && typeof row.hostActivationAssertion === 'object', `${row.name}.hostActivationAssertion missing`)
    assert.ok(row.clientSlotAssertion && typeof row.clientSlotAssertion === 'object', `${row.name}.clientSlotAssertion missing`)
    for (const [field, assertion] of [['hostActivationAssertion', row.hostActivationAssertion], ['clientSlotAssertion', row.clientSlotAssertion]]) {
      assert.ok(['passed', 'pending', 'blocked'].includes(assertion.status), `${row.name}.${field}.status is invalid`)
      assert.ok(NON_EMPTY(assertion.assertion ?? assertion.slot ?? assertion.mode), `${row.name}.${field} needs an assertion`)
      if (assertion.status === 'passed') assertEvidence(assertion.evidence, row.name, field)
      else assertOptionalEvidence(assertion.evidence, row.name, field)
    }
    assert.ok(row.userAction?.status === 'pending', `${row.name}.userAction must remain pending until Task 11`)
    assert.ok(NON_EMPTY(row.userAction.action), `${row.name}.userAction.action must be non-empty`)
    assert.ok(NON_EMPTY(row.userAction.task), `${row.name}.userAction.task must be non-empty`)
    assert.ok(row.routeRpcStorageEffect && typeof row.routeRpcStorageEffect === 'object', `${row.name}.routeRpcStorageEffect missing`)
    for (const field of ['routes', 'rpc', 'storage']) assert.ok(Array.isArray(row.routeRpcStorageEffect[field]), `${row.name}.routeRpcStorageEffect.${field} must be an array`)
    assert.ok(NON_EMPTY(row.crossVersionNotes), `${row.name}.crossVersionNotes must be non-empty`)
    assert.ok(NON_EMPTY(row.patchOwner), `${row.name}.patchOwner must be non-empty`)
  }
})

test('passed claims are backed by static files and unresolved source claims cannot be silently promoted', () => {
  for (const row of matrix.rows) {
    if (row.source.status === 'passed') {
      if (row.source.kind === 'github') {
        assert.match(row.source.commit, GIT_COMMIT, `${row.name} Git source needs an exact commit`)
        assert.ok(row.source.resolved.includes(row.source.commit), `${row.name} resolved Git source must contain its commit`)
        assert.match(row.source.integrity, SRI, `${row.name} Git source needs exact SRI`)
      } else if (row.source.kind === 'npm') {
        assert.equal(row.source.commit, 'not-applicable', `${row.name} npm source commit must be not-applicable`)
        assert.match(row.source.integrity, SRI, `${row.name} npm source needs exact SRI`)
      }
    }
    if (row.source.status === 'blocked') {
      assert.ok(row.source.issues.length > 0, `${row.name} blocked source needs a reason`)
      assert.ok(row.source.integrity === 'unresolved' || row.source.requested.startsWith('github:'), `${row.name} blocked source must expose the unresolved/floating fact`)
    }
    if (row.hostActivationAssertion.status === 'passed') assertEvidence(row.hostActivationAssertion.evidence, row.name, 'hostActivationAssertion')
    if (row.clientSlotAssertion.status === 'passed') assertEvidence(row.clientSlotAssertion.evidence, row.name, 'clientSlotAssertion')
  }
})

test('matrix evidence is repository portable and never depends on a live user profile', () => {
  for (const item of matrix.sourceEvidence) {
    assert.equal(path.isAbsolute(item), false, `matrix.sourceEvidence must be relative: ${item}`)
  }
  for (const row of matrix.rows) {
    for (const [field, evidence] of [
      ['source', row.source.evidence],
      ['hostActivationAssertion', row.hostActivationAssertion.evidence],
      ['clientSlotAssertion', row.clientSlotAssertion.evidence],
    ]) {
      for (const item of evidence) {
        assert.equal(path.isAbsolute(item.path), false, `${row.name}.${field} must not depend on ${item.path}`)
      }
    }
  }
  assert.equal(JSON.stringify(matrix).includes('.dsh/profiles'), false)
  assert.equal(JSON.stringify(matrix).includes('C:/Users/'), false)
})

test('known compatibility facts are enforced as static gates', () => {
  const taskStatus = rowByName('@dsh-external/dsh-task-status')
  assert.equal(taskStatus.name, '@dsh-external/dsh-task-status')
  assert.equal(matrix.rows.some((row) => row.name === '@vlln/dsh-task-status'), false)
  assert.equal(JSON.stringify(matrix).includes('@vlln/dsh-task-status'), false)

  const modlens = rowByName('@liustack/modlens')
  assert.equal(modlens.source.kind, 'local')
  assert.equal(modlens.source.resolved, 'local:profiles/packages/modlens')
  assert.equal(modlens.source.version, '3.18.1-ricardo.1')
  assert.equal(modlens.clientSlotAssertion.slot, 'settings.plugin.item')
  assert.equal(modlens.clientSlotAssertion.key, 'modlens')
  assert.equal(modlens.clientSlotAssertion.status, 'passed')

  const expression = rowByName('dsh-expression')
  assert.match(expression.source.commit, GIT_COMMIT)
  assert.match(expression.source.integrity, SRI)
  assert.equal(expression.source.status, 'blocked')
  assert.ok(expression.source.issues.some((issue) => /floating Git/.test(issue)))

  const heatmap = rowByName('@linxin666/dsh-client-ui-activity-heatmap')
  assert.equal(heatmap.clientSlotAssertion.slot, 'settings.plugin.item')
  assert.equal(heatmap.clientSlotAssertion.key, 'activity-heatmap')
  assert.equal(heatmap.clientSlotAssertion.status, 'pending')

  const update = rowByName('dsh-update-button')
  assert.equal(update.clientSlotAssertion.slot, 'sidebar.footer.action')
  assert.equal(update.clientSlotAssertion.ipc, 'dshDesktop.openUpdate')
  assert.match(update.clientSlotAssertion.keyPolicy, /Official list slot/)
  assert.equal(update.userAction.status, 'pending')
})

test('release eligibility is blocked by unresolved sources and pending Task 11 actions', () => {
  assert.equal(matrix.pending.length, 21)
  assert.deepEqual(new Set(matrix.pending), new Set(matrix.order))
  assert.equal(matrix.unresolved.length, 5)
  assert.equal(matrix.staticGate.status, 'blocked')
  assert.equal(matrix.staticGate.unresolvedCount, 5)
  assert.equal(matrix.staticGate.pendingActionCount, 21)
  assert.equal(matrix.staticGate.releaseEligible, false)
  assert.equal(matrix.releaseEligible, false)
  assert.equal(matrix.evidencePolicy.moduleImportIsNotEvidence, true)
  assert.equal(matrix.evidencePolicy.task11GuiAndRealActionsRemainPending, true)
  assert.ok(matrix.blockingIssues.some((issue) => /GUI and real user actions/.test(issue)))
  assert.ok(matrix.blockingIssues.some((issue) => /floating Git/.test(issue)))
})
