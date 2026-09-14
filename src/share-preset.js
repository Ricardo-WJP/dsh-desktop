import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'

// Deliberate allowlist: never export generic settings, providers or storage.
export function publicAppearance(settings = {}) {
  const result = {}
  const theme = settings['ui-theme']?.preference
  if (['light', 'dark', 'system'].includes(theme)) result['ui-theme'] = { preference: theme }
  const busyEnter = settings['ui-conversation']?.busyEnter
  if (['steer', 'queue', 'newline'].includes(busyEnter)) result['ui-conversation'] = { busyEnter }
  const pet = settings['better-dsh-pet']
  if (typeof pet?.enabled === 'boolean') result['better-dsh-pet'] = { enabled: pet.enabled, includeSubagents: pet.includeSubagents === true }
  if (settings['dsh-better-sidebar']?.titleBarPresetId === 'dsh-desktop') {
    result['dsh-better-sidebar'] = { titleBarScheme: 'preset', titleBarPresetId: 'dsh-desktop', titleBarCompat: true }
  }
  return result
}

export function readSharePreset(appPath) {
  const file = join(appPath, 'build', 'plugin-suite', 'share-preset.json')
  if (!existsSync(file)) return undefined
  const input = JSON.parse(readFileSync(file, 'utf8'))
  if (input.schemaVersion !== 1 || !Array.isArray(input.plugins)) throw new Error('Invalid share preset')
  const plugins = input.plugins.map(item => {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(item?.name ?? '')) throw new Error('Invalid preset plugin name')
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(item.version ?? '') && !/^github:[\w.-]+\/[\w.-]+#[a-f0-9]{40}$/.test(item.version ?? '') && !(item.name === 'dsh-signal' && item.version === 'bundled')) throw new Error('Unpinned share plugin')
    return { name: item.name, version: item.version }
  })
  return { schemaVersion: 1, plugins, appearance: publicAppearance(input.appearance) }
}

export function seedShareAppearance(appPath, dshHome) {
  const preset = readSharePreset(appPath)
  if (!preset) return false
  const file = join(dshHome, 'settings.yaml')
  // Never overwrite existing user settings, even for an empty-looking file.
  if (existsSync(file)) return false
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, stringify(preset.appearance), { encoding: 'utf8', flag: 'wx' })
  return true
}
