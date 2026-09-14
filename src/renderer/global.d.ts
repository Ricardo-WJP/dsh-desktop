export type DesktopResult<T> = { ok: true } & T | { ok: false; error: string }

export type ActiveMode = 'legacy' | 'stable' | 'dev'
export type SwitchableMode = Exclude<ActiveMode, 'legacy'>

export type DesktopMode = {
  active: ActiveMode
  compatibility: 'bootstrap' | 'managed'
  switchAvailable: boolean
  stable: { state: string }
  dev: { state: string; watcher: string }
}

export type DesktopInstallerUpdate = {
  state: string
  currentVersion: string | null
  available: boolean
  releaseSourceConfigured: boolean
  supported: boolean
  externalReleaseAvailable: boolean
  busy: boolean
  checkAvailable: boolean
  progress: number
  downloaded: boolean
  targetVersion: string | null
}

export type DesktopStatus = {
  data?: { state: 'independent' | 'candidate' | 'unavailable'; home: string | null }
  app: { version: string; ready: boolean }
  mode: DesktopMode
  startup: { phase: string; progress: number; message: string; error?: string }
  runtime: { version: string; source: string } | null
  workspace: { ready: boolean; origin?: string }
  // DSH runtime updater (npm install + bundled restore).
  update: { state: string; currentVersion: string | null; latestVersion: string | null; updateAvailable: boolean; available: boolean; busy: boolean; checkAvailable: boolean; managedRestoreAvailable: boolean; restoreAvailable: boolean }
  // Desktop installer updater (only enabled when our own release source is configured).
  desktopUpdate: DesktopInstallerUpdate
  candidate: {
    state: string
    available: boolean
    busy?: boolean
    prepareAvailable?: boolean
    switchAvailable?: boolean
    channel?: string | null
    id?: string | null
    version?: string | null
    physicalProfileName?: string | null
    previousReleaseId?: string | null
    codeRollbackAvailable?: boolean
    reason: string | null
  }
  plugins: {
    state: string
    available: boolean
    busy: boolean
    installed: number | null
    recoveryAvailable: boolean
    recoveryMode: boolean
    recoveryRows: number
    recoveryReason: string | null
    compatibilityWarnings?: Array<{ packageName: string; version: string | null; code: string; message: string }>
  }
  snapshots: { state: string; available: boolean; busy?: boolean; count?: number | null; totalBytes?: number | null; reason: string | null }
  logs: { state: string; path: string | null }
}

type LogResult = { lines: string[]; path: string | null; truncated: boolean }
type AcceptedOperation = { accepted: true }

export type WorkspaceBridge = {
  openPath: (path: string, intent?: 'auto' | 'editor' | 'default') => Promise<DesktopResult<unknown>>
  openUpdate: () => Promise<DesktopResult<unknown>>
  publishWorkspaceContext: (context: { active?: string; roots: string[] }) => void
}

export type SnapshotSummary = {
  id: string
  snapshotId: string
  createdAt: string
  kind: string
  count: number
  bytes: number
}

type DesktopBridge = {
  status: { get: () => Promise<DesktopResult<{ status: DesktopStatus }>>; subscribe: (listener: (status: DesktopStatus) => void) => () => void }
  mode: { get: () => Promise<DesktopResult<{ mode: ActiveMode }>>; set: (mode: SwitchableMode) => Promise<DesktopResult<AcceptedOperation>> }
  candidate: {
    status: () => Promise<DesktopResult<{ candidate: DesktopStatus['candidate'] }>>
    prepare: (channel: 'stable' | 'next') => Promise<DesktopResult<AcceptedOperation>>
    activate: (candidateId: string) => Promise<DesktopResult<AcceptedOperation>>
  }
  update: {
    // DSH runtime operations.
    probe: () => Promise<DesktopResult<{ currentVersion?: string | null; latestVersion?: string | null; available?: boolean; error?: string }>>
    check: () => Promise<DesktopResult<AcceptedOperation>>
    restore: () => Promise<DesktopResult<AcceptedOperation>>
    // Desktop installer operation; deliberately not shared with the DSH updater.
    desktopCheck: () => Promise<DesktopResult<AcceptedOperation>>
  }
  snapshots: {
    list: () => Promise<DesktopResult<{ snapshots: SnapshotSummary[] }>>
    create: () => Promise<DesktopResult<AcceptedOperation>>
    restore: (snapshotId: string) => Promise<DesktopResult<AcceptedOperation>>
  }
  recovery: {
    startPluginSafeMode: () => Promise<DesktopResult<AcceptedOperation>>
    exitPluginSafeMode: () => Promise<DesktopResult<AcceptedOperation>>
  }
  logs: { read: (limit?: number) => Promise<DesktopResult<LogResult>>; open: () => Promise<DesktopResult<AcceptedOperation>> }
  workspace: { open: () => Promise<DesktopResult<AcceptedOperation>> }
  app: { restart: () => Promise<DesktopResult<AcceptedOperation>>; navigate: (route: string) => Promise<DesktopResult<{ accepted?: boolean }>> }
}

declare global {
  interface Window { dshDesktop?: DesktopBridge }
}

export {}
