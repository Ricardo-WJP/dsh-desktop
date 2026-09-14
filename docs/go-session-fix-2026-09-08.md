# Go session attribution repair

The active DSH 0.1.2-rc.1 pi-ai adapter passed `options.sessionId` to pi-ai but did not add the native HTTP session header. The direct DeepSeek adapter already sends `x-deepseek-harness-session-id`, which OpenCode Go explicitly recognizes: https://opencode.ai/docs/go/#where-can-i-use-it.

The repair forwards that same native header at the shared pi-ai adapter boundary, preserving actual conversation IDs, caller identity, model selection, credentials and UI. No OpenCode impersonation or fabricated fallback session IDs are added. The matching 0.1.2 recipe is hash-pinned and synchronized to the installed desktop for future candidate creation; unknown runtime versions are not patched blindly.

Validation:
- Installed adapter through real pi-ai serializers: completions, responses and anthropic messages; 12 local wire cases passed, including repeated conversation and separate child IDs.
- One real GLM-5.3-Flash inference through the installed adapter returned HTTP 200 and 51 stream chunks. No personal conversation content was sent; only a synthetic connection-check prompt. Other models were not live-tested.
- Nine targeted tests passed, including unchanged approved visual CSS hashes.
- Only verified DSH executable processes were restarted. Startup reached complete at 2026-09-08T12:37:30Z and port 3080 was listening.

Backup: `C:\Users\1\.codex\backups\auto-config-upgrades\2026-09-08-203227-go-session`.
Rollback: restore `pi-ai-index.js` to the active candidate's `runtime/versions/0.1.2-rc.1/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`, restore `recipe.js` and `installed-recipe.js` to their respective source/installed compatibility recipe paths, then restart only DSH. This repair is not included in the previously uploaded installer; no installer was rebuilt or republished here.
