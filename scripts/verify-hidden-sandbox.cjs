const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = process.env.DSH_HIDDEN_PROBE_RUNTIME;
const powershell = process.env.DSH_HIDDEN_PROBE_PWSH;
if (!root || !path.isAbsolute(root) || !root.includes('dsh-performance-runtime-')) throw new Error('Explicit isolated performance runtime required');
if (!powershell || !path.isAbsolute(powershell) || !fs.existsSync(powershell)) throw new Error('Explicit PowerShell executable required');
const active = JSON.parse(fs.readFileSync(path.join(root, 'release-state/active.json')));
const candidate = path.join(root, 'candidates', active.releaseId);
const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'manifest.json')));
const modules = path.join(candidate, 'runtime/versions', manifest.dsh.version, 'node_modules');
if (process.argv.includes('--child')) {
  const koffi = require(path.join(modules, 'koffi'));
  const getConsole = koffi.load('kernel32.dll').func('void * __stdcall GetConsoleWindow()');
  const isVisible = koffi.load('user32.dll').func('int __stdcall IsWindowVisible(void *)');
  const handle = getConsole();
  let writeDenied = false;
  try { fs.writeFileSync(path.join(process.argv.at(-1), 'denied-probe.txt'), 'probe'); } catch { writeDenied = true; }
  let outsideWriteDenied = false;
  try { fs.writeFileSync(path.join(path.dirname(process.argv.at(-1)), 'outside-probe.txt'), 'probe'); } catch { outsideWriteDenied = true; }
  console.log(JSON.stringify({ consoleVisible: handle != null && !!isVisible(handle), writeDenied, outsideWriteDenied }));
} else {
  const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsh-hidden-probe-'));
  const workspace = path.join(scratch, 'workspace');
  const temp = path.join(scratch, 'temp');
  fs.mkdirSync(workspace); fs.mkdirSync(temp);
  const runner = path.join(modules, '@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js');
  for (const mode of ['read-only', 'workspace-write', 'unrestricted']) {
  const command = `& '${process.execPath.replaceAll("'", "''")}' '${__filename.replaceAll("'", "''")}' --child '${workspace.replaceAll("'", "''")}' | Out-String`;
  const argv = [powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command];
  const launch = mode === 'unrestricted' ? argv : [process.execPath, runner, '--workspace', workspace, '--temp', temp, '--mode', mode, '--', ...argv];
  const result = spawnSync(launch[0], launch.slice(1), {
    windowsHide: true, encoding: 'utf8', timeout: 45000, env: {...process.env, ELECTRON_RUN_AS_NODE:'1'},
  });
  console.log(JSON.stringify({ mode, exitCode:result.status, stdout:result.stdout, stderr:result.stderr, scratch }));
  if (result.status !== 0 || !result.stdout.includes('"consoleVisible":false') || !result.stdout.includes(`"writeDenied":${mode === 'read-only'}`) || !result.stdout.includes(`"outsideWriteDenied":${mode !== 'unrestricted'}`)) process.exitCode = 1;
  }
}
