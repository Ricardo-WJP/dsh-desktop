import { DSH_RC2_COMPATIBILITY_RECIPE } from './dsh-0.1.1-rc.2.js'

// Repair the picker and missing native session attribution. Do not carry model route
// defaults or unrelated rc.2 patches into newer Harness runtimes.
export const DSH_012_COMPATIBILITY_RECIPE = Object.freeze({
  schemaVersion: 1,
  id: 'dsh-0.1.2-rc.1-electron-directory-picker',
  dsh: { name: '@deepseek-ai/dsh', version: '0.1.2-rc.1' },
  targets: [...DSH_RC2_COMPATIBILITY_RECIPE.targets.filter(target => target.id.startsWith('windows-directory-picker-')).map(target => target.id.endsWith('-worker') ? {
    ...target,
    sourceSha256: '281c0e84fe859b076ffb7f6ca79cb7581617d3cb1830a265996693295bb4f4e6',
    operations: target.operations.map(operation => ({ ...operation, find: operation.find.replace('bytes[end] !== 0', '!(bytes[end] === 0 && bytes[end + 1] === 0)') })),
  } : target), {
    id: 'pi-ai-native-session-header',
    package: '@deepseek-ai/dsh-llm-pi-ai',
    path: 'node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
    sourceSha256: '69c387a2f1de52d7798748737e3cf1b669e2b6a3d4820cda384f1cf9be9c23b0',
    appliedSha256: '769691d11db6a6d12eb63c4e24c365611ccb387c4de18f85a2e5de9584129139',
    operations: [{
      id: 'native-session-attribution',
      find: 'function requestHeaders(headers) {\n\tconst attribution = attributionHeaders();',
      replace: 'function requestHeaders(headers, sessionId) {\n\tconst attribution = attributionHeaders();\n\tif (sessionId !== void 0) attribution["x-deepseek-harness-session-id"] = String(sessionId);',
    }, {
      id: 'forward-conversation-id',
      find: 'headers: requestHeaders(profile.headers)',
      replace: 'headers: requestHeaders(profile.headers, options.sessionId)',
    }],
    assertions: [{ id: 'session-forwarded', anchor: 'headers: requestHeaders(profile.headers, options.sessionId)', count: 1 }],
  }, {
    id: 'windows-native-hidden-console',
    package: '@deepseek-ai/dsh-win32-process',
    path: 'node_modules/@deepseek-ai/dsh-win32-process/lib/index.js',
    sourceSha256: '13d577a0152b7299ba4b4d7a8a03044f4eae2c2a93f10c3e39499c96c9f52e7d',
    appliedSha256: '628196b936000c5a2f416ab60cc93e6fc81b7497d8079b1d23ffd3a2d3f746fe',
    operations: ['stdIn.read', 'stdIn'].map((input, index) => ({
      id: `hidden-startup-${index}`,
      find: `dwFlags: 256,\n\t\t\thStdInput: ${input},`,
      replace: `dwFlags: 257,\n\t\t\twShowWindow: 0,\n\t\t\thStdInput: ${input},`,
    })),
    // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, SW_HIDE. Keep native
    // creation flags and restricted token unchanged (no CREATE_NO_WINDOW).
    assertions: [{ id: 'hidden-startup-both-paths', anchor: 'dwFlags: 257,\n\t\t\twShowWindow: 0,', count: 2 }],
  }],
})

export function compatibilityRecipeForVersion(version) {
  if (version === DSH_RC2_COMPATIBILITY_RECIPE.dsh.version) return DSH_RC2_COMPATIBILITY_RECIPE
  if (version === DSH_012_COMPATIBILITY_RECIPE.dsh.version) return DSH_012_COMPATIBILITY_RECIPE
  return undefined
}
