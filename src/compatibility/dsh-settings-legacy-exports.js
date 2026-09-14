/**
 * Some DSH releases move the settings helper exports onto the provider
 * service without keeping the three helper names used by the plugin
 * ecosystem. Keep this shim capability-based: it only applies when the
 * provider exposes the newer installSection contract, and only inside a
 * disposable candidate before activation.
 */

export const DSH_SETTINGS_PACKAGE = '@deepseek-ai/dsh-settings'
export const DSH_SETTINGS_LEGACY_EXPORTS_MARKER = 'DSH_DESKTOP_SETTINGS_LEGACY_EXPORTS'

const EXPORT_ANCHOR = 'export { SettingsConflictError, SettingsProvider, SettingsProvider as default, redactSecrets };'

function hasLegacyExports(source) {
  const exportBlock = source.match(/export\s*\{[\s\S]*?\};/g)?.join('\n') ?? ''
  return exportBlock.includes('deepEqualJson')
    && exportBlock.includes('settingsNamespace')
    && exportBlock.includes('installSettingsSection')
}

export function patchDshSettingsLegacyExports(source) {
  if (typeof source !== 'string') return { state: 'unrecognized', source }
  if (source.includes(DSH_SETTINGS_LEGACY_EXPORTS_MARKER)) {
    return { state: hasLegacyExports(source) ? 'compatible' : 'unrecognized', source }
  }
  // Upstream releases that still expose the legacy helpers are already
  // compatible. Recognize them before looking for the newer provider shape so
  // a healthy old DSH is not rejected merely because it has no Desktop marker.
  if (hasLegacyExports(source)) return { state: 'compatible', source }
  if (!source.includes('import { deepEqualJson, deepFreeze } from "@deepseek-ai/dsh-util-values";')) {
    return { state: 'unrecognized', source }
  }
  if (!source.includes('installSection(owner, ns, schema, entry, hooks)')) {
    return { state: 'unrecognized', source }
  }
  if (source.includes('function settingsNamespace(') || source.includes('function installSettingsSection(')) {
    return { state: 'unrecognized', source }
  }
  if (!source.includes(EXPORT_ANCHOR)) return { state: 'unrecognized', source }

  const shim = [
    `const ${DSH_SETTINGS_LEGACY_EXPORTS_MARKER} = true;`,
    '',
    '// Backward-compatible helper exports for DSH 0.1.1-era plugins.',
    'function settingsNamespace(value) {',
    '  return parseSettingsNamespace(value);',
    '}',
    'function installSettingsSection(ctx, ns, schema, entry, hooks) {',
    '  ctx.inject(["settings"], (settingsCtx) => {',
    '    const settings = settingsCtx.settings;',
    '    if (typeof settings.installSection === "function") {',
    '      settings.installSection(ctx, ns, schema, entry, hooks);',
    '      return;',
    '    }',
    '    const scope = settings.register(ns, schema, {',
    '      base: entry,',
    '      ...hooks.validate === void 0 ? {} : { validate: hooks.validate }',
    '    });',
    '    hooks.setSource(() => scope.get());',
    '    settingsCtx.effect(() => () => {',
    '      if (isUnloading(ctx)) return;',
    '      hooks.setSource(() => entry);',
    '      hooks.onChange();',
    '    });',
    '    hooks.onChange();',
    '    scope.watch(() => {',
    '      if (isUnloading(ctx)) return;',
    '      hooks.onChange();',
    '    });',
    '  });',
    '}',
    '',
  ].join('\n')
  const nextExport = 'export { SettingsConflictError, SettingsProvider, SettingsProvider as default, redactSecrets, deepEqualJson, settingsNamespace, installSettingsSection };'
  return { state: 'patched', source: source.replace(EXPORT_ANCHOR, `${shim}${nextExport}`) }
}
