# Native plugin revision acceptance

## Cause

The active release keeps an immutable `profile` snapshot, while native DSH operates on `profiles/<physicalName>`. Native dsh-codex-connect updated from 0.1.0-alpha.4.30 to 0.1.0-alpha.4.32 at 21:01 on September 8. Its running package.json and pnpm-lock.yaml changed, but the startup controller required byte equality with the original snapshot. This rejected the update before Harness could start, including safe mode.

## Repair

The controller now distinguishes matching snapshots from native revisions. For a revision it checks regular input files, unchanged non-dependency metadata and Cordis configuration, package/lockfile agreement, changed source types, installed exact registry versions, static compatibility, and an isolated real runtime preflight. It rechecks input stability after preflight and saves a revision receipt and input snapshot. The immutable release manifest, original profile and release pointer are not rewritten. Every drifted launch runs preflight again; a receipt is not treated as sufficient authorization for potentially changed modules.

This is deliberately bounded: arbitrary Git/source replacement and configuration or bundle-list changes are still rejected and must use the staged transaction route. It does not claim to automatically repair interrupted installs, detect every malicious plugin, or make all future plugin updates compatible. Runtime validation adds some startup time while the running profile differs from the release snapshot.

## Verification

- Current 0.4.32 update passed static and real isolated runtime validation (full version: 0.1.0-alpha.4.32).
- 82 existing controller tests and 6 focused revision/visual tests passed.
- Installed source updated; only verified DSH executable processes restarted.
- Desktop log reached startup complete at 2026-09-08T13:41:04.488Z; port 3080 listening.
- Native window listing returned the original conversation window. Screenshot capture could not complete because the helper retained the replaced splash-window handle, so no screenshot-based visual claim is made. No UI styles were edited; approved CSS hash tests passed.

## Backup and rollback

Backup: `C:\Users\1\.codex\backups\auto-config-upgrades\2026-09-08-213708-native-profile` contains original source/installed controllers and both profile input sets. Restore the appropriate controller file to undo the new acceptance flow (the original stale-profile rejection will return). No user data was removed, no plugin downgrade was performed, and no installer was published.
