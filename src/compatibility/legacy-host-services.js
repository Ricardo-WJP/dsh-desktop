import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse, stringify } from 'yaml'

/** Supply missing lifecycle dependencies through Cordis, without editing plugins. */
export async function prepareLegacyHostServicePatch(candidateDir, profilePath) {
  const manifest = JSON.parse(await readFile(join(profilePath, 'package.json'), 'utf8'))
  if (!manifest.dsh?.profile?.bundles?.includes('dsh-prompt-polish')) return undefined
  const root = join(profilePath, 'node_modules', 'dsh-prompt-polish')
  let source, rows
  try {
    source = await readFile(join(root, 'lib', 'index.js'), 'utf8')
    rows = parse(await readFile(join(root, 'cordis.patch.yml'), 'utf8'))
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  // This old plugin captures get('llm') once before declaring any model
  // dependencies. Future implementations with their own binding are left alone.
  if (!/const llm = ctx\.get\(['"]llm['"]\)/.test(source)) return undefined
  const exported = /export const inject\s*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? ''
  if (/['"]llm['"]/.test(exported)) return undefined
  const entries = Array.isArray(rows) ? rows.flatMap(row => Array.isArray(row?.insert) ? row.insert : []) : []
  const entry = entries.find(row => row?.name === 'dsh-prompt-polish' && typeof row.id === 'string')
  if (!entry) return undefined
  const patch = [{ id: entry.id, inject: [...new Set([...(Array.isArray(entry.inject) ? entry.inject : []), 'timer', 'llm', 'agentDefaultModel'])] }]
  const directory = join(candidateDir, 'profiles', 'node_modules', '@dsh-desktop', 'integration')
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'legacy-host-services.patch.yml')
  const content = stringify(patch)
  try { if (await readFile(path, 'utf8') === content) return path } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
  return path
}
