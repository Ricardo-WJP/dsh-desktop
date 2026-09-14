import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'

export const RELEASE_POINTER_SCHEMA_VERSION = 1
export const STAGED_PLUGIN_CANDIDATE_SCHEMA_VERSION = 1

const POINTER_FILES = Object.freeze({
  active: 'active.json',
  lastKnownGood: 'last-known-good.json',
  previous: 'previous.json',
  pending: 'pending.json',
  stagedPluginCandidate: 'plugin-candidate.json',
})
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const HEX_SHA256 = /^[a-f0-9]{64}$/i
const PENDING_OPERATIONS = Object.freeze(['switch', 'rollback'])
const PENDING_PHASES = Object.freeze(['prepared', 'snapshot-published', 'active-published', 'observing', 'restoring'])

export class ReleaseStateError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'ReleaseStateError'
  }
}

function fail(path, message) {
  throw new ReleaseStateError(`Invalid release pointer ${path}: ${message}`)
}

function pendingFail(path, message) {
  throw new ReleaseStateError(`Invalid pending transaction ${path}: ${message}`)
}

function plainObject(value, path, failure = fail) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) failure(path, 'expected an object')
  return value
}

function exactKeys(value, keys, path, failure = fail) {
  const expected = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) failure(`${path}.${key}`, 'unknown field')
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) failure(`${path}.${key}`, 'missing field')
  }
}

function canonicalTimestamp(value, path, failure = fail) {
  if (typeof value !== 'string' || value === '' || value.length > 64) failure(path, 'expected an ISO-8601 timestamp')
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) failure(path, 'expected a canonical ISO-8601 UTC timestamp')
  return value
}

export function validateReleasePointer(value) {
  const pointer = plainObject(value, 'root')
  exactKeys(pointer, ['schemaVersion', 'releaseId', 'manifestSha256', 'activatedAt'], 'root')
  if (pointer.schemaVersion !== RELEASE_POINTER_SCHEMA_VERSION) {
    fail('schemaVersion', `expected ${String(RELEASE_POINTER_SCHEMA_VERSION)}`)
  }
  if (typeof pointer.releaseId !== 'string' || !RELEASE_ID.test(pointer.releaseId)) {
    fail('releaseId', 'contains unsupported characters')
  }
  if (typeof pointer.manifestSha256 !== 'string' || !HEX_SHA256.test(pointer.manifestSha256)) {
    fail('manifestSha256', 'expected a 64-character SHA-256 hex digest')
  }
  return Object.freeze({
    schemaVersion: RELEASE_POINTER_SCHEMA_VERSION,
    releaseId: pointer.releaseId,
    manifestSha256: pointer.manifestSha256.toLowerCase(),
    activatedAt: canonicalTimestamp(pointer.activatedAt, 'activatedAt'),
  })
}

function serializeReleasePointer(value) {
  return `${JSON.stringify(validateReleasePointer(value), undefined, 2)}\n`
}

function pendingChoice(value, values, path, expected) {
  if (typeof value !== 'string' || !values.includes(value)) pendingFail(path, `expected ${expected}`)
  return value
}

function nullableSnapshotId(value, path) {
  if (value === null) return null
  if (typeof value !== 'string' || !RELEASE_ID.test(value)) {
    pendingFail(path, 'expected null or a safe snapshot identifier')
  }
  return value
}

function pendingPointer(value, path) {
  if (value === null) return null
  try {
    return validateReleasePointer(value)
  } catch (error) {
    pendingFail(path, error instanceof Error ? error.message : String(error))
  }
}

export function validatePendingTransaction(value) {
  const pending = plainObject(value, 'root', pendingFail)
  exactKeys(pending, [
    'operation',
    'phase',
    'previousActive',
    'targetActive',
    'snapshotId',
    'rescueSnapshotId',
    'startedAt',
    ...(Object.hasOwn(pending, 'dataPolicy') ? ['dataPolicy'] : []),
  ], 'root', pendingFail)

  return Object.freeze({
    operation: pendingChoice(pending.operation, PENDING_OPERATIONS, 'operation', 'switch or rollback'),
    phase: pendingChoice(pending.phase, PENDING_PHASES, 'phase', 'prepared, snapshot-published, active-published, observing, or restoring'),
    previousActive: pendingPointer(pending.previousActive, 'previousActive'),
    targetActive: pendingPointer(pending.targetActive, 'targetActive'),
    snapshotId: nullableSnapshotId(pending.snapshotId, 'snapshotId'),
    rescueSnapshotId: nullableSnapshotId(pending.rescueSnapshotId, 'rescueSnapshotId'),
    startedAt: canonicalTimestamp(pending.startedAt, 'startedAt', pendingFail),
    ...(Object.hasOwn(pending, 'dataPolicy')
      ? { dataPolicy: pendingChoice(pending.dataPolicy, ['preserve'], 'dataPolicy', 'preserve') }
      : {}),
  })
}

function serializePendingTransaction(value) {
  return `${JSON.stringify(validatePendingTransaction(value), undefined, 2)}\n`
}

