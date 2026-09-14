import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DESKTOP_DISTRIBUTION_FLAVORS = Object.freeze(['standard', 'suite'])

export function readDesktopDistributionFlavor(appPath, readFile = readFileSync) {
  try {
    const manifest = JSON.parse(readFile(join(appPath, 'package.json'), 'utf8'))
    return manifest?.dshDesktopFlavor === 'suite' ? 'suite' : 'standard'
  } catch {
    return 'standard'
  }
}
