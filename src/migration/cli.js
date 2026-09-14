import { assertAbsolutePath } from './path-safety.js'

export const MIGRATION_USAGE = [
  'node scripts/prepare-side-by-side-migration.mjs',
  '  --mode dry-run|execute',
  '  --dsh-home <absolute path>',
  '  --web-profile <absolute path>',
  '  --output-root <absolute path>',
  '  [--id <safe id>] [--retry-limit <1..10>]',
].join('\n')

function nextValue(argv, index, flag) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function generatedId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}

export function parseMigrationArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') return { help: true }
    const equalsIndex = argument.indexOf('=')
    const flag = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument
    const inline = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : undefined
    if (!['--mode', '--dsh-home', '--web-profile', '--output-root', '--id', '--retry-limit'].includes(flag)) {
      throw new Error(`unknown argument: ${argument}`)
    }
    const value = inline ?? nextValue(argv, index, flag)
    if (inline === undefined) index += 1
    if (values[flag.slice(2)] !== undefined) throw new Error(`duplicate argument: ${flag}`)
    values[flag.slice(2)] = value
  }
  if (values.mode !== 'dry-run' && values.mode !== 'execute') throw new Error('--mode must be explicitly dry-run or execute')
  for (const flag of ['dsh-home', 'web-profile', 'output-root']) {
    const key = flag.replaceAll('-', '')
    values[key] = assertAbsolutePath(values[flag], `--${flag}`)
    delete values[flag]
  }
  const id = values.id ?? generatedId()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error('--id must be a safe identifier')
  const retryLimit = values['retry-limit'] === undefined ? 3 : Number(values['retry-limit'])
  if (!Number.isInteger(retryLimit) || retryLimit < 1 || retryLimit > 10) throw new Error('--retry-limit must be an integer between 1 and 10')
  return {
    mode: values.mode,
    dshHome: values.dshhome,
    webProfile: values.webprofile,
    outputRoot: values.outputroot,
    id,
    retryLimit,
  }
}
