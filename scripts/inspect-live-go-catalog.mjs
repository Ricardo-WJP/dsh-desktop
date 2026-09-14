import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import {
  OPEN_CODE_GO_MODEL_ENDPOINT,
  OPEN_CODE_GO_DOCUMENTATION_ENDPOINT,
  parseOpenCodeGoDocumentation,
  buildDshOpenCodeGoCatalog,
  catalogModelIds,
} from '../src/compatibility/opencode-go-catalog.js'

// Public, read-only discovery. No credentials and no inference requests.
const runtimeRoot = resolve(process.argv[2] ?? 'C:/Users/1/.dsh-desktop-runtime')
const output = resolve(process.argv[3] ?? 'output/go-catalog-audit')
const activePath = join(runtimeRoot, 'release-state', 'active.json')
const before = await readFile(activePath, 'utf8')
const active = JSON.parse(before)
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(active.releaseId)) throw new Error('Invalid active release identity')
const candidate = join(runtimeRoot, 'candidates', active.releaseId)
const manifest = JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8'))
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.dsh.version)) throw new Error('Invalid runtime version')
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.profile.physicalName)) throw new Error('Invalid physical profile name')
const paths = [
  ['physical-profile', join(candidate, 'profiles', manifest.profile.physicalName)],
  ['profile-source', join(candidate, 'profile')],
  ['runtime', join(candidate, 'runtime', 'versions', manifest.dsh.version)],
]
const installed = []
for (const [kind, root] of paths) {
  // The actual pi-ai catalog relative path is supplied by the repository's
  // declaration, not by network data or a user-supplied URL.
  const controller = await readFile(new URL('../src/desktop-runtime-controller.js', import.meta.url), 'utf8')
  const declaration = controller.match(/const DSH_PI_AI_OPEN_CODE_GO_CATALOG_PATH = Object\.freeze\(\[([\s\S]*?)\]\)/)
  if (!declaration) throw new Error('Catalog path declaration was not found')
  const segments = [...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1])
  if (!segments.length || segments.some(value => !/^[A-Za-z0-9._-]+$/.test(value) || value === '..')) throw new Error('Unsafe catalog path')
  try {
    const source = await readFile(join(root, 'node_modules', '@earendil-works', 'pi-ai', ...segments), 'utf8')
    installed.push({ kind, source, ids: catalogModelIds(JSON.parse(source)).sort() })
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
if (!installed.length) throw new Error('No installed Go catalog found')
async function get(url, accept) {
  const response = await fetch(url, { redirect: 'error', headers: { accept }, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`Official discovery returned HTTP ${response.status}`)
  const text = await response.text()
  if (Buffer.byteLength(text) > 2_000_000) throw new Error('Official discovery response exceeded limit')
  return text
}
const [apiText, documentationText] = await Promise.all([
  get(OPEN_CODE_GO_MODEL_ENDPOINT, 'application/json'),
  get(OPEN_CODE_GO_DOCUMENTATION_ENDPOINT, 'text/html'),
])
const apiIds = [...new Set(JSON.parse(apiText).data.map(model => model.id))].sort()
const descriptors = parseOpenCodeGoDocumentation(documentationText)
const built = buildDshOpenCodeGoCatalog({ source: installed[0].source, availableIds: apiIds, descriptors })
const documentedIds = new Set(descriptors.map(descriptor => descriptor.id))
const confirmedIds = apiIds.filter(id => documentedIds.has(id))
if (before !== await readFile(activePath, 'utf8')) throw new Error('Active release changed during read-only audit')
const report = {
  checkedAt: new Date().toISOString(),
  activeRelease: active.releaseId,
  sources: [OPEN_CODE_GO_MODEL_ENDPOINT, OPEN_CODE_GO_DOCUMENTATION_ENDPOINT],
  inferenceRequests: 0,
  accountEntitlementsVerified: false,
  apiCount: apiIds.length,
  documentedCount: descriptors.length,
  confirmedRoutingCount: confirmedIds.length,
  generatedCatalogCount: built.appliedModelIds.length,
  apiIds,
  confirmedRoutingIds: confirmedIds,
  unconfirmedRoutingIds: apiIds.filter(id => !documentedIds.has(id)),
  generatedCatalogIds: built.appliedModelIds.sort(),
  installed: installed.map(({ kind, ids }) => ({ kind, count: ids.length, ids })),
}
await mkdir(output, { recursive: true })
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report))
