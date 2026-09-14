export function normalizeProgress(progress) {
  const value = Number(progress)
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

export function loadingStateScript(message, progress, stage = 'preparing') {
  const state = {
    message: String(message),
    progress: normalizeProgress(progress),
    stage: typeof stage === 'string' && stage.trim() !== '' ? stage.trim() : 'preparing',
  }
  return `window.setStartupState?.(${JSON.stringify(state)})`
}
