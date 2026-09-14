import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { parseMigrationArguments, MIGRATION_USAGE } from '../src/migration/cli.js'
import { prepareSideBySideMigration } from '../src/migration/side-by-side.js'

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseMigrationArguments(argv)
  if (parsed.help) {
    console.log(MIGRATION_USAGE)
    return { help: true }
  }
  const result = await prepareSideBySideMigration(parsed)
  console.log(JSON.stringify({
    status: result.status,
    mode: result.mode,
    reportPath: result.reportPath,
    dataId: result.metadata?.dataId,
    profileName: result.metadata?.profileName,
    takeOwnershipRequired: result.report?.migration?.legacyHost?.takeOwnershipRequired === true,
  }, null, 2))
  return result
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await main()
    if (result?.status === 'failed') process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(`\n${MIGRATION_USAGE}`)
    process.exitCode = 1
  }
}
