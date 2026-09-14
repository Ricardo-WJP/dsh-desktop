import type { DesktopResult, DesktopStatus } from './global'
import { userFacingDetail } from './localization'

const unavailable = <T>(feature: string): DesktopResult<T> => ({
  ok: false,
  error: `桌面 Host 未连接，暂时无法使用“${feature}”。`,
})

const fallbackStatus: DesktopStatus = {
  app: { version: '开发预览', ready: true },
  mode: {
    active: 'legacy',
    compatibility: 'bootstrap',
    switchAvailable: false,
    stable: { state: 'planned' },
    dev: { state: 'unavailable', watcher: '未连接' },
  },
  startup: { phase: 'preview', progress: 100, message: '前端预览模式，桌面 Host 尚未连接。' },
  runtime: null,
  workspace: { ready: false },
  update: { state: 'unavailable', currentVersion: null, latestVersion: null, updateAvailable: false, available: false, busy: false, checkAvailable: false, managedRestoreAvailable: false, restoreAvailable: false },
  desktopUpdate: {
    state: 'unavailable',
    currentVersion: null,
    available: false,
    releaseSourceConfigured: false,
    supported: false,
    externalReleaseAvailable: false,
    busy: false,
    checkAvailable: false,
    progress: 0,
    downloaded: false,
    targetVersion: null,
  },
  candidate: { state: 'unavailable', available: false, reason: '桌面 Host 尚未连接。' },
  plugins: { state: 'unavailable', available: false, busy: false, installed: null, recoveryAvailable: false, recoveryMode: false, recoveryRows: 0, recoveryReason: null },
  snapshots: { state: 'unavailable', available: false, reason: '桌面 Host 尚未连接。' },
  logs: { state: 'unavailable', path: null },
}

export function bridge() {
  return window.dshDesktop
}

export async function readStatus(): Promise<DesktopStatus> {
  const result = await window.dshDesktop?.status.get()
  if (result === undefined) return fallbackStatus
  if (!result.ok) throw new Error(result.error)
  return result.status
}

export function previewStatus(): DesktopStatus {
  return fallbackStatus
}

export function errorMessage(result: { ok: false; error: string } | undefined, fallback = '操作未能完成。') {
  return userFacingDetail(result?.error, fallback)
}

export const previewApi = {
  unavailable,
}
