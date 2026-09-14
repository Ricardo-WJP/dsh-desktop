/**
 * Desktop recipes repair known upstream defects; they are not a plugin
 * allowlist. A new layout is run natively and must pass the same profile,
 * runtime and activation gates as every other candidate. Integrity and path
 * validation errors still throw at their source and never pass through here.
 */
export function resolvePluginCompatibilityPolicy(report) {
  const checks = report?.checks ?? [report]
  if (!Array.isArray(checks) || checks.some(check => !check || typeof check.state !== 'string')) {
    throw new TypeError('Invalid desktop plugin compatibility report')
  }
  const warnings = []
  const resolved = checks.map(check => {
    if (check.state !== 'unrecognized') return check
    if (check.blocking === true) {
      const error = new Error(`Plugin ${check.packageName} requires an unavailable desktop capability`)
      error.code = 'PLUGIN_DESKTOP_CAPABILITY_REQUIRED'
      throw error
    }
    warnings.push(Object.freeze({
      packageName: check.packageName,
      version: check.version ?? null,
      code: 'native-plugin-fallback',
      message: `${check.packageName} 使用原生实现；桌面专用增强暂未适配此版本。`,
    }))
    return Object.freeze({ ...check, state: 'native', recipeState: 'unrecognized' })
  })
  return Object.freeze({ ...report, checks: Object.freeze(resolved), warnings: Object.freeze(warnings) })
}
