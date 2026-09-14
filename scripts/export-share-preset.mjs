import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parse } from 'yaml'
import { publicAppearance, readSharePreset } from '../src/share-preset.js'
import { DESKTOP_PLUGIN_SUITE } from '../src/plugin-suite.js'

const [profileFile, settingsFile] = process.argv.slice(2)
if (!profileFile || !settingsFile) throw new Error('Provide explicit profile package.json and settings.yaml paths')
const profile = JSON.parse(readFileSync(resolve(profileFile), 'utf8'))
const appearance = publicAppearance(parse(readFileSync(resolve(settingsFile), 'utf8')))
const allowed = new Set(DESKTOP_PLUGIN_SUITE.map(item => item.packageName))
const signalVersion = DESKTOP_PLUGIN_SUITE.find(item => item.packageName === 'dsh-signal').source.versionOrTag
const plugins = Object.entries(profile.dependencies ?? {}).filter(([name]) => allowed.has(name)).map(([name, version]) => ({ name, version: name === 'dsh-signal' ? signalVersion : version }))
const root = resolve(import.meta.dirname, '..')
const target = join(root, 'build', 'plugin-suite')
mkdirSync(target, { recursive: true })
const output = { schemaVersion: 1, plugins, appearance }
writeFileSync(join(target, 'share-preset.json'), JSON.stringify(output, null, 2) + '\n')
readSharePreset(root) // Reject floating versions before packaging.
console.log(JSON.stringify({ plugins: plugins.length, appearanceSections: Object.keys(appearance), excludes: ['accounts', 'credentials', 'sessions', 'memory', 'paths', 'machine identifiers'] }))
