import { execFile } from 'node:child_process'
import process from 'node:process'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function comparable(value) {
  return String(value ?? '')
    .replace(/^['"]|['"]$/g, '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

function safePid(value) {
  const pid = Number(value)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

function safePort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

function entryValue(entry, ...names) {
  if (!entry || typeof entry !== 'object') return undefined
  for (const name of names) {
    if (entry[name] !== undefined) return entry[name]
    const key = Object.keys(entry).find(candidate => candidate.toLowerCase() === name.toLowerCase())
    if (key !== undefined) return entry[key]
  }
  return undefined
}

function parseCommandLinePorts(commandLine) {
  const ports = new Set()
  const text = String(commandLine ?? '')
  const patterns = [
    /(?:--|\/)port(?:=|\s+)(?:"([0-9]+)"|([0-9]+))/gi,
    /(?:^|[\s;])PORT(?:=|\s+)(?:"([0-9]+)"|([0-9]+))/gi,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const port = safePort(match[1] ?? match[2])
      if (port !== undefined) ports.add(port)
    }
  }
  return [...ports].sort((a, b) => a - b)
}

function processMentionsHome(entry, dshHome) {
  const expected = comparable(dshHome)
  if (!expected) return false
  if (comparable(entryValue(entry, 'dshHome')) === expected) return true
  return comparable(entryValue(entry, 'commandLine')).includes(expected)
}

function processLooksLikeDshWebHost(entry) {
  const commandLine = comparable(entryValue(entry, 'commandLine'))
  const isDshBinary = commandLine.includes('/@deepseek-ai/dsh/') || commandLine.includes('/dsh/lib/bin.js')
  return isDshBinary && /(?:^|\s)web(?:\s|$)/i.test(commandLine)
}

function isDefaultDshHome(dshHome) {
  return comparable(dshHome) === comparable(join(homedir(), '.dsh'))
}

function normalizePortEntries(portEntries) {
  const byPid = new Map()
  for (const entry of portEntries ?? []) {
    const pid = safePid(entryValue(entry, 'owningProcess', 'pid'))
    const port = safePort(entryValue(entry, 'localPort', 'port'))
    if (pid === undefined || port === undefined) continue
    if (!byPid.has(pid)) byPid.set(pid, new Set())
    byPid.get(pid).add(port)
  }
  return byPid
}

function safeExecutableName(entry) {
  const value = entryValue(entry, 'name', 'executablePath')
  if (typeof value !== 'string' || value.length === 0) return 'unknown'
  return basename(value.replace(/[\\/]+/g, '/'))
}

export function normalizeLegacyHostEvidence({ dshHome, processEntries = [], portEntries = [] }) {
  const portsByPid = normalizePortEntries(portEntries)
  const hosts = []
  const seen = new Set()
  for (const entry of processEntries) {
    const pid = safePid(entryValue(entry, 'pid', 'processId'))
    const explicitHostFlag = entryValue(entry, 'isHost')
    const looksLikeDshWebHost = processLooksLikeDshWebHost(entry)
    const explicitlyReferencesHome = processMentionsHome(entry, dshHome)
    const usesImplicitDefaultHome = pid !== undefined
      && isDefaultDshHome(dshHome)
      && looksLikeDshWebHost
      && portsByPid.has(pid)
    const isHostCandidate = explicitHostFlag === true || looksLikeDshWebHost
    if (pid === undefined || seen.has(pid) || !isHostCandidate || (!explicitlyReferencesHome && !usesImplicitDefaultHome)) continue
    if (explicitHostFlag === false) continue
    seen.add(pid)
    const ports = new Set(portsByPid.get(pid) ?? [])
    for (const port of parseCommandLinePorts(entryValue(entry, 'commandLine'))) ports.add(port)
    hosts.push({
      pid,
      processName: safeExecutableName(entry),
      ports: [...ports].sort((a, b) => a - b),
      evidence: [
        explicitlyReferencesHome
          ? 'process command line or explicit DSH_HOME field references the source DSH_HOME'
          : 'DSH web Host uses the implicit default DSH_HOME and owns a listening port',
        ...(ports.size > 0 ? ['a listening port is associated with the process PID'] : []),
      ],
    })
  }
  hosts.sort((a, b) => a.pid - b.pid)
  return {
    probe: { available: true, method: 'read-only process and listening-port inspection' },
    takeOwnershipRequired: hosts.length > 0,
    hosts,
  }
}

async function probeWindowsHostState() {
  if (process.platform !== 'win32') {
    return { processes: [], ports: [], unavailable: 'legacy Host probing is only implemented for Windows' }
  }
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, Name, ExecutablePath, CommandLine)',
    '$ports = @()',
    'try { $ports = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Select-Object OwningProcess, LocalAddress, LocalPort) } catch { $ports = @() }',
    '[pscustomobject]@{ processes = $processes; ports = $ports } | ConvertTo-Json -Depth 5 -Compress',
  ].join('; ')
  const result = await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  const parsed = JSON.parse(result.stdout || '{}')
  return {
    processes: Array.isArray(parsed.processes) ? parsed.processes : parsed.processes ? [parsed.processes] : [],
    ports: Array.isArray(parsed.ports) ? parsed.ports : parsed.ports ? [parsed.ports] : [],
  }
}

export async function detectLegacyHosts({ dshHome, processEntries, portEntries, probe = probeWindowsHostState } = {}) {
  let processes = processEntries
  let ports = portEntries
  let probeError
  if (processes === undefined || ports === undefined) {
    try {
      const state = await probe()
      processes ??= state.processes
      ports ??= state.ports
      if (state.unavailable) probeError = state.unavailable
    } catch (error) {
      probeError = error instanceof Error ? error.message : String(error)
      processes ??= []
      ports ??= []
    }
  }
  const evidence = normalizeLegacyHostEvidence({ dshHome, processEntries: processes ?? [], portEntries: ports ?? [] })
  return {
    ...evidence,
    probe: {
      ...evidence.probe,
      ...(probeError ? { available: false, error: 'read-only legacy Host probe failed' } : {}),
    },
  }
}
