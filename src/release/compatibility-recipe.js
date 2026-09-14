import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'

const SHA256 = /^[a-f0-9]{64}$/i

export class CompatibilityRecipeError extends Error {
  constructor(message, code = 'COMPATIBILITY_RECIPE_FAILED') {
    super(message)
    this.name = 'CompatibilityRecipeError'
    this.code = code
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Compatibility recipe aborted')
}

function countOccurrences(value, anchor) {
  if (typeof anchor !== 'string' || anchor === '') throw new CompatibilityRecipeError('Compatibility anchor must be a non-empty string')
  let count = 0
  let offset = 0
  while ((offset = value.indexOf(anchor, offset)) !== -1) {
    count += 1
    offset += anchor.length
  }
  return count
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new CompatibilityRecipeError(`${label} must be a SHA-256 digest`)
  return value.toLowerCase()
}

function assertDigests(value, label) {
  const values = Array.isArray(value) ? value : [value]
  if (values.length === 0) throw new CompatibilityRecipeError(`${label} must contain at least one SHA-256 digest`)
  const digests = values.map((digest, index) => assertDigest(digest, `${label}[${index}]`))
  if (new Set(digests).size !== digests.length) throw new CompatibilityRecipeError(`${label} must contain unique SHA-256 digests`)
  return digests
}

function safeRelativePath(value, label = 'Compatibility target path') {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || value.includes('\\') || value.includes(':')) {
    throw new CompatibilityRecipeError(`Invalid ${label}`)
  }
  const normalized = posix.normalize(value)
  if (isAbsolute(value) || normalized !== value || value === '.' || value === '..' || value.startsWith('../')) {
    throw new CompatibilityRecipeError(`Invalid ${label}`)
  }
  return value
}

function inside(root, target) {
  const remainder = relative(resolve(root), resolve(target))
  return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder))
}

function validateAssertions(assertions, label) {
  if (!Array.isArray(assertions)) throw new CompatibilityRecipeError(`${label} assertions must be an array`)
  return assertions.map((assertion, index) => {
    if (assertion === null || typeof assertion !== 'object' || Array.isArray(assertion)) throw new CompatibilityRecipeError(`${label} assertion ${index} is invalid`)
    if (typeof assertion.id !== 'string' || assertion.id === '') throw new CompatibilityRecipeError(`${label} assertion ${index} has no id`)
    if (!Number.isSafeInteger(assertion.count ?? 1) || (assertion.count ?? 1) < 1) throw new CompatibilityRecipeError(`${label} assertion ${assertion.id} has an invalid count`)
    if (typeof assertion.anchor !== 'string' || assertion.anchor === '') throw new CompatibilityRecipeError(`${label} assertion ${assertion.id} has no anchor`)
    return { id: assertion.id, anchor: assertion.anchor, count: assertion.count ?? 1 }
  })
}

function validateTarget(target, index) {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) throw new CompatibilityRecipeError(`Compatibility target ${index} is invalid`)
  if (typeof target.id !== 'string' || target.id === '') throw new CompatibilityRecipeError(`Compatibility target ${index} has no id`)
  const operations = target.operations
  if (!Array.isArray(operations)) throw new CompatibilityRecipeError(`Compatibility target ${target.id} operations must be an array`)
  const sourceSha256s = assertDigests(target.sourceSha256, `${target.id} sourceSha256`)
  return {
    id: target.id,
    package: target.package,
    path: safeRelativePath(target.path),
    sourceSha256: sourceSha256s[0],
    sourceSha256s,
    appliedSha256: assertDigest(target.appliedSha256, `${target.id} appliedSha256`),
    operations: operations.map((operation, operationIndex) => {
      if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) throw new CompatibilityRecipeError(`${target.id} operation ${operationIndex} is invalid`)
      const finds = Array.isArray(operation.find) ? operation.find : [operation.find]
      if (typeof operation.id !== 'string' || operation.id === '' || finds.length === 0 || finds.some(find => typeof find !== 'string' || find === '') || typeof operation.replace !== 'string') {
        throw new CompatibilityRecipeError(`${target.id} operation ${operationIndex} is incomplete`)
      }
      if (new Set(finds).size !== finds.length) throw new CompatibilityRecipeError(`${target.id} operation ${operation.id} has duplicate source anchors`)
      return { id: operation.id, find: finds[0], finds, replace: operation.replace }
    }),
    assertions: validateAssertions(target.assertions, target.id),
  }
}

function validateRecipe(recipe, expectedDshVersion) {
  if (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe)) throw new CompatibilityRecipeError('Compatibility recipe must be an object')
  if (recipe.schemaVersion !== 1 || typeof recipe.id !== 'string' || recipe.id === '') throw new CompatibilityRecipeError('Unsupported compatibility recipe')
  if (typeof recipe.dsh?.version !== 'string' || recipe.dsh.version !== expectedDshVersion) {
    throw new CompatibilityRecipeError(`Compatibility recipe does not target DSH ${String(expectedDshVersion)}`, 'COMPATIBILITY_VERSION_MISMATCH')
  }
  if (!Array.isArray(recipe.targets) || recipe.targets.length === 0) throw new CompatibilityRecipeError('Compatibility recipe has no targets')
  const targets = recipe.targets.map(validateTarget)
  if (new Set(targets.map(target => target.id)).size !== targets.length || new Set(targets.map(target => target.path)).size !== targets.length) {
    throw new CompatibilityRecipeError('Compatibility recipe target ids and paths must be unique')
  }
  return { id: recipe.id, version: recipe.dsh.version, targets }
}

