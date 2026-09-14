import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { parse, stringify } from 'yaml'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const root = 'C:/Users/1/.dsh-desktop-runtime'
const expected = 'plugin-83e34e81-97d0-4e28-9a10-0359b878803b'
const sourceId = 'plugin-6f9bb75b-7f85-47a9-b60e-d14c73778c6e'
const active = JSON.parse(await readFile(join(root, 'release-state', 'active.json'), 'utf8'))
assert.equal(active.releaseId, expected, 'Active release changed; do not write')
const path = join(root, 'candidates', expected, '.credentials.yaml')
const previous = parse(await readFile(join(root, 'candidates', sourceId, '.credentials.yaml'), 'utf8'))
const currentText = await readFile(path, 'utf8')
const current = parse(currentText)
const key = 'OPENCODE_GO_API_KEY'
assert.equal(typeof previous.refs?.[key], 'string', 'No prior credential reference value')
assert.ok(previous.refs[key].length > 0)
assert.ok(!Object.hasOwn(current.refs ?? {}, key), 'Existing value must never be overwritten')
const backup = 'C:/Users/1/.codex/backups/auto-config-upgrades/2026-09-05-174154-dsh-composer-controls'
await copyFile(path, join(backup, 'credentials-before-go-restore.yaml'))
assert.equal(await readFile(path, 'utf8'), currentText)
current.refs = { ...(current.refs ?? {}), [key]: previous.refs[key] }
const temp = `${path}.restore-go-${process.pid}.tmp`
await writeFile(temp, stringify(current), { flag: 'wx', mode: 0o600 })
assert.equal(JSON.parse(await readFile(join(root, 'release-state', 'active.json'), 'utf8')).releaseId, expected)
await rename(temp, path)
const checked = parse(await readFile(path, 'utf8'))
assert.equal(checked.refs[key], previous.refs[key])
console.log(JSON.stringify({ restored: true, existingRecordsPreserved: JSON.stringify(checked.records) === JSON.stringify(parse(currentText).records), sourceId, backup }))
