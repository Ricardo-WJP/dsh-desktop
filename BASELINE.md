# Ricardo Stable DSH Desktop — Upstream Baseline

## Source lock

- Upstream: `https://github.com/liguobao/dsh-desktop.git`
- Exact commit: `5a7fd60a74511071a1ca8034dd93b3c27ce21475`
- Upstream subject: `release: v0.1.34`
- Local branch: `feat/ricardo-stable-client`
- License: MIT
- `LICENSE` SHA-256: `37397ECF6CBCC7A9AC578C4F1BB26D9FEBA65EE33A1B7DF38C5E762230CC4EC8`
- `package-lock.json` SHA-256: `FB5CE771DCD4873D404353BF600B1F369AF301AC49A260CD7E14D22CEB94E04A`

## Toolchain used for the first Windows baseline

- Windows: local Ricardo workstation
- Node.js: `v22.22.3`
- npm: `10.9.8`
- Git: `2.54.0.windows.1`
- Electron pin: `43.4.0`
- electron-builder pin: `26.15.3`
- Bundled DSH pin: `0.1.1-rc.1`
- pnpm pin used by the desktop runtime: `11.21.0`

## Safety boundary

This baseline is built in `C:\DSH\ricardo-dsh-desktop`. It must not write to or update:

- `C:\Users\1\AppData\Local\DeepSeekHarness`
- `C:\Users\1\.dsh\profiles\web`
- the current plugin manifest or live runtime

The before/after live-file hashes are recorded in the Aegis evidence file for `2026-08-21-stable-dsh-client`.

## Baseline commands

```powershell
npm ci
npm test
npm run check
npm run dist:windows
```

## Results

| Step | Result |
| --- | --- |
| `npm ci` | PASS — 753 packages installed; 0 npm audit vulnerabilities; upstream `patch-package` patch applied |
| `npm test` | PASS — 81/81 tests, 0 failed, 17.2 s |
| `npm run check` | PASS — all upstream syntax checks exited 0 |
| `npm run dist:windows` | PASS — setup and portable produced; exit 0; approximately 11.5 minutes |

## Baseline observations

- electron-builder reports `asar: false` as strongly discouraged. This is an upstream baseline risk to address under the approved packaging task, not a Task 1 modification.
- electron-builder reports a large duplicate-dependency reference set while assembling the unpacked app. The build still proceeds, but reproducibility/size evidence must be captured before changing packaging.
- npm reports deprecated transitive packages (`inflight`, `glob@7`, `boolean`, `node-domexception`) but 0 audit vulnerabilities at this lock state.
- Repeated `UNDICI-EHPA` experimental proxy-agent warnings are environmental/toolchain warnings; tests still pass.

## Windows artifacts

| Artifact | Bytes | SHA-256 | Authenticode |
| --- | ---: | --- | --- |
| `DSH-Desktop-v0.1.34-windows-x64-setup.exe` | 167,985,700 | `64D7DADEB8E771E9F14B8ABFA6E2B825FEE1BEFA00D763BAE2E06E532E1FC5C5` | NotSigned |
| `DSH-Desktop-v0.1.34-windows-x64-portable.exe` | 167,711,768 | `9CE8ED77869AE196B333CD6A74A08DFEC1776D8D2B671A16A29D95A517AFD7F7` | NotSigned |

The unpacked baseline contains 23,794 files and 646,582,833 bytes. The high-compression NSIS stage was slow but demonstrably active; no duplicate build was started.

## Live-boundary verification

The SHA-256 values for the current `web` manifest, `cordis.patch.yml`, `pnpm-workspace.yaml`, live runtime `package.json`, and launcher `state.json` match the Task 1 start snapshot exactly. Task 1 did not modify the existing client, live runtime, profile, or plugin list.

Baseline completed at `2026-08-21T19:42:25.6544854+08:00`.