export function validateStagedPluginCandidate(value) {
  const candidate = plainObject(value, 'root', pendingFail)
  exactKeys(candidate, [
    'schemaVersion',
    'candidateId',
    'parentReleaseId',
    'manifestSha256',
    'stagedAt',
  ], 'root', pendingFail)
  if (candidate.schemaVersion !== STAGED_PLUGIN_CANDIDATE_SCHEMA_VERSION) {
    pendingFail('schemaVersion', `expected ${String(STAGED_PLUGIN_CANDIDATE_SCHEMA_VERSION)}`)
  }
  for (const field of ['candidateId', 'parentReleaseId']) {
    if (typeof candidate[field] !== 'string' || !RELEASE_ID.test(candidate[field])) {
      pendingFail(field, 'contains unsupported characters')
    }
  }
  if (candidate.candidateId === candidate.parentReleaseId) {
    pendingFail('candidateId', 'must differ from parentReleaseId')
  }
  if (typeof candidate.manifestSha256 !== 'string' || !HEX_SHA256.test(candidate.manifestSha256)) {
    pendingFail('manifestSha256', 'expected a 64-character SHA-256 hex digest')
  }
  return Object.freeze({
    schemaVersion: STAGED_PLUGIN_CANDIDATE_SCHEMA_VERSION,
    candidateId: candidate.candidateId,
    parentReleaseId: candidate.parentReleaseId,
    manifestSha256: candidate.manifestSha256.toLowerCase(),
    stagedAt: canonicalTimestamp(candidate.stagedAt, 'stagedAt', pendingFail),
  })
}

function serializeStagedPluginCandidate(value) {
  return `${JSON.stringify(validateStagedPluginCandidate(value), undefined, 2)}\n`
}

function readJsonStateFile(path, label, validate) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new ReleaseStateError(`Unable to read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  try {
    return validate(parsed)
  } catch (error) {
    throw new ReleaseStateError(`Unable to read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

function readPointerFile(path) {
  return readJsonStateFile(path, 'release pointer', validateReleasePointer)
}

function readPendingFile(path) {
  return readJsonStateFile(path, 'pending transaction', validatePendingTransaction)
}

function readStagedPluginCandidateFile(path) {
  return readJsonStateFile(path, 'staged plugin candidate', validateStagedPluginCandidate)
}

function fsyncDirectory(path) {
  if (process.platform === 'win32') return
  let descriptor
  try {
    descriptor = openSync(path, 'r')
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function writeStateAtomic(path, serialized, readState, serialize, label) {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, serialized, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    fsyncDirectory(directory)
    const verified = readState(path)
    if (verified === undefined || serialize(verified) !== serialized) {
      throw new ReleaseStateError(`${label} read-back verification failed for ${path}`)
    }
    return verified
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* preserve the original failure */ }
    }
    try { rmSync(temporary, { force: true }) } catch { /* preserve the original failure */ }
    if (error instanceof ReleaseStateError) throw error
    throw new ReleaseStateError(`Unable to write ${label.toLowerCase()} ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

function writePointerAtomic(path, value) {
  const normalized = validateReleasePointer(value)
  return writeStateAtomic(path, serializeReleasePointer(normalized), readPointerFile, serializeReleasePointer, 'Release pointer')
}

function writePendingAtomic(path, value) {
  const normalized = validatePendingTransaction(value)
  return writeStateAtomic(path, serializePendingTransaction(normalized), readPendingFile, serializePendingTransaction, 'Pending transaction')
}

function writeStagedPluginCandidateAtomic(path, value) {
  const normalized = validateStagedPluginCandidate(value)
  return writeStateAtomic(
    path,
    serializeStagedPluginCandidate(normalized),
    readStagedPluginCandidateFile,
    serializeStagedPluginCandidate,
    'Staged plugin candidate',
  )
}

function clearStateFile(path, readState, label) {
  try {
    rmSync(path, { force: true })
    fsyncDirectory(dirname(path))
    if (readState(path) !== undefined) throw new ReleaseStateError(`${label} clear verification failed for ${path}`)
  } catch (error) {
    throw new ReleaseStateError(`Unable to clear ${label.toLowerCase()} ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

export class ReleaseStateStore {
  constructor(stateRoot) {
    if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot) || stateRoot.includes('\0')) {
      throw new ReleaseStateError('State root must be an absolute path')
    }
    this.stateRoot = stateRoot
  }

  path(kind) {
    const name = POINTER_FILES[kind]
    if (name === undefined) throw new ReleaseStateError(`Unknown release pointer kind: ${String(kind)}`)
    return join(this.stateRoot, name)
  }

  readActive() {
    return readPointerFile(this.path('active'))
  }

  readLastKnownGood() {
    return readPointerFile(this.path('lastKnownGood'))
  }

  readPrevious() { return readPointerFile(this.path('previous')) }

  writePrevious(pointer) { return writePointerAtomic(this.path('previous'), pointer) }

  writeActive(pointer) {
    return writePointerAtomic(this.path('active'), pointer)
  }

  writeLastKnownGood(pointer) {
    return writePointerAtomic(this.path('lastKnownGood'), pointer)
  }

  readPending() {
    return readPendingFile(this.path('pending'))
  }

  writePending(transaction) {
    return writePendingAtomic(this.path('pending'), transaction)
  }

  clearPending() {
    clearStateFile(this.path('pending'), readPendingFile, 'Pending transaction')
  }

  readStagedPluginCandidate() {
    return readStagedPluginCandidateFile(this.path('stagedPluginCandidate'))
  }

  writeStagedPluginCandidate(candidate) {
    return writeStagedPluginCandidateAtomic(this.path('stagedPluginCandidate'), candidate)
  }

  clearStagedPluginCandidate() {
    clearStateFile(this.path('stagedPluginCandidate'), readStagedPluginCandidateFile, 'Staged plugin candidate')
  }
}
