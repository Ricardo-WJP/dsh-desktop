import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export const MIGRATION_REPORT_SCHEMA_VERSION = 1

function manifestFiles(manifest) {
  return Array.isArray(manifest?.entries)
    ? manifest.entries.map(entry => ({
        relativePath: entry.relativePath,
        type: entry.type,
        size: entry.size,
        sha256: entry.sha256,
      }))
    : []
}

function manifestSummary(manifest) {
  if (manifest === undefined) return { available: false }
  return {
    available: true,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    rootSha256: manifest.rootSha256,
    excludedDerivedPaths: Array.isArray(manifest.excludedRelativePaths) ? manifest.excludedRelativePaths : [],
    files: manifestFiles(manifest),
  }
}

function pathSegments(relativePath) {
  return String(relativePath ?? '').split(/[\\/]+/).filter(Boolean).map(segment => segment.toLowerCase())
}

function hasPathSegment(entries, names) {
  const wanted = new Set(names)
  return entries.some(entry => pathSegments(entry.relativePath).some(segment => wanted.has(segment)))
}

function hasNamedFile(entries, names) {
  const wanted = new Set(names)
  return entries.some(entry => wanted.has(basename(entry.relativePath).toLowerCase()))
}

export async function inspectStatePresence(root, manifest) {
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : []
  const state = {
    sessions: {
      exists: hasPathSegment(entries, ['session', 'sessions']),
      evidence: 'presence only; session contents are not read into the report',
    },
    settings: {
      exists: hasNamedFile(entries, ['settings.json', 'settings.yaml', 'settings.yml', 'config.json', 'config.yaml', 'config.yml']),
      evidence: 'presence only; setting values are not read into the report',
    },
    workspaces: {
      exists: hasPathSegment(entries, ['workspace', 'workspaces']),
      evidence: 'presence only; workspace paths and contents are not read into the report',
    },
  }

  // Empty state directories are not represented by a file-only manifest. Probe
  // only their existence and never serialize their contents.
  for (const [key, candidates] of Object.entries({ sessions: ['sessions', 'session'], workspaces: ['workspaces', 'workspace'] })) {
    for (const candidate of candidates) {
      try {
        const stats = await lstat(join(root, candidate))
        if (stats.isDirectory()) state[key].exists = true
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
  return state
}

function safeHostEvidence(legacyHost) {
  const probe = legacyHost?.probe ?? {}
  return {
    probe: {
      available: probe.available === true,
      method: 'read-only process and listening-port inspection',
      ...(probe.available === false ? { error: 'read-only legacy Host probe failed' } : {}),
    },
    takeOwnershipRequired: legacyHost?.takeOwnershipRequired === true,
    hosts: Array.isArray(legacyHost?.hosts)
      ? legacyHost.hosts.map(host => ({
          pid: host.pid,
          processName: host.processName,
          ports: Array.isArray(host.ports) ? host.ports : [],
          evidence: Array.isArray(host.evidence) ? host.evidence : [],
        }))
      : [],
  }
}

function cutoverSteps({ dataId, profileName, candidateDshHome, physicalProfilePath }) {
  return [
    {
      order: 1,
      action: '由已识别的旧 Host 所属 supervisor 停止旧 Host，并以 PID/端口证据确认已退出',
      target: 'legacy Host using the source DSH_HOME',
      performed: false,
    },
    {
      order: 2,
      action: '创建并核对切换前完整快照，确认源 DSH_HOME 与 web profile 未改变',
      target: candidateDshHome,
      performed: false,
    },
    {
      order: 3,
      action: `将新客户端的数据目录切换到 ${dataId}，并将物理 profile 设为 ${profileName}`,
      target: physicalProfilePath,
      performed: false,
    },
    {
      order: 4,
      action: '启动新客户端，完成 120 秒健康观察、会话/设置/工作区核验和全部关键插件动作矩阵',
      target: 'new side-by-side client',
      performed: false,
    },
    {
      order: 5,
      action: '若任一核验失败，由受控 supervisor 恢复旧 release/data slot，并再次核验旧 GUI',
      target: 'legacy release and source DSH_HOME',
      performed: false,
    },
  ]
}

export function createMigrationReport({
  mode,
  status,
  id,
  productId,
  dataId,
  profileName,
  source,
  destination,
  sourceBefore,
  sourceAfter,
  sourceWebBefore,
  sourceWebAfter,
  copiedDshHome,
  importedProfile,
  legacyHost,
  statePresence,
  error,
  generatedAt = new Date().toISOString(),
}) {
  const unchanged = sourceBefore !== undefined && sourceAfter !== undefined && sourceBefore.rootSha256 === sourceAfter.rootSha256
  return {
    schemaVersion: MIGRATION_REPORT_SCHEMA_VERSION,
    generatedAt,
    mode,
    status,
    migration: {
      id,
      source: {
        dshHome: source?.dshHome,
        webProfile: source?.webProfile,
        webProfileName: 'web',
        before: manifestSummary(sourceBefore),
        after: manifestSummary(sourceAfter),
        unchanged,
        webProfileUnchanged: sourceWebBefore !== undefined && sourceWebAfter !== undefined
          ? sourceWebBefore.rootSha256 === sourceWebAfter.rootSha256
          : false,
      },
      destination: {
        sideBySideRoot: destination?.sideBySideRoot,
        productId,
        dataId,
        dataDirectory: destination?.dataDirectory,
        dshHome: destination?.dshHome,
        profileName,
        physicalProfilePath: destination?.physicalProfilePath,
        metadataPath: destination?.metadataPath,
        reportPath: destination?.reportPath,
      },
      copiedDshHome: manifestSummary(copiedDshHome),
      importedProfile: manifestSummary(importedProfile),
      legacyHost: safeHostEvidence(legacyHost),
      statePresence: statePresence ?? {
        sessions: { exists: false, evidence: 'not inspected' },
        settings: { exists: false, evidence: 'not inspected' },
        workspaces: { exists: false, evidence: 'not inspected' },
      },
      sourceUnchangedVerification: {
        unchanged,
        webProfileUnchanged: sourceWebBefore !== undefined && sourceWebAfter !== undefined
          ? sourceWebBefore.rootSha256 === sourceWebAfter.rootSha256
          : false,
        checkedAfterCopy: sourceAfter !== undefined,
      },
      cutover: {
        switched: false,
        ownershipTransferred: false,
        confirmationRequired: true,
        steps: cutoverSteps({
          dataId,
          profileName,
          candidateDshHome: destination?.dshHome,
          physicalProfilePath: destination?.physicalProfilePath,
        }),
        notPerformed: [
          '未停止任何 legacy Host 进程',
          '未改变旧 release、source DSH_HOME 或 source web profile',
          '未改变默认数据目录、默认 profile 名称或 live DSH 所有权',
          '未执行 live cutover、回滚或卸载',
        ],
      },
      ...(error ? {
        failure: {
          code: error.code ?? 'MIGRATION_FAILED',
          message: 'Migration failed; sensitive error details were omitted from this report',
        },
      } : {}),
    },
    redaction: {
      secretValuesIncluded: false,
      omitted: [
        'file contents',
        'session and settings values',
        'workspace contents and user-entered paths',
        'environment variables',
        'process command lines',
        'API keys, tokens, cookies, passwords and private keys',
      ],
    },
  }
}

export async function writeMigrationReport(report, reportPath) {
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  return reportPath
}
