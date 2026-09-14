const packageJson = require('../package.json')

const base = packageJson.build
module.exports = {
  ...base,
  extraMetadata: {
    ...(base.extraMetadata || {}),
    dshDesktopFlavor: 'suite',
  },
  files: [...base.files, 'build/plugin-suite/**/*', '!build/plugin-suite/plugins/dsh-signal/**/*', '!build/plugin-suite/plugins/dsh-signal.source.json'],
  mac: {
    ...base.mac,
    artifactName: 'DSH-Desktop-Suite-v${version}-macos-${arch}.${ext}',
  },
  nsis: {
    ...base.nsis,
    artifactName: 'DSH-Desktop-Suite-v${version}-windows-${arch}-setup.${ext}',
  },
  portable: {
    ...base.portable,
    artifactName: 'DSH-Desktop-Suite-v${version}-windows-${arch}-portable.${ext}',
  },
}
