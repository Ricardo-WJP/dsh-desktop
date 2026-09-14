import { mkdtemp, mkdir, copyFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fork } from 'node:child_process'
import { applyCompatibilityRecipe } from '../src/release/compatibility-recipe.js'
import { DSH_012_COMPATIBILITY_RECIPE as recipe } from '../compatibility/recipes/dsh-0.1.2-rc.1.js'

const [runtimePath, electronPath, mode = 'select'] = process.argv.slice(2)
if (!runtimePath || !electronPath || !['select', 'cancel'].includes(mode)) throw new Error('runtime, Electron path and select/cancel required')
const root = await mkdtemp(join(tmpdir(), 'dsh-picker-verified-'))
for (const target of recipe.targets) {
  const dest = join(root, target.path)
  await mkdir(resolve(dest, '..'), { recursive: true })
  await copyFile(join(runtimePath, target.path), dest)
}
await applyCompatibilityRecipe({ root, recipe, dshVersion: '0.1.2-rc.1', write: true })
await cp(join(runtimePath, 'node_modules', 'koffi'), join(root, 'node_modules', 'koffi'), { recursive: true, dereference: true })
const child = fork(join(root, recipe.targets.find(t => t.id.endsWith('-worker')).path), [], {
  execPath: electronPath, execArgv: [], windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: join(runtimePath, 'node_modules'), DSH_DIALOG_TITLE: `DSH 文件夹选择器验收 (${mode})` },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})
let result
child.on('message', message => {
  if (message.kind === 'done' || message.kind === 'error') result = message
})
child.stderr.on('data', chunk => process.stderr.write(chunk))
child.on('exit', code => {
  const ok = code === 0 && result?.kind === 'done' && (mode === 'cancel' ? result.path == null : typeof result.path === 'string' && result.path.length > 0)
  console.log(JSON.stringify({ mode, ok, code, result }))
  process.exitCode = ok ? 0 : 1
})
