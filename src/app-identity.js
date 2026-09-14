export const WINDOWS_APP_USER_MODEL_ID = 'io.github.dshdesktop.app'

export function configureWindowsAppIdentity(electronApp, platform = process.platform) {
  if (platform !== 'win32' || typeof electronApp?.setAppUserModelId !== 'function') return false
  electronApp.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)
  return true
}
