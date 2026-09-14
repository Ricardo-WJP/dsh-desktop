const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i
const COMMIT = /^[a-f0-9]{40}$/i

/** Parse user-selected sources, without a bundled catalog allowlist. */
export function parseMarketSource(value) {
  if (typeof value !== 'string' || value.length > 500 || !value.trim()) throw new TypeError('Invalid plugin source')
  const raw = value.trim()
  const npm = /^(?:npm:)?((?:@[^/\s]+\/)?[^@\s/]+)(?:@([a-z0-9][a-z0-9._-]*))?$/i.exec(raw)
  if (npm && PACKAGE.test(npm[1])) {
    return { type: 'npm', package: npm[1], ...(npm[2] ? { versionOrTag: npm[2] } : {}) }
  }
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
    throw new TypeError('Plugin source must be a public HTTPS GitHub or npm URL')
  }
  const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1).map(decodeURIComponent)
  if (url.hostname === 'www.npmjs.com' || url.hostname === 'npmjs.com') {
    const name = parts.slice(1).join('/')
    if (parts[0] !== 'package' || !PACKAGE.test(name)) throw new TypeError('Invalid npm package URL')
    return { type: 'npm', package: name }
  }
  if (url.hostname !== 'github.com' || parts.length < 2 || parts.some(part => !SEGMENT.test(part) || part === '.' || part === '..')) {
    throw new TypeError('Invalid GitHub plugin source')
  }
  const repository = `${parts[0]}/${parts[1].replace(/\.git$/, '')}`
  if (parts.length > 2 && (parts[2] !== 'tree' || parts.length < 4)) throw new TypeError('Use a repository URL or /tree/ref/package-path')
  return {
    type: 'github', repository,
    ...(parts[3] ? { ref: parts[3] } : {}),
    ...(parts.length > 4 ? { path: `/${parts.slice(4).join('/')}` } : {}),
  }
}

async function readMetadata(url, { fetchImpl, signal }) {
  const response = await fetchImpl(url, { signal, redirect: 'error', headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`Plugin metadata request failed (HTTP ${response.status})`)
  if (Number(response.headers.get('content-length')) > 262144) throw new Error('Plugin metadata is too large')
  const reader = response.body.getReader()
  let bytes = 0
  const chunks = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 262144) throw new Error('Plugin metadata is too large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function resolveMarketSource(value, { fetchImpl = globalThis.fetch, signal } = {}) {
  const source = parseMarketSource(value)
  if (source.type === 'npm') return { packageName: source.package, source }
  const timeout = AbortSignal.timeout(20_000)
  const options = { fetchImpl, signal: signal ? AbortSignal.any([signal, timeout]) : timeout }
  const commit = source.ref && COMMIT.test(source.ref)
    ? source.ref
    : (await readMetadata(`https://api.github.com/repos/${source.repository}/commits/${encodeURIComponent(source.ref ?? 'HEAD')}`, options)).sha
  if (!COMMIT.test(commit ?? '')) throw new Error('GitHub did not return an exact plugin commit')
  const meta = await readMetadata(`https://raw.githubusercontent.com/${source.repository}/${commit}${source.path ?? ''}/package.json`, options)
  if (typeof meta.name !== 'string' || !PACKAGE.test(meta.name)) throw new Error('Plugin package.json has no valid package name')
  return { packageName: meta.name, source: { ...source, ref: commit } }
}
