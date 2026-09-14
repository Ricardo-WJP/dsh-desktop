import { dirname } from 'node:path'
import { canPluginSurfaceUse, pluginOwnerFor, PLUGIN_COMPATIBILITY } from '../plugin-compatibility.js'
import {
  readBoundedLogTail,
  diagnosticLogText,
  diagnosticStatusText,
  sanitizeDiagnosticValue,
} from '../diagnostics.js'
import { createIpcRegistrar } from './registration.js'
import {
  IPC_CHANNELS,
  assertIpcChannel,
  assertTrustedSender,
  isTrustedSender,
  unavailable,
  validateBuildScripts,
  validateCandidateChannel,
  validateCandidateId,
  validateEnabled,
  validateLocalPath,
  validateLogLimit,
  validateManagementRoute,
  validateMarketPluginInstallRequest,
  validateMarketPluginUpdateRequest,
  validateMode,
  validatePathIntent,
  validatePluginName,
  validatePluginRemoveConfirmation,
  validatePluginRemovePreview,
  validatePluginSpec,
  validatePluginTransactionRequest,
  validateSnapshotId,
  validateSourceUrl,
  validateTitlebarMenuRequest,
  validateTitlebarNavigation,
  validateWorkspaceContext,
  validateWorkspaceTheme,
} from './contracts.js'

const CANDIDATE_UNAVAILABLE_REASON = 'Paired candidate release operations land after Task 3.'
const SNAPSHOTS_UNAVAILABLE_REASON = 'Snapshot and recovery operations land after Task 3.'
const PLUGIN_DOCUMENTATION_URL = 'https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md#profiles'

function resolveAdapter(adapter, ...args) {
  return typeof adapter === 'function' ? adapter(...args) : adapter
}

function diagnosticError(error) {
  return diagnosticStatusText(error)
}

function projectDiagnostic(value) {
  return sanitizeDiagnosticValue(value)
}

function projectSnapshotList(value) {
  const snapshots = Array.isArray(value) ? value : value?.snapshots
  if (!Array.isArray(snapshots)) throw new TypeError('Snapshot listing did not return an array')
  return snapshots.map(snapshot => ({
    id: snapshot?.snapshotId ?? snapshot?.id,
    snapshotId: snapshot?.snapshotId ?? snapshot?.id,
    createdAt: snapshot?.createdAt,
    kind: snapshot?.kind,
    count: snapshot?.count,
    bytes: snapshot?.bytes,
  }))
}

function mapMaybePromise(value, map) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function'
    ? Promise.resolve(value).then(map)
    : map(value)
}

/**
 * Owns the desktop IPC boundary and the status projection sent to the
 * management renderer.
 *
 * The host deliberately knows contracts and capability ownership, but never
 * imports the concrete update/plugin/workspace owners. The main process wires
 * those owners through `effects`, and supplies read-only state through
 * `state`. Every window, origin, path and privileged operation is therefore an
 * injectable adapter, which keeps this module executable with a fake Electron
 * surface in tests.
 *
 * `windows`, `origins`, `paths`, `state`, `effects` and `adapters` members may
 * be values or callbacks. Callback forms are preferred for mutable main
 * process state so every invocation observes the current snapshot.
 */
