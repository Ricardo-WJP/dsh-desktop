import { createHash } from 'node:crypto'
import { access, chmod, mkdir, open, rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import semver from 'semver'
import {
  diagnosticDialogDetail,
  diagnosticErrorDetail,
  diagnosticLogText,
  diagnosticStatusText,
  DIAGNOSTIC_NATIVE_DIALOG_DETAIL_MAX_CHARS,
  sanitizeDiagnosticValue,
} from './diagnostics.js'

const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u

/**
 * Build a first-party desktop release source explicitly.
 *
 * The desktop product version comes from the packaged application. A release
 * feed is intentionally opt-in so a borrowed/reference repository can never
 * become the product's version authority by accident.
 */
export function createGitHubReleaseSource(repository) {
  const normalized = typeof repository === 'string' ? repository.trim() : ''
  if (!GITHUB_REPOSITORY_PATTERN.test(normalized)) throw new Error('Invalid first-party desktop release repository')
  return Object.freeze({
    type: 'github',
    repository: normalized,
    releasesUrl: `https://github.com/${normalized}/releases/latest`,
    apiUrl: `https://api.github.com/repos/${normalized}/releases/latest`,
  })
}

function resolveReleaseSource(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string') return createGitHubReleaseSource(value)
  if (typeof value !== 'object' || value.type !== 'github') throw new Error('Invalid first-party desktop release source')
  return createGitHubReleaseSource(value.repository)
}

function updateCopy(isChinese, platform) {
  const revealOnly = platform === 'linux'
  return isChinese ? {
      check: '检查更新…',
      checking: '正在检查更新…',
      downloading: progress => `正在下载安装包… ${String(progress)}%`,
      available: version => `可下载 v${version}`,
       downloaded: revealOnly ? '显示已下载的 AppImage…' : '打开已下载的安装包…',
       releases: '查看最新版本…',
       localOnly: '版本由本地构建号控制',
       availableTitle: '发现新版本',
      availableMessage: version => `DeepSeek Harness Desktop ${version} 已发布`,
      availableDetail: current => `当前版本为 ${current}。是否将安装包下载到系统“下载”目录？`,
      download: '下载安装包',
      later: '稍后',
      readyTitle: '安装包已下载',
      readyMessage: version => `DeepSeek Harness Desktop ${version} 已保存到本地`,
      readyDetail: path => revealOnly
        ? `文件位于 ${path}。请退出应用后，用它替换当前 AppImage 并重新打开。`
        : `文件位于 ${path}。请打开安装包，按系统提示完成更新。`,
      open: revealOnly ? '在文件夹中显示' : '打开安装包',
      noUpdateTitle: '已是最新版本',
      noUpdateMessage: version => `DeepSeek Harness Desktop ${version} 已是最新版本。`,
      failedTitle: '更新下载失败',
      failedMessage: '无法下载 DeepSeek Harness Desktop 安装包。',
    } : {
      check: 'Check for Updates…',
      checking: 'Checking for Updates…',
      downloading: progress => `Downloading Installer… ${String(progress)}%`,
      available: version => `Download v${version}`,
       downloaded: revealOnly ? 'Show Downloaded AppImage…' : 'Open Downloaded Installer…',
       releases: 'View Latest Release…',
       localOnly: 'Version controlled by local build',
       availableTitle: 'Update Available',
      availableMessage: version => `DeepSeek Harness Desktop ${version} is available`,
      availableDetail: current => `You are using ${current}. Download the installer to your system Downloads folder?`,
      download: 'Download Installer',
      later: 'Later',
      readyTitle: 'Installer Downloaded',
      readyMessage: version => `DeepSeek Harness Desktop ${version} has been saved locally`,
      readyDetail: path => revealOnly
        ? `The file is at ${path}. Quit the app, replace the current AppImage with this file, and launch it again.`
        : `The file is at ${path}. Open the installer and follow the system prompts to finish updating.`,
      open: revealOnly ? 'Show in Folder' : 'Open Installer',
      noUpdateTitle: 'You’re Up to Date',
      noUpdateMessage: version => `DeepSeek Harness Desktop ${version} is the latest version.`,
      failedTitle: 'Update Download Failed',
      failedMessage: 'The DeepSeek Harness Desktop installer could not be downloaded.',
    }
}

export function artifactName({ version, platform, arch, flavor = 'standard' }) {
  if (semver.valid(version) !== version) throw new Error('Invalid release version')
  if (!['standard', 'suite'].includes(flavor)) throw new Error('Unknown desktop distribution flavor')
  const prefix = flavor === 'suite' ? 'DSH-Desktop-Suite' : 'DSH-Desktop'
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) {
    return `${prefix}-v${version}-macos-${arch}.dmg`
  }
  if (platform === 'win32' && arch === 'x64') {
    return `${prefix}-v${version}-windows-${arch}-setup.exe`
  }
  if (platform === 'linux' && arch === 'x64') {
    return `${prefix}-v${version}-linux-${arch}.AppImage`
  }
  throw new Error(`No installer is published for ${platform}/${arch}`)
}

