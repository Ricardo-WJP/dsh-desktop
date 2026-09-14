# Editable management renderer

Task 3 introduces the app-owned management shell at `src/renderer/`. It is a
normal Vite + React + TypeScript frontend and is intentionally redesignable:
Ricardo can replace the visual language, layout, typography and interaction
patterns without changing the desktop contract. Visual work stays in
`src/renderer/components/`, `src/renderer/routes/`, `src/renderer/styles/` and
assets. In short, visual work stays in components/styles/tokens while the
typed IPC bridge remains the stable boundary owned by the main process.

- `npm run dev:desktop` generates the self-contained sandbox preloads, then
  starts the Vite HMR server and Electron with the `DSH_DESKTOP_RENDERER_URL`
  compatibility bridge.
- `npm run build:preloads` deterministically derives both runtime preloads from
  `src/ipc/channels.cjs` into `build/preload/`; `start`, `dev:desktop`, tests,
  checks and release builds run this step automatically.
- `npm run build:renderer` writes deterministic production assets to
  `build/renderer/`.
- `npm start` builds that renderer before opening Electron unless
  `npm run dev:desktop` is used explicitly.
- Every `dist*` command runs `build:renderer` before electron-builder.
- `npm run renderer:typecheck` validates the renderer and Vite config.

The management window is app-owned. The DSH workspace remains in its own
sandboxed BrowserWindow and is never modified by DOM injection from the shell.
The desktop package is a blank profile by default: it materializes only the DSH
core bundles and does not install, list or mutate optional plugins. Plugin
discovery and installation stay inside native DSH; users who want them can
install and update `dsh-market` there. The app-owned desktop integration adapter
is kept separate because it only supplies the native desktop bridge and is not a
user-selectable plugin.

Candidate release activation and snapshot writes are deliberately shown as
unavailable until their transactional owners land. The shell does not fake
success for those operations.
