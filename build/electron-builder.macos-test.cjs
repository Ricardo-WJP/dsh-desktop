const suite = require('./electron-builder.suite.cjs')

module.exports = {
  ...suite,
  mac: {
    ...suite.mac,
    // This file is used only by the manually opted-in CI test-package job.
    identity: null,
    notarize: false,
    hardenedRuntime: true,
    entitlements: suite.mac.entitlements,
    entitlementsInherit: suite.mac.entitlementsInherit,
  },
  dmg: {
    ...suite.dmg,
    sign: false,
  },
}