export function installerAssetName({ version, platform, arch, flavor = 'standard' }) {
  return artifactName({ version, platform, arch, flavor })
}

export function supportsInstallerDownloads({ isPackaged, platform, arch, flavor = 'standard' }) {
  if (!isPackaged) return false
  try {
    installerAssetName({ version: '0.0.0', platform, arch, flavor })
    return true
  } catch {
    return false
  }
}

function validatedAssetUrl(url, tagName, assetName, releaseSource) {
  const parsed = new URL(url)
  if (releaseSource?.type !== 'github') throw new Error('Release source is not trusted')
  const prefix = `/${releaseSource.repository}/releases/download/${tagName}/`
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || !parsed.pathname.startsWith(prefix)) {
    throw new Error('Release asset URL is not trusted')
  }
  if (decodeURIComponent(parsed.pathname.slice(prefix.length)) !== assetName) {
    throw new Error('Release asset URL does not match its file name')
  }
  return parsed.href
}

export function parseLatestRelease(release, { platform, arch, releaseSource, flavor = 'standard' }) {
  const source = resolveReleaseSource(releaseSource)
  if (source === undefined) throw new Error('No first-party desktop release source is configured')
  if (release === null || typeof release !== 'object' || typeof release.tag_name !== 'string') {
    throw new Error('GitHub returned an invalid Release')
  }
  if (release.draft === true || release.prerelease === true || !release.tag_name.startsWith('v')) {
    throw new Error('GitHub returned an unsupported Release')
  }
  const version = release.tag_name.slice(1)
  const name = installerAssetName({ version, platform, arch, flavor })
  const asset = Array.isArray(release.assets)
    ? release.assets.find(candidate => candidate?.name === name)
    : undefined
  if (asset === undefined || asset.state !== 'uploaded') throw new Error(`Release asset is missing: ${name}`)
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error('Release asset size is invalid')
  if (typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) {
    throw new Error('Release asset has no valid SHA-256 digest')
  }
  return {
    version,
    asset: {
      digest: asset.digest.toLowerCase(),
      name,
      size: asset.size,
       url: validatedAssetUrl(asset.browser_download_url, release.tag_name, name, source),
    },
  }
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function availableDownloadPath(directory, fileName) {
  if (basename(fileName) !== fileName) throw new Error('Invalid installer file name')
  const extension = extname(fileName)
  const stem = fileName.slice(0, fileName.length - extension.length)
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? '' : ` (${String(index)})`
    const candidate = join(directory, `${stem}${suffix}${extension}`)
    if (!(await pathExists(candidate))) return candidate
  }
  throw new Error('Could not choose a local installer file name')
}

async function writeChunk(handle, chunk) {
  const buffer = Buffer.from(chunk)
  let offset = 0
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset)
    if (result.bytesWritten <= 0) throw new Error('Could not write the installer file')
    offset += result.bytesWritten
  }
  return buffer
}