function applyTargetText(source, target) {
  let output = source
  for (const operation of target.operations) {
    const finds = operation.finds ?? [operation.find]
    const matches = finds.map(find => ({ find, count: countOccurrences(output, find) })).filter(match => match.count > 0)
    const candidates = matches
      .filter(match => match.count === 1)
      .sort((left, right) => right.find.length - left.find.length)
    const selected = candidates[0]
    const allOtherMatchesAreContained = selected !== undefined && matches.every(match => (
      match.find === selected.find
      || (selected.find.includes(match.find) && match.count === countOccurrences(selected.find, match.find))
    ))
    if (selected === undefined || !allOtherMatchesAreContained) {
      const count = matches.reduce((sum, match) => sum + match.count, 0)
      throw new CompatibilityRecipeError(`${target.id}:${operation.id} expected one source anchor variant, found ${count}`, 'COMPATIBILITY_ANCHOR_MISMATCH')
    }
    output = output.replace(selected.find, operation.replace)
  }
  for (const assertion of target.assertions) {
    const count = countOccurrences(output, assertion.anchor)
    if (count !== assertion.count) {
      throw new CompatibilityRecipeError(`${target.id}:${assertion.id} expected ${assertion.count} applied anchors, found ${count}`, 'COMPATIBILITY_ASSERTION_FAILED')
    }
  }
  return output
}

async function physicalFile(root, relativePath, label) {
  const target = resolve(root, ...relativePath.split('/'))
  if (!inside(root, target) || target === resolve(root)) throw new CompatibilityRecipeError(`${label} escapes its root`)
  const canonical = await realpath(target)
  if (canonical !== target || !inside(root, canonical)) throw new CompatibilityRecipeError(`${label} is a symlink or escapes its root`)
  if (!(await stat(canonical)).isFile()) throw new CompatibilityRecipeError(`${label} is not a regular file`)
  return canonical
}

async function writeAtomic(path, value, mode) {
  const temporary = `${path}.compat-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx', mode })
    await rename(temporary, path)
  } catch (error) {
    try { await rm(temporary, { force: true }) } catch { /* preserve original failure */ }
    throw error
  }
}

export async function applyCompatibilityRecipe({ root, recipe, dshVersion, write = true, signal } = {}) {
  throwIfAborted(signal)
  if (typeof root !== 'string' || !isAbsolute(root)) throw new CompatibilityRecipeError('Compatibility root must be an absolute path')
  if (typeof write !== 'boolean') throw new CompatibilityRecipeError('Compatibility write flag must be boolean')
  const canonicalRoot = await realpath(root)
  if (!(await stat(canonicalRoot)).isDirectory()) throw new CompatibilityRecipeError('Compatibility root is not a directory')
  const validated = validateRecipe(recipe, dshVersion)
  const plans = []

  for (const target of validated.targets) {
    throwIfAborted(signal)
    const path = await physicalFile(canonicalRoot, target.path, target.id)
    const source = await readFile(path, 'utf8')
    const currentSha256 = sha256(source)
    let output
    let state
    if (currentSha256 === target.appliedSha256) {
      output = applyTargetText(source, { ...target, operations: [] })
      state = 'already-applied'
    } else {
      if (!target.sourceSha256s.includes(currentSha256)) {
        throw new CompatibilityRecipeError(`${target.id} source hash mismatch`, 'COMPATIBILITY_SOURCE_MISMATCH')
      }
      output = applyTargetText(source, target)
      if (sha256(output) !== target.appliedSha256) {
        throw new CompatibilityRecipeError(`${target.id} applied hash mismatch`, 'COMPATIBILITY_OUTPUT_MISMATCH')
      }
      state = target.operations.length === 0 ? 'verified' : 'patched'
    }
    plans.push({ target, path, output, state, mode: (await stat(path)).mode })
  }

  if (write) {
    for (const plan of plans) {
      throwIfAborted(signal)
      if (plan.state === 'patched') await writeAtomic(plan.path, plan.output, plan.mode)
    }
  }
  throwIfAborted(signal)
  return Object.freeze({
    schemaVersion: 1,
    recipeId: validated.id,
    dshVersion: validated.version,
    write,
    targets: plans.map(plan => Object.freeze({ id: plan.target.id, package: plan.target.package, path: plan.target.path, state: plan.state, sha256: sha256(plan.output) })),
  })
}

export async function verifyCompatibilityEvidence({ root, target } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new CompatibilityRecipeError('Evidence root must be an absolute path')
  const canonicalRoot = await realpath(root)
  const normalized = validateTarget({ id: target?.package ?? 'evidence', operations: [], ...target }, 0)
  const path = await physicalFile(canonicalRoot, normalized.path, normalized.id)
  const source = await readFile(path, 'utf8')
  const digest = sha256(source)
  if (!normalized.sourceSha256s.includes(digest) || digest !== normalized.appliedSha256) {
    throw new CompatibilityRecipeError(`${normalized.id} evidence hash mismatch`, 'COMPATIBILITY_SOURCE_MISMATCH')
  }
  applyTargetText(source, normalized)
  return Object.freeze({ package: normalized.package, path: normalized.path, sha256: digest, verified: true })
}
