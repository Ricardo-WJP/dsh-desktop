import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { detectLegacyHosts } from './legacy-host.js'
import {
  assertAbsolutePath,
  assertDestinationPathSafe,
  assertGeneratedPathInside,
  assertNoReparsePoint,
  assertNoSourceDestinationOverlap,
  assertWebProfileInsideDshHome,
  MigrationSafetyError,
} from './path-safety.js'
import { createMigrationReport, inspectStatePresence, writeMigrationReport } from './report.js'
import { copyTree, manifestsEqual, snapshotTree } from './tree.js'

export const SIDE_BY_SIDE_PRODUCT_ID = 'io.github.dshdesktop.ricardo-stable'
export const SIDE_BY_SIDE_PRODUCT_NAME = 'DeepSeek Harness Desktop（Ricardo Stable）'
export const DERIVED_DSH_HOME_EXCLUSIONS = ['profiles/node_modules']

function validateMigrationId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new MigrationSafetyError('Migration id must be a safe identifier', 'MIGRATION_ID_INVALID')
  }
  return id
}

async function assertFreshOutputRoot(outputRoot) {
  try {
    const stats = await lstat(outputRoot)
    assertNoReparsePoint(outputRoot, stats)
    if (!stats.isDirectory()) throw new MigrationSafetyError('side-by-side root is not a directory', 'MIGRATION_DESTINATION_NOT_DIRECTORY')
    const entries = await readdir(outputRoot)
    if (entries.length > 0) throw new MigrationSafetyError('side-by-side root must be new or empty', 'MIGRATION_DESTINATION_NOT_EMPTY')
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
}

async function assertCandidateProfileNameAvailable(webProfile, profileName) {
  const candidate = join(dirname(webProfile), profileName)
  try {
    const stats = await lstat(candidate)
    assertNoReparsePoint(candidate, stats)
    throw new MigrationSafetyError(
      `Source already contains the candidate profile name ${profileName}; refusing to overwrite it`,
      'MIGRATION_PROFILE_NAME_COLLISION',
    )
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
}

async function createOutputRoot(outputRoot) {
  await mkdir(outputRoot, { recursive: true })
  const stats = await lstat(outputRoot)
  assertNoReparsePoint(outputRoot, stats)
  if (!stats.isDirectory()) throw new MigrationSafetyError('side-by-side root is not a directory', 'MIGRATION_DESTINATION_NOT_DIRECTORY')
}

async function writeMetadata(metadata, metadataPath) {
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
}

function buildLayout({ outputRoot, id }) {
  const profileName = `ricardo-stable-${id}`
  const dataId = profileName
  const dataDirectory = join(outputRoot, 'data', dataId)
  const candidateDshHome = join(dataDirectory, 'dsh-home')
  const physicalProfilePath = join(candidateDshHome, 'profiles', profileName)
  const metadataPath = join(outputRoot, 'side-by-side-metadata.json')
  const reportPath = join(outputRoot, 'migration-report.json')
  for (const [label, pathValue] of Object.entries({ dataDirectory, candidateDshHome, physicalProfilePath, metadataPath, reportPath })) {
    assertGeneratedPathInside(outputRoot, pathValue, label)
  }
  return {
    sideBySideRoot: outputRoot,
    productId: SIDE_BY_SIDE_PRODUCT_ID,
    applicationId: `${SIDE_BY_SIDE_PRODUCT_ID}.${id.toLowerCase()}`,
    productName: SIDE_BY_SIDE_PRODUCT_NAME,
    dataId,
    dataDirectory,
    dshHome: candidateDshHome,
    profileName,
    physicalProfilePath,
    metadataPath,
    reportPath,
  }
}

function metadataFor(layout, id) {
  return {
    schemaVersion: 1,
    productId: layout.productId,
    applicationId: layout.applicationId,
    productName: layout.productName,
    migrationId: id,
    dataId: layout.dataId,
    dataDirectory: layout.dataDirectory,
    dshHome: layout.dshHome,
    profileName: layout.profileName,
    physicalProfilePath: layout.physicalProfilePath,
    sourceProfileName: 'web',
    switched: false,
    ownershipTransferred: false,
    liveDshHomeModified: false,
  }
}

function sourcePaths({ dshHome, webProfile }) {
  return { dshHome, webProfile }
}

async function safeSourceAfter({ dshHome, webProfile, retryLimit }) {
  let sourceAfter
  let sourceWebAfter
  let sourceAfterError
  try {
    sourceAfter = await snapshotTree(dshHome, { retryLimit, excludedRelativePaths: DERIVED_DSH_HOME_EXCLUSIONS })
    sourceWebAfter = await snapshotTree(webProfile, { retryLimit })
  } catch (error) {
    sourceAfterError = error
  }
  return { sourceAfter, sourceWebAfter, sourceAfterError }
}

async function writeFailureReport({ layout, id, mode, source, sourceBefore, sourceAfter, sourceWebBefore, sourceWebAfter, legacyHost, statePresence, copiedDshHome, importedProfile, error }) {
  await createOutputRoot(layout.sideBySideRoot)
  const report = createMigrationReport({
    mode,
    status: 'failed',
    id,
    productId: layout.productId,
    dataId: layout.dataId,
    profileName: layout.profileName,
    source,
    destination: layout,
    sourceBefore,
    sourceAfter,
    sourceWebBefore,
    sourceWebAfter,
    copiedDshHome,
    importedProfile,
    legacyHost,
    statePresence,
    error,
  })
  await writeMigrationReport(report, layout.reportPath)
  return { report, reportPath: layout.reportPath }
}

export async function prepareSideBySideMigration({
  mode,
  dshHome,
  webProfile,
  outputRoot,
  id,
  retryLimit = 3,
  legacyHostProbe,
  legacyProcessEntries,
  legacyPortEntries,
  copyFileImpl,
} = {}) {
  if (mode !== 'dry-run' && mode !== 'execute') throw new MigrationSafetyError('mode must be explicitly dry-run or execute', 'MIGRATION_MODE_REQUIRED')
  const normalizedDshHome = assertAbsolutePath(dshHome, 'DSH_HOME')
  const normalizedWebProfile = assertAbsolutePath(webProfile, 'web profile')
  const normalizedOutputRoot = assertAbsolutePath(outputRoot, 'side-by-side root')
  const migrationId = validateMigrationId(id)

  await assertDestinationPathSafe(normalizedOutputRoot)
  await assertFreshOutputRoot(normalizedOutputRoot)
  await assertNoSourceDestinationOverlap({ sourceRoot: normalizedDshHome, destinationRoot: normalizedOutputRoot })
  await assertWebProfileInsideDshHome({ dshHome: normalizedDshHome, webProfile: normalizedWebProfile })

  const layout = buildLayout({ outputRoot: normalizedOutputRoot, id: migrationId })
  const source = sourcePaths({ dshHome: normalizedDshHome, webProfile: normalizedWebProfile })
  await assertCandidateProfileNameAvailable(normalizedWebProfile, layout.profileName)
  const sourceBefore = await snapshotTree(normalizedDshHome, { retryLimit, excludedRelativePaths: DERIVED_DSH_HOME_EXCLUSIONS })
  const sourceWebBefore = await snapshotTree(normalizedWebProfile, { retryLimit })
  const legacyHost = await detectLegacyHosts({
    dshHome: normalizedDshHome,
    processEntries: legacyProcessEntries,
    portEntries: legacyPortEntries,
    probe: legacyHostProbe,
  })
  const statePresence = await inspectStatePresence(normalizedDshHome, sourceBefore)

  if (mode === 'dry-run') {
    const { sourceAfter, sourceWebAfter, sourceAfterError } = await safeSourceAfter({
      dshHome: normalizedDshHome,
      webProfile: normalizedWebProfile,
      retryLimit,
    })
    const sourceUnchanged = sourceAfterError === undefined && manifestsEqual(sourceBefore, sourceAfter) && manifestsEqual(sourceWebBefore, sourceWebAfter)
    await createOutputRoot(normalizedOutputRoot)
    const report = createMigrationReport({
      mode,
      status: sourceUnchanged ? 'planned' : 'failed',
      id: migrationId,
      productId: layout.productId,
      dataId: layout.dataId,
      profileName: layout.profileName,
      source,
      destination: layout,
      sourceBefore,
      sourceAfter,
      sourceWebBefore,
      sourceWebAfter,
      legacyHost,
      statePresence,
      ...(sourceAfterError ? { error: sourceAfterError } : {}),
    })
    await writeMigrationReport(report, layout.reportPath)
    return {
      status: report.status,
      mode,
      reportPath: layout.reportPath,
      report,
      metadata: metadataFor(layout, migrationId),
    }
  }

  let copiedDshHome
  let importedProfile
  let sourceAfter
  let sourceWebAfter
  try {
    await createOutputRoot(normalizedOutputRoot)
    await mkdir(layout.dshHome, { recursive: true })
    copiedDshHome = await copyTree(normalizedDshHome, layout.dshHome, {
      retryLimit,
      copyFileImpl,
      excludedRelativePaths: DERIVED_DSH_HOME_EXCLUSIONS,
    })
    importedProfile = await copyTree(normalizedWebProfile, layout.physicalProfilePath, { retryLimit, copyFileImpl })
    const after = await safeSourceAfter({ dshHome: normalizedDshHome, webProfile: normalizedWebProfile, retryLimit })
    sourceAfter = after.sourceAfter
    sourceWebAfter = after.sourceWebAfter
    if (after.sourceAfterError !== undefined) throw after.sourceAfterError
    if (!manifestsEqual(sourceBefore, sourceAfter) || !manifestsEqual(sourceWebBefore, sourceWebAfter)) {
      throw new MigrationSafetyError('Source DSH_HOME or web profile changed during migration; refusing to mark candidate ready', 'MIGRATION_SOURCE_CHANGED')
    }
    await writeMetadata(metadataFor(layout, migrationId), layout.metadataPath)
    const report = createMigrationReport({
      mode,
      status: 'ready',
      id: migrationId,
      productId: layout.productId,
      dataId: layout.dataId,
      profileName: layout.profileName,
      source,
      destination: layout,
      sourceBefore,
      sourceAfter,
      sourceWebBefore,
      sourceWebAfter,
      copiedDshHome,
      importedProfile,
      legacyHost,
      statePresence,
    })
    await writeMigrationReport(report, layout.reportPath)
    return {
      status: 'ready',
      mode,
      reportPath: layout.reportPath,
      metadata: metadataFor(layout, migrationId),
      report,
    }
  } catch (error) {
    const after = sourceAfter === undefined || sourceWebAfter === undefined
      ? await safeSourceAfter({ dshHome: normalizedDshHome, webProfile: normalizedWebProfile, retryLimit })
      : { sourceAfter, sourceWebAfter }
    const failed = await writeFailureReport({
      layout,
      id: migrationId,
      mode,
      source,
      sourceBefore,
      sourceAfter: after.sourceAfter,
      sourceWebBefore,
      sourceWebAfter: after.sourceWebAfter,
      legacyHost,
      statePresence,
      copiedDshHome,
      importedProfile,
      error,
    })
    return {
      status: 'failed',
      mode,
      reportPath: failed.reportPath,
      report: failed.report,
      metadata: metadataFor(layout, migrationId),
      error,
    }
  }
}