export async function downloadInstallerAsset({
  asset,
  downloadsDirectory,
  fetchImpl,
  platform,
  signal,
  onProgress = () => {},
  openImpl = open,
  removeImpl = rm,
}) {
  if (signal?.aborted) throw abortReason(signal)
  await mkdir(downloadsDirectory, { recursive: true })
  if (signal?.aborted) throw abortReason(signal)
  const destination = await availableDownloadPath(downloadsDirectory, asset.name)
  if (signal?.aborted) throw abortReason(signal)
  const response = await settleOnAbort(fetchImpl(asset.url, {
    headers: { Accept: 'application/octet-stream' },
    redirect: 'follow',
    signal,
  }), signal)
  if (!response.ok) throw new Error(`GitHub download failed with HTTP ${String(response.status)}`)
  if (response.body === null) throw new Error('GitHub download returned an empty response')

  if (signal?.aborted) throw abortReason(signal)
  const handle = await openImpl(destination, 'wx', 0o600)
  const hash = createHash('sha256')
  let received = 0
  let verified = false
  let failure
  let lastProgress = -1
  try {
    const iterator = response.body[Symbol.asyncIterator]()
    while (true) {
      const next = await settleOnAbort(iterator.next(), signal)
      if (next.done) break
      if (signal?.aborted) throw abortReason(signal)
      const buffer = await writeChunk(handle, next.value)
      hash.update(buffer)
      received += buffer.length
      if (received > asset.size) throw new Error('Downloaded installer is larger than the Release asset')
      const progress = Math.min(100, Math.floor((received / asset.size) * 100))
      if (progress !== lastProgress) {
        lastProgress = progress
        onProgress(progress)
      }
    }
    if (signal?.aborted) throw abortReason(signal)
    await handle.sync()
    if (signal?.aborted) throw abortReason(signal)
    if (received !== asset.size) throw new Error(`Installer size mismatch: expected ${String(asset.size)}, received ${String(received)}`)
    const actualDigest = `sha256:${hash.digest('hex')}`
    if (actualDigest !== asset.digest) throw new Error('Installer SHA-256 verification failed')
    if (platform === 'linux') await chmod(destination, 0o755)
    if (lastProgress !== 100) onProgress(100)
    verified = true
  } catch (error) {
    failure = error
  }

  const cleanupErrors = []
  try {
    await handle.close()
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (!verified || cleanupErrors.length > 0) {
    try {
      await removeImpl(destination, { force: true })
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (failure !== undefined) {
    if (cleanupErrors.length > 0) {
      failure.cleanupError = cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, 'Installer download cleanup failed')
    }
    throw failure
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0]
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Installer download cleanup failed')
  return destination
}

function errorDetail(error) {
  return diagnosticErrorDetail(error)
}

function dialogOptions(options) {
  const projected = sanitizeDiagnosticValue(options, { maxStringLength: DIAGNOSTIC_NATIVE_DIALOG_DETAIL_MAX_CHARS })
  if (projected !== null && typeof projected === 'object' && projected.detail !== undefined) {
    projected.detail = diagnosticDialogDetail(projected.detail)
  }
  return projected
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Desktop update aborted')
}

function linkAbortSignal(signal) {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(signal.reason)
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener?.('abort', forwardAbort, { once: true })
  return Object.freeze({
    controller,
    displaySignal: signal ?? controller.signal,
    signal: controller.signal,
    dispose: () => signal?.removeEventListener?.('abort', forwardAbort),
  })
}

function settleOnAbort(promise, signal) {
  if (signal === undefined) return Promise.resolve(promise)
  if (signal.aborted) return Promise.reject(abortReason(signal))
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([Promise.resolve(promise), aborted]).finally(() => {
    signal.removeEventListener('abort', onAbort)
  })
}

export function createInstallerUpdateController({
  isPackaged,
  platform,
  arch,
  isChinese,
  currentVersion,
  downloadsDirectory,
  releaseSource: configuredReleaseSource,
  releaseRepository,
  flavor,
  fetchImpl,
  dialog,
  getWindow,
  openReleasePage,
  openDownloadedFile,
  onStateChange = () => {},
  log = () => {},
  downloadImpl = downloadInstallerAsset,
}) {
  const copy = updateCopy(isChinese, platform)
  const releaseSource = resolveReleaseSource(configuredReleaseSource ?? releaseRepository)
  const installerSupported = supportsInstallerDownloads({ isPackaged, platform, arch, flavor })
  const sourceConfigured = releaseSource !== undefined
  const supported = sourceConfigured && installerSupported
  let state = !sourceConfigured ? 'local-only' : supported ? 'idle' : 'unsupported'
  let progress = 0
  let targetVersion
  let downloadedPath
  let operation
  let modernOperation
  let modernCancel
  let probeOperation
  let modernState = sourceConfigured ? 'idle' : 'error'
  let modernTargetVersion = null
  let modernAsset
  let modernRelease
  let modernError = null
  let modernReason = sourceConfigured ? null : 'release-source-not-configured'
  let modernProgress = 0
  let modernCheckedAt = null

  const normalizedCurrentVersion = semver.valid(currentVersion)

  function updateModern(nextState, details = {}) {
    modernState = nextState
    if (details.targetVersion !== undefined) modernTargetVersion = details.targetVersion
    if (Object.prototype.hasOwnProperty.call(details, 'asset')) modernAsset = details.asset
    if (details.release !== undefined) modernRelease = details.release
    if (details.error !== undefined) modernError = details.error
    if (details.reason !== undefined) modernReason = details.reason
    if (details.progress !== undefined) modernProgress = details.progress
    if (details.checkedAt !== undefined) modernCheckedAt = details.checkedAt
    onStateChange()
  }

  function modernSnapshot() {
    const hasUpdate = normalizedCurrentVersion !== null && modernTargetVersion !== null
      ? semver.gt(modernTargetVersion, normalizedCurrentVersion)
      : false
    return {
      state: modernState,
      currentVersion,
      targetVersion: modernTargetVersion,
      hasUpdate,
      canUpdate: modernState === 'available' && hasUpdate && isPackaged
        && (flavor === 'standard' || flavor === 'suite') && modernAsset !== undefined,
      progress: modernProgress,
      error: modernError,
      reason: modernReason,
      releaseNotesUrl: modernRelease?.releaseNotesUrl ?? null,
      checkedAt: modernCheckedAt,
    }
  }

  function timeoutSignal(externalSignal) {
    const controller = new AbortController()
    let timedOut = false
    const abort = () => controller.abort(abortReason(externalSignal))
    if (externalSignal?.aborted) abort()
    else externalSignal?.addEventListener?.('abort', abort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('Desktop update check timed out'))
    }, 15_000)
    return {
      signal: controller.signal,
      abort: reason => controller.abort(reason),
      get timedOut() { return timedOut },
      dispose: () => {
        clearTimeout(timer)
        externalSignal?.removeEventListener?.('abort', abort)
      },
    }
  }

  function setState(next, details = {}) {
    state = next
    if (details.progress !== undefined) progress = details.progress
    if (details.version !== undefined) targetVersion = details.version
    onStateChange()
  }

  function menuItem() {
    if (!sourceConfigured) return { label: copy.localOnly, enabled: false }
    if (!supported) return { label: copy.releases, enabled: true }
    if (state === 'checking') return { label: copy.checking, enabled: false }
    if (state === 'downloading') return { label: copy.downloading(progress), enabled: false }
    if (state === 'available') return { label: copy.available(diagnosticStatusText(targetVersion)), enabled: false }
    if (state === 'downloaded') return { label: copy.downloaded, enabled: operation === undefined }
    return { label: copy.check, enabled: operation === undefined }
  }

  function showMessage(options, displaySignal, cancellationSignal = displaySignal) {
    if (displaySignal?.aborted || cancellationSignal?.aborted) {
      return Promise.reject(abortReason(displaySignal ?? cancellationSignal))
    }
    const safeOptions = dialogOptions(options)
    const messageOptions = displaySignal === undefined ? safeOptions : { ...safeOptions, signal: displaySignal }
    const window = getWindow()
    let pending
    try {
      if (displaySignal?.aborted || cancellationSignal?.aborted) {
        return Promise.reject(abortReason(displaySignal ?? cancellationSignal))
      }
      pending = window?.isDestroyed?.() === false
        ? dialog.showMessageBox(window, messageOptions)
        : dialog.showMessageBox(messageOptions)
    } catch (error) {
      pending = Promise.reject(error)
    }
    return settleOnAbort(pending, cancellationSignal)
  }

  async function showFailure(error, notify, cancellationSignal, displaySignal = cancellationSignal) {
    const detail = errorDetail(error)
    log('error', diagnosticLogText(`Update download failed: ${detail}`))
    setState(downloadedPath === undefined ? 'idle' : 'downloaded', { progress: downloadedPath === undefined ? 0 : 100 })
    if (notify && !cancellationSignal?.aborted) {
      try {
        await showMessage({
          type: 'error',
          title: copy.failedTitle,
          message: copy.failedMessage,
          detail,
        }, displaySignal, cancellationSignal)
      } catch (failure) {
        if (!cancellationSignal?.aborted) throw failure
      }
    }
  }

  async function promptDownloaded(linked) {
    if (downloadedPath === undefined) return
    const result = await showMessage({
      type: 'info',
      title: copy.readyTitle,
      message: copy.readyMessage(targetVersion ?? currentVersion),
      detail: copy.readyDetail(downloadedPath),
      buttons: [copy.open, copy.later],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }, linked.displaySignal, linked.signal)
    if (linked.signal.aborted || result?.response !== 0) return
    if (linked.signal.aborted) return
    try {
      let pending
      try {
        pending = openDownloadedFile(downloadedPath)
      } catch (error) {
        pending = Promise.reject(error)
      }
      const error = await settleOnAbort(pending, linked.signal)
      if (linked.signal.aborted) return
      if (typeof error === 'string' && error !== '') throw new Error(error)
    } catch (error) {
      if (linked.signal.aborted) return
      await showFailure(error, true, linked.signal, linked.displaySignal)
    }
  }

  async function fetchLatestRelease(signal) {
    const response = await fetchImpl(releaseSource.apiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal,
    })
    if (!response.ok) throw new Error(`GitHub Release check failed with HTTP ${String(response.status)}`)
    return parseLatestRelease(await response.json(), { platform, arch, releaseSource })
  }

  async function fetchModernRelease(signal) {
    if (!sourceConfigured) throw new Error('No first-party desktop release source is configured')
    if (semver.valid(currentVersion) === null) throw new Error('Current desktop version is invalid')
    const response = await fetchImpl(releaseSource.apiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal,
    })
    if (!response.ok) throw new Error(`GitHub Release check failed with HTTP ${String(response.status)}`)
    const release = await response.json()
    if (release === null || typeof release !== 'object' || typeof release.tag_name !== 'string') {
      throw new Error('GitHub returned an invalid Release')
    }
    if (release.draft === true || release.prerelease === true || !/^v/u.test(release.tag_name)) {
      throw new Error('GitHub returned an unsupported Release')
    }
    const version = release.tag_name.slice(1)
    if (semver.valid(version) !== version || semver.prerelease(version) !== null) {
      throw new Error('GitHub returned an unsupported Release version')
    }
    const releaseInfo = {
      version,
      releaseNotesUrl: `https://github.com/${releaseSource.repository}/releases/tag/${encodeURIComponent(release.tag_name)}`,
    }
    let asset
    let assetError
    if (flavor === 'standard' || flavor === 'suite') {
      try {
        asset = parseLatestRelease(release, { platform, arch, releaseSource, flavor }).asset
      } catch (error) {
        assetError = error
      }
    }
    return { ...releaseInfo, release, asset, assetError }
  }

  async function probe({ signal } = {}) {
    if (probeOperation !== undefined) return probeOperation
    if (modernOperation !== undefined) return modernOperation
    const linked = timeoutSignal(signal)
    modernCancel = () => linked.abort(new Error('Desktop update cancelled'))
    probeOperation = (async () => {
      updateModern('checking', { error: null, reason: null, progress: 0 })
      try {
        const release = await settleOnAbort(fetchModernRelease(linked.signal), linked.signal)
        const isUpdate = semver.gt(release.version, normalizedCurrentVersion)
        const reason = !isUpdate
          ? null
          : !isPackaged
            ? 'dev-build-cannot-update'
            : flavor !== 'standard' && flavor !== 'suite'
              ? 'unknown-flavor-cannot-update'
              : release.asset === undefined
                ? release.assetError === undefined ? `valid-${flavor}-installer-unavailable` : 'installer-asset-invalid'
                : null
        modernTargetVersion = release.version
        modernRelease = {
          tagName: release.release.tag_name,
          releaseNotesUrl: release.releaseNotesUrl,
        }
        modernAsset = release.asset
        updateModern(isUpdate ? 'available' : 'current', {
          targetVersion: release.version,
          asset: release.asset,
          release: modernRelease,
          reason,
          error: isUpdate && release.assetError !== undefined ? errorDetail(release.assetError) : null,
          checkedAt: new Date().toISOString(),
          progress: 0,
        })
        return modernSnapshot()
      } catch (error) {
        if (linked.signal.aborted && !linked.timedOut) throw error
        updateModern('error', {
          error: errorDetail(error),
          reason: 'release-check-failed',
          checkedAt: new Date().toISOString(),
          progress: 0,
        })
        return modernSnapshot()
      } finally {
        linked.dispose()
        probeOperation = undefined
        modernOperation = undefined
        modernCancel = undefined
      }
    })()
    modernOperation = probeOperation
    return probeOperation
  }

  async function execute({ expectedVersion, signal } = {}) {
    if (modernOperation !== undefined) return modernOperation
    if (probeOperation !== undefined) return probeOperation
    const run = (async () => {
    if (operation !== undefined) return modernSnapshot()
      if (modernState !== 'available' || modernAsset === undefined || expectedVersion !== modernTargetVersion) {
        updateModern('error', { error: null, reason: 'probe-required-or-version-mismatch' })
        return modernSnapshot()
      }
      if (!isPackaged) {
        updateModern('error', { error: null, reason: 'dev-build-cannot-update' })
        return modernSnapshot()
      }
      const linked = linkAbortSignal(signal)
      modernCancel = () => linked.controller.abort(new Error('Desktop update cancelled'))
      try {
        updateModern('downloading', { progress: 0, error: null, reason: null })
        const downloaded = await settleOnAbort(downloadImpl({
          asset: modernAsset,
          downloadsDirectory,
          fetchImpl,
          platform,
          signal: linked.signal,
          onProgress: next => {
            if (!linked.signal.aborted) updateModern('downloading', { progress: next })
          },
        }), linked.signal)
        downloadedPath = downloaded
        updateModern('downloaded', { progress: 100 })
        updateModern('opening', { progress: 100 })
        let openResult
        try {
          openResult = await settleOnAbort(openDownloadedFile(downloaded), linked.signal)
        } catch (error) {
          throw error
        }
        if (typeof openResult === 'string' && openResult !== '') throw new Error(openResult)
        updateModern('downloaded', { progress: 100, error: null, reason: null })
        return modernSnapshot()
      } catch (error) {
        if (linked.signal.aborted) { updateModern('error', { error: '更新已取消', reason: 'cancelled' }); throw error }
        updateModern('error', { error: errorDetail(error), reason: 'download-or-open-failed', progress: downloadedPath === undefined ? 0 : 100 })
        return modernSnapshot()
      } finally {
        linked.dispose()
      }
    })()
    modernOperation = run.finally(() => { modernOperation = undefined; modernCancel = undefined })
    return modernOperation
  }

  function beginOperation(externalSignal) {
    const linked = linkAbortSignal(externalSignal)
    operation = linked
    return linked
  }

  function finishOperation(linked) {
    linked.dispose()
    if (operation === linked) operation = undefined
  }

  function resetAfterAbort() {
    setState(downloadedPath === undefined ? 'idle' : 'downloaded', {
      progress: downloadedPath === undefined ? 0 : 100,
    })
  }

  async function check(manual = false, { signal } = {}) {
    if (modernOperation !== undefined || probeOperation !== undefined) return
    if (!supported) {
      if (sourceConfigured && manual && !signal?.aborted && typeof openReleasePage === 'function') {
        await openReleasePage(releaseSource.releasesUrl)
      }
      return
    }
    if (operation !== undefined) return
    if (state === 'downloaded') {
      if (!manual) return
      const linked = beginOperation(signal)
      try {
        if (linked.signal.aborted) return
        await promptDownloaded(linked)
      } catch (error) {
        if (!linked.signal.aborted) await showFailure(error, true, linked.signal, linked.displaySignal)
      } finally {
        if (linked.signal.aborted) resetAfterAbort()
        finishOperation(linked)
      }
      return
    }
    if (state !== 'idle') return
    const linked = beginOperation(signal)
    setState('checking', { progress: 0 })
    let interactive = false
    try {
      if (linked.signal.aborted) return
      const release = await settleOnAbort(fetchLatestRelease(linked.signal), linked.signal)
      if (linked.signal.aborted) return
      if (!semver.gt(release.version, currentVersion)) {
        setState('idle', { progress: 0 })
        if (manual) {
          await showMessage({
            type: 'info',
            title: copy.noUpdateTitle,
            message: copy.noUpdateMessage(currentVersion),
          }, linked.displaySignal, linked.signal)
        }
        return
      }
      targetVersion = release.version
      setState('available', { version: release.version })
      const result = await showMessage({
        type: 'info',
        title: copy.availableTitle,
        message: copy.availableMessage(release.version),
        detail: copy.availableDetail(currentVersion),
        buttons: [copy.download, copy.later],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }, linked.displaySignal, linked.signal)
      if (linked.signal.aborted || result?.response !== 0) {
        setState('idle', { progress: 0 })
        return
      }
      interactive = true
      if (linked.signal.aborted) return
      setState('downloading', { progress: 0 })
      let downloaded
      try {
        downloaded = await settleOnAbort(downloadImpl({
          asset: release.asset,
          downloadsDirectory,
          fetchImpl,
          platform,
          signal: linked.signal,
          onProgress: next => {
            if (!linked.signal.aborted) setState('downloading', { progress: next })
          },
        }), linked.signal)
      } catch (error) {
        if (linked.signal.aborted) throw error
        throw error
      }
      if (linked.signal.aborted) return
      downloadedPath = downloaded
      setState('downloaded', { progress: 100 })
      await promptDownloaded(linked)
    } catch (error) {
      if (!linked.signal.aborted) await showFailure(error, manual || interactive, linked.signal, linked.displaySignal)
    } finally {
      if (linked.signal.aborted) resetAfterAbort()
      finishOperation(linked)
    }
  }

  function abort() {
    modernCancel?.()
    operation?.controller.abort()
  }

  return {
    abort,
    check,
    probe,
    execute,
    snapshot: modernSnapshot,
    initialize: () => supported,
    menuItem,
    get busy() { return operation !== undefined || ['checking', 'available', 'downloading'].includes(state) },
    get checkAvailable() { return sourceConfigured && operation === undefined && ['idle', 'unsupported', 'downloaded'].includes(state) },
    get downloadedPath() { return downloadedPath },
    get releaseSourceConfigured() { return sourceConfigured },
    get externalReleaseAvailable() { return sourceConfigured && !supported },
    get progress() { return progress },
    get state() { return state },
    get supported() { return supported },
    get targetVersion() { return targetVersion },
  }
}
