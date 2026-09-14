/**
 * Task 3 compatibility boundary for plugin management.
 *
 * The React route is intentionally a status/entry surface. The legacy manager
 * remains the sole catalog and mutation owner until the retirement trigger is
 * met, so two plugin mutation implementations cannot drift.
 */
export const PLUGIN_COMPATIBILITY = Object.freeze({
  legacySurface: 'legacy-plugin-manager',
  catalogOwner: 'legacy-plugin-manager',
  mutationOwner: 'legacy-plugin-manager',
  reactRole: 'status-entry',
  retirementTrigger: 'Retire after PluginTransactionService parity and the React route/action regression suite pass.',
})

export function pluginOwnerFor(capability) {
  if (capability === 'catalog') return PLUGIN_COMPATIBILITY.catalogOwner
  if (capability === 'mutation') return PLUGIN_COMPATIBILITY.mutationOwner
  throw new TypeError(`Unknown plugin capability: ${String(capability)}`)
}

export function canPluginSurfaceUse(capability, surface) {
  return pluginOwnerFor(capability) === surface
}