export function createDesktopIpcHost({
  ipcMain,
  windows = {},
  origins = {},
  paths = {},
  state = {},
  effects = {},
  adapters = {},
  logger = {},
} = {}) {
  const getWindow = role => {
    const aliases = role === 'management'
      ? ['management', 'manager']
      : role === 'harness'
        ? ['harness', 'main', 'workspace']
        : ['pluginManager', 'plugin', 'legacyPluginManager']
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(windows, alias)) return resolveAdapter(windows[alias])
    }
    return undefined
  }

  const getOrigin = role => {
    const aliases = role === 'management'
      ? ['management', 'renderer', 'managementRenderer']
      : ['harness', 'workspace', 'main']
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(origins, alias)) return resolveAdapter(origins[alias])
    }
    return undefined
  }

  const getPath = role => {
    const aliases = role === 'management'
      ? ['managementRenderer', 'renderer', 'management']
      : role === 'workspaceFallback'
        ? ['workspaceFallback', 'fallback']
        : ['pluginManager', 'plugin', 'legacyPluginManager']
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(paths, alias)) return resolveAdapter(paths[alias])
    }
    return undefined
  }

  const readState = (key, fallback) => {
    const adapter = state?.[key]
    try {
      const value = resolveAdapter(adapter)
      return value === undefined ? fallback : value
    } catch {
      return fallback
    }
  }

  const callEffect = (name, ...args) => {
    const effect = effects?.[name]
    if (typeof effect !== 'function') throw new Error(`Desktop IPC effect is unavailable: ${name}`)
    return effect(...args)
  }

  const writeLog = (source, text) => {
    const writer = logger?.write ?? logger?.log
    if (typeof writer === 'function') writer(source, diagnosticLogText(text))
  }

  const runDetached = (action, label) => {
    const detached = effects?.runDetached
    if (typeof detached === 'function') {
      try {
        detached(action, label)
      } catch (error) {
        writeLog('stderr', `${label} failed: ${diagnosticError(error)}\n`)
      }
      return
    }
    try {
      Promise.resolve(action()).catch(error => writeLog('stderr', `${label} failed: ${diagnosticError(error)}\n`))
    } catch (error) {
      writeLog('stderr', `${label} failed: ${diagnosticError(error)}\n`)
    }
  }

  function invalidRequest(error) {
    return { ok: false, error: diagnosticError(error) }
  }

  function readLogTail(limit = 200) {
    const safeLimit = validateLogLimit(limit)
    const logs = readState('logs', {}) ?? {}
    const logPath = logs.path
    if (logPath === undefined) return { lines: [], path: null, truncated: false }
    try {
      return { ...readBoundedLogTail(logPath, { lineLimit: safeLimit }), path: diagnosticStatusText(logPath) }
    } catch (error) {
      return { lines: [diagnosticStatusText(`Unable to read logs: ${error instanceof Error ? error.message : String(error)}`)], path: diagnosticStatusText(logPath), truncated: false }
    }
  }

  function trustedManagement(event) {
    try {
      const rendererPath = getPath('management')
      const rendererOrigin = getOrigin('management')
      assertTrustedSender(event, getWindow('management'), {
        allowedPaths: rendererPath === undefined ? [] : [rendererPath],
        allowedOrigins: rendererOrigin === undefined ? [] : [rendererOrigin],
      })
      return true
    } catch {
      return false
    }
  }

  function trustedFallback(event) {
    try {
      const fallbackPaths = getPath('workspaceFallback')
      const allowedPaths = Array.isArray(fallbackPaths) ? fallbackPaths : fallbackPaths === undefined ? [] : [fallbackPaths]
      assertTrustedSender(event, getWindow('harness'), { allowedPaths })
      return true
    } catch {
      return false
    }
  }

  function trustedControl(event) {
    return trustedManagement(event) || trustedFallback(event)
  }

  function senderIsHarness(event) {
    const harnessOrigin = getOrigin('harness')
    return isTrustedSender(event, getWindow('harness'), {
      allowedOrigins: harnessOrigin === undefined ? [] : [harnessOrigin],
    })
  }

  function senderIsPluginManager(event) {
    const pluginPath = getPath('pluginManager')
    return isTrustedSender(event, getWindow('pluginManager'), {
      allowedPaths: pluginPath === undefined ? [] : [pluginPath],
    })
  }

  function senderOwnsPluginCapability(event, capability) {
    const owner = pluginOwnerFor(capability)
    return owner === PLUGIN_COMPATIBILITY.legacySurface
      && canPluginSurfaceUse(capability, owner)
      && senderIsPluginManager(event)
  }

  function senderOwnsPluginCatalog(event) {
    return trustedManagement(event) || senderOwnsPluginCapability(event, 'catalog')
  }

  function senderOwnsPluginTransaction(event) {
    // Both the React management surface and dshmarket may request a
    // transaction, but the main-process effect remains the only writer.
    return trustedManagement(event) || senderIsPluginManager(event)
  }

  function buildDesktopStatus() {
    const app = readState('app', {}) ?? {}
    const rawMode = readState('mode', 'legacy')
    const mode = typeof rawMode === 'string' ? { active: rawMode } : (rawMode ?? {})
    const activeMode = ['stable', 'dev'].includes(mode.active) ? mode.active : 'legacy'
    const startup = readState('startup', {}) ?? {}
    const runtime = readState('runtime', undefined)
    const workspace = readState('workspace', {}) ?? {}
    const update = readState('update', {}) ?? {}
    const desktopUpdate = readState('desktopUpdate', {}) ?? {}
    const plugins = readState('plugins', {}) ?? {}
    const snapshots = readState('snapshots', {}) ?? {}
    const logs = readState('logs', {}) ?? {}

    return sanitizeDiagnosticValue({
      app: {
        version: app.version ?? null,
        ready: app.ready ?? false,
      },
      mode: {
        active: activeMode,
        compatibility: activeMode === 'legacy' ? 'bootstrap' : 'managed',
        switchAvailable: false,
        stable: { state: mode.stable?.status?.state ?? mode.stable?.state ?? (activeMode === 'stable' ? mode.state ?? 'unknown' : 'unavailable') },
        dev: {
          state: mode.dev?.status?.state ?? mode.dev?.state ?? (activeMode === 'dev' ? mode.state ?? 'unknown' : 'unavailable'),
          watcher: mode.dev?.status?.client?.state ?? mode.dev?.watcher ?? 'unavailable',
        },
      },
      startup: {
        phase: startup.phase ?? 'idle',
        progress: startup.progress ?? 0,
        message: diagnosticStatusText(startup.message ?? ''),
        ...(startup.error === undefined ? {} : { error: diagnosticStatusText(startup.error) }),
      },
      runtime: runtime === undefined || runtime === null
        ? null
        : { version: runtime.version ?? null, source: runtime.source ?? null },
      workspace: {
        ready: workspace.ready ?? false,
        ...(workspace.origin === undefined ? {} : { origin: workspace.origin }),
      },
      update: {
        state: update.state ?? 'unavailable',
        currentVersion: update.currentVersion ?? null,
        available: update.available ?? false,
        latestVersion: update.latestVersion ?? null,
        updateAvailable: update.updateAvailable ?? false,
        busy: update.busy ?? false,
        checkAvailable: update.checkAvailable ?? false,
        managedRestoreAvailable: update.managedRestoreAvailable ?? false,
        restoreAvailable: update.restoreAvailable ?? false,
      },
      desktopUpdate: {
        state: desktopUpdate.state ?? 'unavailable',
        currentVersion: desktopUpdate.currentVersion ?? app.version ?? null,
        available: desktopUpdate.available ?? false,
        releaseSourceConfigured: desktopUpdate.releaseSourceConfigured ?? false,
        supported: desktopUpdate.supported ?? false,
        externalReleaseAvailable: desktopUpdate.externalReleaseAvailable ?? false,
        busy: desktopUpdate.busy ?? false,
        checkAvailable: desktopUpdate.checkAvailable ?? false,
        progress: desktopUpdate.progress ?? 0,
        downloaded: desktopUpdate.downloaded ?? false,
        targetVersion: desktopUpdate.targetVersion ?? null,
      },
      candidate: (() => {
        const candidate = readState('candidate', {}) ?? {}
        return {
          state: candidate.state ?? 'unavailable',
          available: candidate.available ?? false,
          busy: candidate.busy ?? false,
          prepareAvailable: candidate.prepareAvailable ?? false,
          switchAvailable: candidate.switchAvailable ?? false,
          channel: candidate.channel ?? null,
          id: candidate.id ?? null,
          version: candidate.version ?? null,
          physicalProfileName: candidate.physicalProfileName ?? null,
          previousReleaseId: candidate.previousReleaseId ?? null,
          codeRollbackAvailable: candidate.codeRollbackAvailable === true,
          reason: candidate.reason ?? (candidate.available === true ? null : CANDIDATE_UNAVAILABLE_REASON),
        }
      })(),
      plugins: {
        state: plugins.state ?? (plugins.available === true ? 'available' : 'unavailable'),
        available: plugins.available ?? false,
        busy: plugins.busy ?? false,
        installed: plugins.installed ?? null,
        catalogAvailable: plugins.catalogAvailable ?? plugins.available ?? false,
        transactionAvailable: plugins.transactionAvailable ?? false,
        transactionState: plugins.transactionState ?? 'unavailable',
        transactionReason: plugins.transactionReason ?? null,
        pendingCandidateId: plugins.pendingCandidateId ?? null,
        restartRequired: plugins.restartRequired ?? false,
        recoveryAvailable: plugins.recoveryAvailable ?? false,
        recoveryMode: plugins.recoveryMode ?? false,
        recoveryRows: plugins.recoveryRows ?? 0,
        recoveryReason: plugins.recoveryReason ?? null,
        compatibilityWarnings: Array.isArray(plugins.compatibilityWarnings) ? plugins.compatibilityWarnings : [],
      },
      snapshots: {
        state: snapshots.state ?? (snapshots.available === true ? 'available' : 'unavailable'),
        available: snapshots.available ?? false,
        busy: snapshots.busy ?? false,
        count: snapshots.count ?? null,
        totalBytes: snapshots.totalBytes ?? null,
        reason: snapshots.reason ?? (snapshots.available === true ? null : SNAPSHOTS_UNAVAILABLE_REASON),
      },
      data: (() => {
        const data = readState('data', {}) ?? {}
        return {
          state: ['independent', 'candidate'].includes(data.state) ? data.state : 'unavailable',
          home: typeof data.home === 'string' ? data.home : null,
        }
      })(),
      logs: {
        state: logs.path === undefined ? 'unavailable' : 'available',
        path: logs.path ?? null,
      },
    })
  }

  function notify() {
    const workspace = getWindow('harness')
    if (workspace?.isDestroyed?.() === false) workspace.webContents.send(assertIpcChannel(IPC_CHANNELS.updates.changed), projectDiagnostic(readState('updates', {}) ?? {}))
    const managementWindow = getWindow('management')
    if (managementWindow?.isDestroyed?.() === false) {
      managementWindow.webContents.send(assertIpcChannel(IPC_CHANNELS.status.changed), buildDesktopStatus())
    }
  }

  let registrar
  function register() {
    if (registrar !== undefined) return registrar
    registrar = createIpcRegistrar(ipcMain)

    registrar.handle(IPC_CHANNELS.status.get, event => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted status request' }
      return { ok: true, status: buildDesktopStatus() }
    })
    registrar.handle(IPC_CHANNELS.mode.get, event => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted mode request' }
      return { ok: true, mode: buildDesktopStatus().mode.active }
    })
    registrar.handle(IPC_CHANNELS.mode.set, (event, mode) => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted mode request' }
      try { validateMode(mode) } catch (error) { return invalidRequest(error) }
      return unavailable('Mode switching')
    })
    registrar.handle(IPC_CHANNELS.candidate.status, event => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted candidate request' }
      return { ok: true, candidate: buildDesktopStatus().candidate }
    })
    registrar.handle(IPC_CHANNELS.candidate.prepare, (event, channel) => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted candidate request' }
      try { validateCandidateChannel(channel) } catch (error) { return invalidRequest(error) }
      const candidate = buildDesktopStatus().candidate
      if (candidate.available !== true || candidate.prepareAvailable !== true || candidate.busy === true || typeof effects?.candidatePrepare !== 'function') {
        return unavailable('Candidate preparation')
      }
      runDetached(() => callEffect('candidatePrepare', channel), 'Candidate preparation')
      return { ok: true, accepted: true }
    })
    registrar.handle(IPC_CHANNELS.candidate.activate, (event, candidateId) => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted candidate request' }
      try { validateCandidateId(candidateId) } catch (error) { return invalidRequest(error) }
      const candidate = buildDesktopStatus().candidate
      const prepared = candidate.switchAvailable === true && candidate.id === candidateId
      const previous = candidate.codeRollbackAvailable === true && candidate.previousReleaseId === candidateId
      if (candidate.available !== true || (!prepared && !previous) || candidate.busy === true || typeof effects?.candidateActivate !== 'function') {
        return unavailable('Candidate activation')
      }
      runDetached(() => callEffect('candidateActivate', candidateId), 'Candidate activation')
      return { ok: true, accepted: true }
    })
    registrar.handle(IPC_CHANNELS.update.desktopCheck, event => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted desktop installer update request' }
      const update = readState('desktopUpdate', {}) ?? {}
      if (update.checkAvailable !== true || update.available === false) return unavailable('Desktop installer update checks')
      runDetached(() => callEffect('desktopUpdateCheck'), 'Desktop installer update check')
      return { ok: true, accepted: true }
    })
    registrar.handle(IPC_CHANNELS.update.check, event => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted update request' }
      const update = readState('update', {}) ?? {}
      if (update.checkAvailable !== true || update.available === false || readState('operationBusy', false)) return unavailable('DSH update checks')
      runDetached(() => callEffect('updateCheck'), 'DSH update check')
      return { ok: true, accepted: true }
    })
    registrar.handle(IPC_CHANNELS.update.probe, event => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted DSH version probe request' }
      const update = readState('update', {}) ?? {}
      if (update.checkAvailable !== true || update.available === false || readState('operationBusy', false)) return unavailable('DSH version detection')
      try {
        return mapMaybePromise(callEffect('updateProbe'), result => ({ ok: true, ...projectDiagnostic(result) }))
      } catch (error) {
        return invalidRequest(error)
      }
    })
    registrar.handle(IPC_CHANNELS.update.restore, event => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted update request' }
      const update = readState('update', {}) ?? {}
      if (update.restoreAvailable !== true || update.available === false || readState('operationBusy', false)) return unavailable('DSH runtime restore')
      runDetached(() => callEffect('updateRestore'), 'DSH runtime restore')
      return { ok: true, accepted: true }
    })
    registrar.handle(IPC_CHANNELS.snapshots.list, event => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted snapshot request' }
      const snapshots = buildDesktopStatus().snapshots
      if (snapshots.available !== true || typeof effects?.snapshotList !== 'function') return unavailable('Snapshot listing')
      try {
        return mapMaybePromise(callEffect('snapshotList'), value => ({ ok: true, snapshots: projectSnapshotList(value) }))
      } catch (error) {
        return invalidRequest(error)
      }
    })
    registrar.handle(IPC_CHANNELS.snapshots.create, event => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted snapshot request' }
      const snapshots = buildDesktopStatus().snapshots
      if (snapshots.available !== true || snapshots.busy === true || typeof effects?.snapshotCreate !== 'function') return unavailable('Snapshot creation')
      runDetached(() => callEffect('snapshotCreate'), 'Snapshot creation')
      return { ok: true, accepted: true }
    })
    registrar.handle(IPC_CHANNELS.snapshots.restore, (event, snapshotId) => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted snapshot request' }
      try { validateSnapshotId(snapshotId) } catch (error) { return invalidRequest(error) }
      const snapshots = buildDesktopStatus().snapshots
      if (snapshots.available !== true || snapshots.busy === true || typeof effects?.snapshotRestore !== 'function') return unavailable('Snapshot restore')
      runDetached(() => callEffect('snapshotRestore', snapshotId), 'Snapshot restore')
      return { ok: true, accepted: true }
    })
    registrar.handle(IPC_CHANNELS.logs.read, (event, limit = 200) => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted logs request' }
      try { return { ok: true, ...readLogTail(limit) } } catch (error) { return invalidRequest(error) }
    })
    registrar.handle(IPC_CHANNELS.logs.open, event => {
      if (!trustedControl(event)) return { ok: false, error: 'Untrusted logs request' }
      const logPath = (readState('logs', {}) ?? {}).path
      if (logPath === undefined) return unavailable('Log folder')
      runDetached(() => callEffect('openLogFolder', dirname(logPath)), 'Open log folder')
      return { ok: true, accepted: true }
    })
    registrar.handle(IPC_CHANNELS.workspace.open, event => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted workspace request' }
      if ((readState('workspace', {}) ?? {}).ready !== true) return unavailable('Workspace window')
      callEffect('openWorkspace')
      return { ok: true, accepted: true }
    })
    registrar.handle(IPC_CHANNELS.workspace.openSettings, event => {
      if (!senderIsHarness(event)) return { ok: false, error: 'Untrusted Harness settings request' }
      if (typeof effects?.openSettingsDocument !== 'function') return unavailable('Harness settings document')
      try {
        return mapMaybePromise(callEffect('openSettingsDocument'), projectDiagnostic)
      } catch (error) {
        return invalidRequest(error)
      }
    })
    registrar.handle(IPC_CHANNELS.workspace.openUpdate, async event => {
      if (!senderIsHarness(event)) return { ok: false, error: 'Untrusted workspace update request' }
      try {
        await callEffect('navigate', 'update')
        return { ok: true }
      } catch (error) {
        return invalidRequest(error)
      }
    })
    registrar.handle(IPC_CHANNELS.workspace.updateCheck, event => {
      if (!senderIsHarness(event)) return { ok: false, error: 'Untrusted workspace update check request' }
      if ((readState('workspace', {}) ?? {}).ready !== true) return unavailable('Workspace update checks')
      try {
        return mapMaybePromise(callEffect('updateProbe'), result => ({ ok: true, ...projectDiagnostic(result) }))
      } catch (error) {
        return invalidRequest(error)
      }
    })
    registrar.handle(IPC_CHANNELS.updates.get, event => {
      if (!senderIsHarness(event) && !trustedManagement(event)) return { ok: false, error: 'Untrusted update status request' }
      return { ok: true, ...projectDiagnostic(readState('updates', {}) ?? {}) }
    })
    registrar.handle(IPC_CHANNELS.updates.open, async (event, kind) => {
      if (!senderIsHarness(event) && !trustedManagement(event)) return { ok: false, error: 'Untrusted update link request' }
      if (!['dsh', 'desktop'].includes(kind)) return { ok: false, error: 'Invalid update kind' }
      try { await callEffect('updatesOpen', kind); return { ok: true } } catch (e) { return invalidRequest(e) }
    })
    registrar.handle(IPC_CHANNELS.updates.check, async event => {
      if (!senderIsHarness(event) && !trustedManagement(event)) return { ok: false, error: 'Untrusted update check request' }
      try { return { ok: true, ...projectDiagnostic(await callEffect('updatesCheck')) } } catch (e) { return invalidRequest(e) }
    })
    registrar.handle(IPC_CHANNELS.updates.execute, (event, request) => {
      if (!senderIsHarness(event) && !trustedManagement(event)) return { ok: false, error: 'Untrusted update execution request' }
      if (!request || typeof request !== 'object' || typeof request.dsh !== 'boolean' || typeof request.desktop !== 'boolean') return { ok: false, error: 'Invalid update selection' }
      if (typeof effects?.updatesExecute !== 'function') return unavailable('Selected updates')
      try {
        const operation = callEffect('updatesExecute', request)
        runDetached(() => operation, 'Selected updates')
        return { ok: true, accepted: true }
      } catch (e) { return invalidRequest(e) }
    })
    registrar.handle(IPC_CHANNELS.app.restart, event => {
      if (!trustedControl(event) && !senderIsHarness(event)) return { ok: false, error: 'Untrusted restart request' }
      if (readState('quitting', false) === true) return { ok: false, error: 'Desktop is quitting' }
      runDetached(() => callEffect('restart'), 'Harness restart')
      return { ok: true, accepted: true }
    })
    registrar.handle(IPC_CHANNELS.app.navigate, async (event, route) => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted navigation request' }
      try {
        await callEffect('navigate', validateManagementRoute(route))
        return { ok: true }
      } catch (error) {
        return invalidRequest(error)
      }
    })
    registrar.handle(IPC_CHANNELS.openPath, (event, path, intent = 'auto') => {
      if (!senderIsHarness(event)) return { ok: false, error: 'Untrusted path-open request' }
      try {
        if (!['auto', 'editor', 'default'].includes(intent)) return { ok: false, error: 'Invalid path-open intent' }
        path = validateLocalPath(path)
        intent = validatePathIntent(intent)
        return mapMaybePromise(callEffect('openPath', path, intent), projectDiagnostic)
      } catch (error) {
        return invalidRequest(error)
      }
    })
    registrar.on(IPC_CHANNELS.workspaceContext, (event, value) => {
      if (!senderIsHarness(event)) return
      try {
        const next = validateWorkspaceContext(value)
        const normalize = adapters.normalizeWorkspaceContext
        const normalized = typeof normalize === 'function' ? normalize(next) : next
        callEffect('workspaceContext', normalized)
      } catch (error) {
        writeLog('stderr', diagnosticLogText(`Rejected workspace context: ${error instanceof Error ? error.message : String(error)}\n`))
      }
    })
    registrar.on(IPC_CHANNELS.workspace.theme, (event, value) => {
      if (!senderIsHarness(event)) return
      try {
        callEffect('workspaceTheme', validateWorkspaceTheme(value))
      } catch (error) {
        writeLog('stderr', diagnosticLogText(`Rejected workspace theme: ${error instanceof Error ? error.message : String(error)}\n`))
      }
    })
    registrar.handle(IPC_CHANNELS.workspace.titlebarMenu, (event, value) => {
      if (!senderIsHarness(event)) return { ok: false, error: 'Untrusted title-bar menu request' }
      try {
        callEffect('titlebarMenu', validateTitlebarMenuRequest(value))
        return { ok: true }
      } catch (error) {
        return invalidRequest(error)
      }
    })
    registrar.handle(IPC_CHANNELS.workspace.titlebarNavigate, (event, value) => {
      if (!senderIsHarness(event)) return { ok: false, error: 'Untrusted title-bar navigation request' }
      try {
        return mapMaybePromise(callEffect('titlebarNavigate', validateTitlebarNavigation(value)), navigation => ({
          ok: true,
          navigation: projectDiagnostic(navigation),
        }))
      } catch (error) {
        return invalidRequest(error)
      }
    })
    registrar.handle(IPC_CHANNELS.plugins.openManager, event => {
      if (!trustedManagement(event)) return { ok: false, error: 'Untrusted plugin manager request' }
      callEffect('openPluginManager')
      return { ok: true, accepted: true }
    })
    registrar.handle(IPC_CHANNELS.plugins.list, event => {
      if (!senderOwnsPluginCapability(event, 'catalog') || (readState('plugins', {}) ?? {}).available !== true) {
        return { ok: false, error: 'Untrusted plugin request' }
      }
      try {
        const plugins = readState('plugins', {}) ?? {}
        return mapMaybePromise(callEffect('pluginList'), catalog => ({
          ok: true,
          catalog: projectDiagnostic(catalog),
          transactionAvailable: plugins.transactionAvailable === true,
          transactionState: plugins.transactionState ?? 'unavailable',
          transactionReason: plugins.transactionReason ?? null,
        }))
      } catch (error) { return invalidRequest(error) }
    })
    registrar.handle(IPC_CHANNELS.plugins.catalog, event => {
      if (!senderOwnsPluginCatalog(event) || (readState('plugins', {}) ?? {}).catalogAvailable !== true && (readState('plugins', {}) ?? {}).available !== true) {
        return { ok: false, error: 'Untrusted plugin catalog request' }
      }
      try {
        return mapMaybePromise(callEffect('pluginCatalog'), catalog => ({ ok: true, catalog: projectDiagnostic(catalog) }))
      } catch (error) { return invalidRequest(error) }
    })
    registrar.handle(IPC_CHANNELS.plugins.discover, async event => {
      if (!senderOwnsPluginCatalog(event)) return { ok: false, error: 'Untrusted plugin request' }
      try {
        const result = await callEffect('pluginDiscover')
        return { ok: true, ...projectDiagnostic(result) }
      } catch (error) { return invalidRequest(error) }
    })
    registrar.handle(IPC_CHANNELS.plugins.transaction, (event, request) => {
      if (!senderOwnsPluginTransaction(event)) return { ok: false, error: 'Untrusted plugin transaction request' }
      try {
        request = validatePluginTransactionRequest(request)
        const plugins = readState('plugins', {}) ?? {}
        if (plugins.transactionAvailable !== true || typeof effects?.pluginTransaction !== 'function') return unavailable('Candidate plugin transaction')
        return mapMaybePromise(callEffect('pluginTransaction', request), result => {
          if (result?.ok === false) return { ok: false, error: diagnosticStatusText(result.error) }
          return { ok: true, report: projectDiagnostic(result?.report ?? result) }
        })
      } catch (error) { return invalidRequest(error) }
    })
    registrar.handle(IPC_CHANNELS.plugins.marketUpdate, (event, request) => {
      // The managed Harness renderer may ask only for an update already
      // offered by dshmarket. It never receives the generic install/remove
      // transaction surface, and the main process remains the sole writer.
      if (!senderIsHarness(event)) return { ok: false, error: 'Untrusted market plugin update request' }
      try {
        request = validateMarketPluginUpdateRequest(request)
        const plugins = readState('plugins', {}) ?? {}
        if (plugins.transactionAvailable !== true || typeof effects?.pluginMarketUpdate !== 'function') return unavailable('Managed market plugin update')
        return mapMaybePromise(callEffect('pluginMarketUpdate', request), result => {
          if (result?.ok === false) return { ok: false, error: diagnosticStatusText(result.error) }
          return { ok: true, report: projectDiagnostic(result?.report ?? result) }
        })
      } catch (error) { return invalidRequest(error) }
    })
    registrar.handle(IPC_CHANNELS.plugins.marketInstall, (event, request) => {
      // A Harness page can request only a catalog-listed GitHub URL. The main
      // process resolves that URL back to a trusted catalog entry before any
      // candidate is created; arbitrary package specs never cross this seam.
      if (!senderIsHarness(event)) return { ok: false, error: 'Untrusted market plugin install request' }
      try {
        request = validateMarketPluginInstallRequest(request)
        const plugins = readState('plugins', {}) ?? {}
        if (plugins.transactionAvailable !== true || typeof effects?.pluginMarketInstall !== 'function') return unavailable('Managed market plugin install')
        return mapMaybePromise(callEffect('pluginMarketInstall', request), result => {
          if (result?.ok === false) return { ok: false, error: diagnosticStatusText(result.error) }
          return { ok: true, report: projectDiagnostic(result?.report ?? result) }
        })
      } catch (error) { return invalidRequest(error) }
    })
    registrar.handle(IPC_CHANNELS.plugins.activateMarketUpdate, event => {
      if (!senderIsHarness(event)) return { ok: false, error: 'Untrusted market plugin activation request' }
      const plugins = readState('plugins', {}) ?? {}
      if (typeof plugins.pendingCandidateId !== 'string' || plugins.restartRequired !== true || typeof effects?.pluginRestart !== 'function') {
        return unavailable('Managed market plugin activation')
      }
      runDetached(() => callEffect('pluginRestart'), 'Managed market plugin activation')
      return { ok: true, accepted: true, candidateId: plugins.pendingCandidateId }
    })
    registrar.handle(IPC_CHANNELS.plugins.removePreview, (event, request) => {
      if (!senderOwnsPluginTransaction(event)) return { ok: false, error: 'Untrusted plugin transaction request' }
      try {
        request = validatePluginRemovePreview(request)
        const plugins = readState('plugins', {}) ?? {}
        if (plugins.transactionAvailable !== true || typeof effects?.pluginRemovePreview !== 'function') return unavailable('Candidate plugin removal preview')
        return mapMaybePromise(callEffect('pluginRemovePreview', request), result => {
          if (result?.ok === false) return { ok: false, error: diagnosticStatusText(result.error) }
          return { ok: true, preview: projectDiagnostic(result?.preview ?? result) }
        })
      } catch (error) { return invalidRequest(error) }
    })
    registrar.handle(IPC_CHANNELS.plugins.confirmRemove, (event, request) => {
      if (!senderOwnsPluginTransaction(event)) return { ok: false, error: 'Untrusted plugin transaction request' }
      try {
        request = validatePluginRemoveConfirmation(request)
        const plugins = readState('plugins', {}) ?? {}
        if (plugins.transactionAvailable !== true || typeof effects?.pluginConfirmRemove !== 'function') return unavailable('Candidate plugin removal')
        return mapMaybePromise(callEffect('pluginConfirmRemove', request), result => {
          if (result?.ok === false) return { ok: false, error: diagnosticStatusText(result.error) }
          return { ok: true, report: projectDiagnostic(result?.report ?? result) }
        })
      } catch (error) { return invalidRequest(error) }
    })
    registrar.handle(IPC_CHANNELS.plugins.install, (event, spec, allowBuildScripts = false) => {
      if (!senderOwnsPluginCapability(event, 'mutation')) return { ok: false, error: 'Untrusted plugin request' }
      try {
        spec = validatePluginSpec(spec)
        allowBuildScripts = validateBuildScripts(allowBuildScripts)
        return unavailable('Legacy live-profile plugin mutation; use structured candidate transactions')
      } catch (error) { return invalidRequest(error) }
    })
    registrar.handle(IPC_CHANNELS.plugins.enabled, (event, name, enabled) => {
      if (!senderOwnsPluginCapability(event, 'mutation')) return { ok: false, error: 'Untrusted plugin request' }
      try {
        const normalizedName = validatePluginName(name)
        const normalizedEnabled = validateEnabled(enabled)
        return unavailable('Legacy live-profile plugin mutation; use structured candidate transactions')
      } catch (error) { return invalidRequest(error) }
    })
    registrar.handle(IPC_CHANNELS.plugins.update, (event, name) => {
      if (!senderOwnsPluginCapability(event, 'mutation')) return { ok: false, error: 'Untrusted plugin request' }
      try {
        name = validatePluginName(name)
        return unavailable('Legacy live-profile plugin mutation; use structured candidate transactions')
      } catch (error) { return invalidRequest(error) }
    })
    registrar.handle(IPC_CHANNELS.plugins.remove, (event, name) => {
      if (!senderOwnsPluginCapability(event, 'mutation')) return { ok: false, error: 'Untrusted plugin request' }
      try {
        name = validatePluginName(name)
        return unavailable('Legacy live-profile plugin mutation; use structured candidate transactions')
      } catch (error) { return invalidRequest(error) }
    })
    registrar.handle(IPC_CHANNELS.plugins.restart, event => {
      if (!senderOwnsPluginCapability(event, 'mutation')) return { ok: false, error: 'Untrusted plugin request' }
      runDetached(() => callEffect('pluginRestart'), 'Plugin-triggered Harness restart')
      return { ok: true, accepted: true }
    })
    registrar.handle(IPC_CHANNELS.plugins.safeStart, event => {
      if (!trustedControl(event)) return { ok: false, error: 'Untrusted plugin safe-mode request' }
      if (readState('quitting', false) === true) return { ok: false, error: 'Desktop is quitting' }
      const plugins = readState('plugins', {}) ?? {}
      if (plugins.recoveryAvailable !== true || plugins.busy === true || typeof effects?.pluginSafeStart !== 'function') {
        return unavailable('Plugin safe mode')
      }
      runDetached(() => callEffect('pluginSafeStart'), 'Plugin safe mode startup')
      return { ok: true, accepted: true }
    })
    registrar.handle(IPC_CHANNELS.plugins.safeExit, event => {
      if (!trustedControl(event)) return { ok: false, error: 'Untrusted plugin safe-mode request' }
      if (readState('quitting', false) === true) return { ok: false, error: 'Desktop is quitting' }
      const plugins = readState('plugins', {}) ?? {}
      if (plugins.recoveryMode !== true || plugins.busy === true || typeof effects?.pluginSafeExit !== 'function') {
        return unavailable('Plugin safe-mode exit')
      }
      runDetached(() => callEffect('pluginSafeExit'), 'Plugin safe-mode exit')
      return { ok: true, accepted: true }
    })
    registrar.handle(IPC_CHANNELS.plugins.docs, event => {
      if (!senderOwnsPluginCapability(event, 'catalog')) return { ok: false, error: 'Untrusted plugin request' }
      runDetached(() => callEffect('openPluginDocs', PLUGIN_DOCUMENTATION_URL), 'Open Harness documentation')
      return { ok: true, accepted: true }
    })
    registrar.handle(IPC_CHANNELS.plugins.source, (event, url) => {
      if (!senderOwnsPluginCapability(event, 'catalog')) return { ok: false, error: 'Untrusted plugin request' }
      try {
        const validated = validateSourceUrl(url)
        const normalize = adapters.normalizePluginSourceUrl
        const source = typeof normalize === 'function' ? normalize(validated) : validated
        runDetached(() => callEffect('openPluginSource', source), 'Open plugin source')
        return { ok: true, accepted: true }
      } catch (error) { return invalidRequest(error) }
    })
    registrar.assertComplete()
    return registrar
  }

  return Object.freeze({
    register,
    notify,
    notifyState: notify,
    buildDesktopStatus,
    readLogTail,
    invalidRequest,
    trustedManagement,
    trustedFallback,
    senderIsHarness,
    senderIsPluginManager,
    senderOwnsPluginCapability,
    registeredChannels: () => registrar?.registeredChannels() ?? [],
  })
}
