'use strict'

// DeepSeek Harness runs inside Electron's Node mode on Windows. Third-party
// plugins do not consistently pass windowsHide when they launch helper
// processes, which can briefly flash cmd.exe/PowerShell windows over the UI.
// The desktop contract is stricter than Node's default: managed plugins may
// not opt back into visible console windows. Force hidden execution for every
// child-process API loaded by the managed Harness runtime.
if (process.platform === 'win32') {
  const childProcess = require('node:child_process')
  const { syncBuiltinESMExports } = require('node:module')
  const { promisify } = require('node:util')

  // Leave invalid option types to Node's validators instead of turning them
  // into valid objects. exec/execSync intentionally accept spreadable options.
  const hidden = options => options != null && (typeof options !== 'object' || Array.isArray(options))
    ? options
    : { ...(options ?? {}), windowsHide: true }
  // `null` is accepted by Node's spawn overload as an omitted options value,
  // but it would otherwise bypass the policy and restore the visible default.
  const spawnOptions = options => hidden(options)
  const fileArguments = (args, options, callback) => {
    if (args != null && typeof args === 'object' && !Array.isArray(args)) {
      callback = options
      options = args
      args = undefined
    } else if (typeof args === 'function') {
      callback = args
      options = undefined
      args = undefined
    }
    if (typeof options === 'function') {
      callback = options
      options = { ...options }
    }
    return [args ?? [], hidden(options), callback]
  }
  const original = {
    spawn: childProcess.spawn,
    spawnSync: childProcess.spawnSync,
    exec: childProcess.exec,
    execSync: childProcess.execSync,
    execFile: childProcess.execFile,
    execFileSync: childProcess.execFileSync,
    fork: childProcess.fork,
  }

  childProcess.spawn = function spawn(command, args, options) {
    return args != null && typeof args === 'object' && !Array.isArray(args)
      ? original.spawn.call(this, command, hidden(args))
      : original.spawn.call(this, command, args, spawnOptions(options))
  }
  childProcess.spawnSync = function spawnSync(command, args, options) {
    return args != null && typeof args === 'object' && !Array.isArray(args)
      ? original.spawnSync.call(this, command, hidden(args))
      : original.spawnSync.call(this, command, args, spawnOptions(options))
  }
  childProcess.exec = function exec(command, options, callback) {
    return typeof options === 'function'
      ? original.exec.call(this, command, hidden(), options)
      : original.exec.call(this, command, { ...options, windowsHide: true }, callback)
  }
  childProcess.execSync = function execSync(command, options) {
    return original.execSync.call(this, command, { ...options, windowsHide: true })
  }
  childProcess.execFile = function execFile(file, args, options, callback) {
    return original.execFile.call(this, file, ...fileArguments(args, options, callback))
  }
  childProcess.execFileSync = function execFileSync(file, args, options) {
    const [fileArgs, fileOptions] = fileArguments(args, options)
    return original.execFileSync.call(this, file, fileArgs, fileOptions)
  }
  childProcess.fork = function fork(modulePath, args, options) {
    return args != null && typeof args === 'object' && !Array.isArray(args)
      ? original.fork.call(this, modulePath, hidden(args))
      : original.fork.call(this, modulePath, args, hidden(options))
  }

  for (const name of ['exec', 'execFile']) {
    const wrapped = childProcess[name]
    // Node's original custom promisifier closes over the unwrapped function.
    // Recreate its contract, but always dispatch through the hidden wrapper.
    Object.defineProperty(wrapped, promisify.custom, {
      value: function (...args) {
        let resolve
        let reject
        const promise = new Promise((onResolve, onReject) => {
          resolve = onResolve
          reject = onReject
        })
        promise.child = wrapped.call(this, ...args, (error, stdout, stderr) => {
          if (error !== null) {
            error.stdout = stdout
            error.stderr = stderr
            reject(error)
          } else {
            resolve({ stdout, stderr })
          }
        })
        return promise
      },
    })
  }

  // ESM named imports are snapshots of built-in exports unless synchronized.
  syncBuiltinESMExports()
}
