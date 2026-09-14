import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { parseDocument, isSeq, isMap } from 'yaml'

const root = resolve(process.argv[2] ?? 'C:/Users/1/.dsh-desktop-runtime')
const active = JSON.parse(await readFile(join(root, 'release-state', 'active.json'), 'utf8'))
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(active.releaseId)) throw new Error('Invalid release id')
const candidate = join(root, 'candidates', active.releaseId)
const manifest = JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8'))
const entry = join(candidate, 'runtime', 'versions', manifest.dsh.version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const { stdout } = await promisify(execFile)(process.execPath, ['--expose-internals', entry, '--profile', manifest.profile.physicalName, '--dump-config'], {
  env: { ...process.env, DSH_HOME: candidate, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' },
  cwd: candidate, windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024,
})
const doc = parseDocument(stdout, { logLevel: 'silent' })
if (doc.errors.length) throw new Error('Cannot parse composed config')
const found = []
function walk(node) {
  if (isSeq(node)) return node.items.forEach(walk)
  if (!isMap(node)) return
  const name = node.get('name')
  if (typeof name === 'string' && /credentials-local|settings-file|persistence-jsonl|storage-json|attachment-local|session-query-sqlite/.test(name)) {
    const config = node.get('config', true)
    found.push({ id: node.get('id'), name, config: isMap(config) ? config.items.map(pair => ({ key: String(pair.key), tag: pair.value?.tag, value: ['root', 'path', 'dshHome'].includes(String(pair.key)) ? pair.value?.value : '[preserve]' })) : [] })
  }
  for (const pair of node.items) if (isSeq(pair.value) || isMap(pair.value)) walk(pair.value)
}
walk(doc.contents)
console.log(JSON.stringify({ release: active.releaseId, entries: found }))
