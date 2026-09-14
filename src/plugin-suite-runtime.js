import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

function isWithin(root, target) {
  const remainder = relative(root, target)
  return remainder === '' || (remainder !== '..' && !remainder.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(remainder))
}

export function resolveBundledMnemon({
  appPath,
  platform = process.platform,
  arch = process.arch,
  readFile = readFileSync,
  lstat = lstatSync,
  realpath = realpathSync,
} = {}) {
  if (typeof appPath !== 'string' || !isAbsolute(appPath)) throw new TypeError('Application path must be absolute')
  const key = `${platform}-${arch}`
  const root = resolve(appPath, 'build', 'plugin-suite', 'bin', key)
  const receiptPath = join(root, 'receipt.json')
  const receipt = JSON.parse(readFile(receiptPath, 'utf8'))
  const expectedExecutable = platform === 'win32' ? 'mnemon.exe' : 'mnemon'
  if (receipt?.schemaVersion !== 1
    || receipt?.platform !== platform
    || receipt?.arch !== arch
    || receipt?.executable !== expectedExecutable
    || !/^[a-f0-9]{64}$/.test(receipt?.binarySha256 ?? '')) {
    throw new Error(`Invalid bundled Mnemon receipt for ${key}`)
  }
  const executable = join(root, expectedExecutable)
  const rootReal = realpath(root)
  const executableReal = realpath(executable)
  if (!isWithin(rootReal, executableReal)) throw new Error('Bundled Mnemon executable escapes its asset root')
  const details = lstat(executableReal)
  if (!details.isFile() || details.isSymbolicLink?.() === true || details.isReparsePoint?.() === true) {
    throw new Error('Bundled Mnemon executable is not a regular file')
  }
  const actual = createHash('sha256').update(readFile(executableReal)).digest('hex')
  if (actual !== receipt.binarySha256) throw new Error('Bundled Mnemon executable checksum mismatch')
  return Object.freeze({ path: executableReal, version: receipt.version, sha256: actual, receiptPath })
}
