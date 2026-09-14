import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function safeChild(root, target) {
  const remainder = relative(root, target)
  return remainder !== '' && remainder !== '..' && !remainder.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(remainder)
}

function runTar(args, cwd) {
  const result = spawnSync('tar', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false })
  if (result.status !== 0) throw new Error(`tar failed: ${(result.stderr || result.stdout || '').trim()}`)
  return result.stdout
}

async function findExecutable(root, name) {
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.shift()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name)
      if (entry.isDirectory()) queue.push(target)
      else if (entry.isFile() && entry.name === name) return target
    }
  }
  throw new Error(`Mnemon archive does not contain ${name}`)
}

export async function preparePluginSuiteAssets({
  root = repositoryRoot,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const manifestPath = join(root, 'build', 'plugin-suite', 'mnemon-assets.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const key = `${platform}-${arch}`
  const asset = manifest?.assets?.[key]
  if (asset === undefined) throw new Error(`No Mnemon suite asset is pinned for ${key}`)
  if (!/^https:\/\/github\.com\/mnemon-dev\/mnemon\/releases\/download\//.test(asset.url)
    || !/^[a-f0-9]{64}$/.test(asset.sha256)
    || basename(asset.filename) !== asset.filename
    || basename(asset.executable) !== asset.executable) {
    throw new Error(`Invalid pinned Mnemon asset for ${key}`)
  }

  const suiteRoot = join(root, 'build', 'plugin-suite')
  const outputRoot = join(suiteRoot, 'bin')
  const outputDirectory = join(outputRoot, key)
  if (!safeChild(outputRoot, outputDirectory)) throw new Error('Mnemon suite output escapes the generated asset root')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-mnemon-suite-'))
  try {
    const response = await fetch(asset.url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`Mnemon download failed with HTTP ${response.status}`)
    const archive = Buffer.from(await response.arrayBuffer())
    const archiveHash = sha256(archive)
    if (archiveHash !== asset.sha256) throw new Error(`Mnemon archive checksum mismatch for ${key}`)
    const archivePath = join(temporary, asset.filename)
    await writeFile(archivePath, archive)

    const entries = runTar(['-tf', archivePath], temporary).split(/\r?\n/).filter(Boolean)
    if (entries.length === 0 || entries.some(entry => isAbsolute(entry) || entry.split(/[\\/]/).includes('..'))) {
      throw new Error('Mnemon archive contains an unsafe path')
    }
    const extracted = join(temporary, 'extracted')
    await mkdir(extracted)
    runTar(['-xf', archivePath, '-C', extracted], temporary)
    const executableSource = await findExecutable(extracted, asset.executable)
    if (!(await stat(executableSource)).isFile()) throw new Error('Mnemon executable is not a regular file')

    await rm(outputDirectory, { recursive: true, force: true })
    await mkdir(outputDirectory, { recursive: true })
    const executablePath = join(outputDirectory, asset.executable)
    await copyFile(executableSource, executablePath)
    if (platform !== 'win32') await chmod(executablePath, 0o755)
    const binaryHash = sha256(await readFile(executablePath))
    const versionResult = spawnSync(executablePath, ['--version'], { encoding: 'utf8', windowsHide: true, shell: false })
    if (versionResult.status !== 0 || !String(versionResult.stdout).includes(manifest.version)) {
      throw new Error(`Mnemon executable version check failed for ${key}`)
    }
    const receipt = {
      schemaVersion: 1,
      platform,
      arch,
      version: manifest.version,
      executable: asset.executable,
      archive: asset.filename,
      archiveSha256: archiveHash,
      binarySha256: binaryHash,
      source: asset.url,
    }
    await writeFile(join(outputDirectory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
    return { ...receipt, directory: outputDirectory, executablePath }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await preparePluginSuiteAssets(), null, 2)}\n`)
}
