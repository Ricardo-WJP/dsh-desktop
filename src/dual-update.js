import semver from 'semver'

const INTERVAL = 6 * 60 * 60 * 1000
const errorText = e => String(e?.message ?? e ?? '检查失败').slice(0, 500)
export function createDualUpdateManager({ getDesktop, getDshVersion, probeDsh, updateDsh, isPackaged,
  notify = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let dsh = { state: 'idle', targetVersion: null, hasUpdate: false, canUpdate: false, error: null, checkedAt: null }
  let checkPromise, execution, timer, stopped = false
  let runtimeCheckPromise, runtimeProbeAbort
  let startupRetries = 4
  let selection = null
  const snapshot = () => ({
    dsh: { ...dsh, currentVersion: getDshVersion(), progress: dsh.progress ?? null,
      releaseNotesUrl: dsh.targetVersion ? `https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v${encodeURIComponent(dsh.targetVersion)}` : 'https://github.com/deepseek-ai/deepseek-harness/releases',
      reason: !isPackaged() ? '开发环境不执行正式更新' : dsh.reason ?? null },
    desktop: getDesktop()?.snapshot?.() ?? { state: 'idle', currentVersion: null, targetVersion: null, hasUpdate: false, canUpdate: false, reason: '桌面更新器尚未就绪' },
    busy: Boolean(execution),
    selection,
  })
  function checkRuntime() {
    // Startup retries bypass the combined check. Share the runtime request
    // with manual checks as well, so the two paths cannot race or double-fetch.
    if (runtimeCheckPromise) return runtimeCheckPromise
    runtimeProbeAbort = new AbortController()
    const signal = AbortSignal.any([runtimeProbeAbort.signal, AbortSignal.timeout(15000)])
    runtimeCheckPromise = runRuntimeCheck(signal).finally(() => {
      runtimeCheckPromise = undefined
      runtimeProbeAbort = undefined
    })
    return runtimeCheckPromise
  }
  async function runRuntimeCheck(signal) {
    dsh = { ...dsh, state: 'checking', error: null, canUpdate: false }; notify()
    try {
      const r = await probeDsh({ signal })
      if (r?.busy) { dsh = { ...dsh, state: 'idle', reason: 'busy-startup', error: null }; notify(); return }
      if (r?.error || r?.busy || r?.aborted) throw new Error(r.error || (r.busy ? '另一项操作正在进行，请稍后重试' : 'DSH 检查超时或取消'))
      const current = semver.valid(getDshVersion()), target = semver.valid(r?.latestVersion)
      if (!current || !target) throw new Error('DSH 返回的版本数据无效')
      const hasUpdate = semver.gt(target, current)
      dsh = { state: hasUpdate ? 'available' : 'current', targetVersion: target, hasUpdate,
        canUpdate: hasUpdate && isPackaged(), error: null, checkedAt: new Date().toISOString(), channel: r.channel === 'next' ? 'next' : 'stable' }
    } catch (e) { dsh = { ...dsh, state: 'error', canUpdate: false, error: errorText(e) } }
    notify()
  }
  function check() {
    if (execution) return Promise.resolve(snapshot())
    if (checkPromise) return checkPromise
    checkPromise = Promise.allSettled([checkRuntime(), Promise.resolve().then(() => getDesktop()?.probe?.())])
      .then(() => snapshot()).finally(() => { checkPromise = undefined; notify() })
    return checkPromise
  }
  function execute(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || typeof request.dsh !== 'boolean' || typeof request.desktop !== 'boolean'
      || (!request.dsh && !request.desktop)) throw new Error('请选择更新项目')
    if (execution || checkPromise || runtimeCheckPromise) throw new Error('更新或检测正在进行')
    if (!isPackaged()) throw new Error('开发环境禁止运行正式安装')
    const initial = snapshot()
    for (const key of ['dsh', 'desktop']) if (request[key] && (!initial[key].canUpdate || request[`${key}Version`] !== initial[key].targetVersion)) throw new Error('可用版本已变化或暂不可更新，请重新检查')
    selection = { dsh: request.dsh, desktop: request.desktop }
    execution = Promise.resolve().then(async () => {
      const results = {}
      if (request.dsh) {
        dsh = { ...dsh, state: 'updating', canUpdate: false, error: null }; notify()
        try {
          await updateDsh({ version: request.dshVersion, channel: dsh.channel,
            onProgress: p => { dsh = { ...dsh, progress: typeof p?.progress === 'number' ? p.progress : null }; notify() } })
          dsh = { ...dsh, state: 'current', hasUpdate: false, canUpdate: false, progress: null }; results.dsh = { ok: true }
        } catch (e) { dsh = { ...dsh, state: 'error', canUpdate: true, error: errorText(e) }; results.dsh = { ok: false, error: dsh.error } }
        notify()
      }
      if (request.desktop) {
        try { const result = await getDesktop().execute({ expectedVersion: request.desktopVersion }); if (result?.state === 'error') throw new Error(result.error || result.reason || '桌面更新失败'); results.desktop = { ok: true } }
        catch (e) { results.desktop = { ok: false, error: errorText(e) } }
      }
      return results
    }).finally(() => { execution = undefined; notify() })
    notify(); return execution
  }
  function schedule(delay) {
    if (stopped || timer) return
    timer = setTimer(() => {
      timer = undefined
      const task = dsh.reason === 'busy-startup' && startupRetries > 0 ? checkRuntime() : check()
      void task.finally(() => {
        if (dsh.reason === 'busy-startup' && startupRetries-- > 0) schedule(15000)
        else { startupRetries = 4; schedule(INTERVAL) }
      })
    }, delay)
    timer?.unref?.()
  }
  return { snapshot, check, execute, start: () => { stopped = false; schedule(10000) },
    stop: () => {
      stopped = true
      if (timer) clearTimer(timer)
      timer = undefined
      // Only abort the read-only probe here. Candidate activation/rollback
      // continues to use the runtime controller's owned shutdown lifecycle.
      runtimeProbeAbort?.abort(new Error('DSH 检查已停止'))
    } }
}
