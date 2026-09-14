import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createArtifactManifest,
  createCycloneDxSbom,
  createThirdPartyNotices,
  generateReleaseEvidence,
  serializeArtifactManifest,
  serializeCanonicalJson,
  verifyDetachedSignature,
  verifyReleaseEvidence,
  writeReleaseEvidence,
} from '../src/release/artifact-manifest.js'

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-release-evidence-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function createStaging(root, order = 'first') {
  const staging = join(root, `staging-${order}`)
  await mkdir(join(staging, 'desktop'), { recursive: true })
  await mkdir(join(staging, 'nested'), { recursive: true })
  await mkdir(join(staging, 'ignored'), { recursive: true })
  const files = order === 'first'
    ? [
        ['nested/z.txt', 'z'],
        ['desktop/DSH-setup.exe', 'setup'],
        ['ignored/cache.bin', 'ignored'],
        ['desktop/DSH-portable.exe', 'portable'],
        ['nested/a.txt', 'a'],
      ]
    : [
        ['nested/a.txt', 'a'],
        ['desktop/DSH-portable.exe', 'portable'],
        ['ignored/cache.bin', 'ignored'],
        ['nested/z.txt', 'z'],
        ['desktop/DSH-setup.exe', 'setup'],
      ]
  for (const [relativePath, contents] of files) await writeFile(join(staging, relativePath), contents, 'utf8')
  return staging
}

function packageInputs(root) {
  const packageJsonPath = join(root, 'package.json')
  const packageLockPath = join(root, 'package-lock.json')
  const releaseManifestPath = join(root, 'release-manifest.json')
  return {
    packageJsonPath,
    packageLockPath,
    releaseManifestPath,
  }
}

async function createPackageInputs(root) {
  const paths = packageInputs(root)
  await writeJson(paths.packageJsonPath, {
    name: 'evidence-fixture',
    version: '1.0.0',
    license: 'MIT',
    dependencies: { 'dep-one': '^1.2.3' },
    devDependencies: { 'dep-two': '^2.0.0' },
  })
  await writeJson(paths.packageLockPath, {
    name: 'evidence-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'evidence-fixture', version: '1.0.0', license: 'MIT' },
      'node_modules/dep-one': {
        version: '1.2.3',
        resolved: 'https://registry.npmjs.org/dep-one/-/dep-one-1.2.3.tgz',
        integrity: 'sha512-AAAA',
        license: 'Apache-2.0',
        repository: { type: 'git', url: 'https://github.com/example/dep-one.git' },
      },
      'node_modules/dep-two': {
        version: '2.0.0',
      },
    },
  })
  await writeJson(paths.releaseManifestPath, {
    schemaVersion: 1,
    releaseId: 'fixture-1',
    artifacts: ['desktop setup', 'desktop portable'],
  })
  return paths
}

test('equivalent staging trees produce the same sorted artifact manifest and hash', async t => {
  const root = await temporaryDirectory(t)
  const first = await createStaging(root, 'first')
  const second = await createStaging(root, 'second')
  const options = {
    exclude: ['ignored/**'],
    requiredArtifacts: ['desktop/DSH-setup.exe', 'desktop/DSH-portable.exe'],
  }
  const firstManifest = await createArtifactManifest({ stagingRoot: first, ...options })
  const secondManifest = await createArtifactManifest({ stagingRoot: second, ...options })
  assert.deepEqual(firstManifest, secondManifest)
  assert.equal(serializeArtifactManifest(firstManifest), serializeArtifactManifest(secondManifest))
  assert.deepEqual(firstManifest.artifacts.map(artifact => artifact.path), [
    'desktop/DSH-portable.exe',
    'desktop/DSH-setup.exe',
    'nested/a.txt',
    'nested/z.txt',
  ])
  assert.equal(firstManifest.totalBytes, 1 + 5 + 8 + 1)
})

test('missing required artifacts, traversal and non-regular entries fail closed', async t => {
  const root = await temporaryDirectory(t)
  const staging = await createStaging(root)
  await assert.rejects(
    createArtifactManifest({ stagingRoot: staging, requiredArtifacts: ['missing.exe'] }),
    /required artifact is missing/,
  )
  await assert.rejects(
    createArtifactManifest({ stagingRoot: staging, requiredArtifacts: ['..\\outside.exe'] }),
    /normalized relative POSIX path/,
  )
  await assert.rejects(
    createArtifactManifest({ stagingRoot: join(root, 'does-not-exist') }),
    /Cannot inspect stagingRoot/,
  )
})

test('symbolic links are rejected before their target can enter the manifest', async t => {
  const root = await temporaryDirectory(t)
  const staging = await createStaging(root)
  const outside = join(root, 'outside.txt')
  await writeFile(outside, 'outside', 'utf8')
  try {
    await symlink(outside, join(staging, 'escape.txt'), 'file')
  } catch (error) {
    if (['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`symbolic link creation is unavailable: ${error.code}`)
      return
    }
    throw error
  }
  await assert.rejects(createArtifactManifest({ stagingRoot: staging }), /unsupported symbolic link/)
})

test('CycloneDX and notices contain exact lock versions and only supplied metadata', async t => {
  const root = await temporaryDirectory(t)
  const paths = await createPackageInputs(root)
  const sbom = await createCycloneDxSbom(paths)
  assert.equal(sbom.bomFormat, 'CycloneDX')
  assert.equal(sbom.specVersion, '1.5')
  assert.deepEqual(sbom.components.map(component => `${component.name}@${component.version}`), [
    'dep-one@1.2.3',
    'dep-two@2.0.0',
  ])
  const depOne = sbom.components.find(component => component.name === 'dep-one')
  const depTwo = sbom.components.find(component => component.name === 'dep-two')
  assert.deepEqual(depOne.licenses, [{ license: { name: 'Apache-2.0' } }])
  assert.equal(depOne.externalReferences.some(reference => reference.type === 'vcs'), true)
  assert.equal(Object.hasOwn(depTwo, 'licenses'), false)
  assert.equal(Object.hasOwn(depTwo, 'externalReferences'), false)
  assert.match(createThirdPartyNotices(sbom), /dep-one@1\.2\.3/)
  assert.match(createThirdPartyNotices(sbom), /Apache-2\.0/)
  assert.match(createThirdPartyNotices(sbom), /dep-two@2\.0\.0/)
  assert.match(createThirdPartyNotices(sbom), /no license evidence was supplied/)
  assert.equal(serializeCanonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}\n')
})

test('release evidence is unsigned without a certificate and verifies after generation', async t => {
  const root = await temporaryDirectory(t)
  const stagingRoot = await createStaging(root)
  const inputs = await createPackageInputs(root)
  const outputDir = join(root, 'evidence')
  const result = await writeReleaseEvidence({
    ...inputs,
    stagingRoot,
    outputDir,
    setupPath: 'desktop/DSH-setup.exe',
    portablePath: 'desktop/DSH-portable.exe',
    exclude: ['ignored/**'],
  })
  assert.equal(result.evidence.signing.status, 'unsigned')
  assert.equal(result.evidence.artifacts.length, 2)
  assert.equal(await verifyReleaseEvidence({
    evidencePath: result.paths.evidencePath,
    artifactManifestPath: result.paths.artifactManifestPath,
    sbomPath: result.paths.sbomPath,
    noticesPath: result.paths.noticesPath,
    releaseManifestPath: inputs.releaseManifestPath,
    stagingRoot,
  }), true)
})

test('signed evidence carries only public verification material and verifies through the injected adapter', async t => {
  const root = await temporaryDirectory(t)
  const stagingRoot = await createStaging(root)
  const inputs = await createPackageInputs(root)
  const outputDir = join(root, 'signed-evidence')
  const verifier = input => input.publicVerificationKey.id === 'release-key-1' && input.signature.toString() === 'detached-signature'
  const result = await writeReleaseEvidence({
    ...inputs,
    stagingRoot,
    outputDir,
    setupPath: 'desktop/DSH-setup.exe',
    portablePath: 'desktop/DSH-portable.exe',
    publicVerificationKey: {
      id: 'release-key-1',
      material: 'PUBLIC-ED25519-KEY',
      algorithm: 'Ed25519',
    },
    detachedSignature: 'detached-signature',
    signatureVerifier: verifier,
  })
  assert.equal(result.evidence.signing.status, 'signed')
  assert.equal(result.evidence.signing.publicVerificationKey.id, 'release-key-1')
  assert.equal(Object.hasOwn(result.evidence.signing, 'privateKey'), false)
  assert.equal(await verifyReleaseEvidence({
    evidencePath: result.paths.evidencePath,
    artifactManifestPath: result.paths.artifactManifestPath,
    sbomPath: result.paths.sbomPath,
    noticesPath: result.paths.noticesPath,
    releaseManifestPath: inputs.releaseManifestPath,
    stagingRoot,
    detachedSignature: 'detached-signature',
    publicVerificationKey: {
      id: 'release-key-1',
      material: 'PUBLIC-ED25519-KEY',
      algorithm: 'Ed25519',
    },
    signatureVerifier: verifier,
  }), true)
  await assert.rejects(
    verifyReleaseEvidence({
      evidencePath: result.paths.evidencePath,
      artifactManifestPath: result.paths.artifactManifestPath,
      sbomPath: result.paths.sbomPath,
      noticesPath: result.paths.noticesPath,
      releaseManifestPath: inputs.releaseManifestPath,
      stagingRoot,
      detachedSignature: 'detached-signature',
      publicVerificationKey: { id: 'other-key', material: 'OTHER-PUBLIC-KEY', algorithm: 'Ed25519' },
      signatureVerifier: verifier,
    }),
    /does not match the trusted key/,
  )
})

test('staging tamper and malformed public signing fields fail closed', async t => {
  const root = await temporaryDirectory(t)
  const stagingRoot = await createStaging(root)
  const inputs = await createPackageInputs(root)
  const result = await generateReleaseEvidence({
    ...inputs,
    stagingRoot,
    setupPath: 'desktop/DSH-setup.exe',
    portablePath: 'desktop/DSH-portable.exe',
  })
  await writeFile(join(stagingRoot, 'desktop/DSH-setup.exe'), 'tampered', 'utf8')
  const artifactPath = join(root, 'artifact-manifest.json')
  const sbomPath = join(root, 'bom.cdx.json')
  const noticesPath = join(root, 'THIRD-PARTY-NOTICES.md')
  const evidencePath = join(root, 'release-evidence.json')
  await writeFile(artifactPath, serializeArtifactManifest(result.artifactManifest), 'utf8')
  await writeFile(sbomPath, serializeCanonicalJson(result.sbom), 'utf8')
  await writeFile(noticesPath, result.notices, 'utf8')
  await writeFile(evidencePath, serializeCanonicalJson(result.evidence), 'utf8')
  await assert.rejects(
    verifyReleaseEvidence({
      evidencePath,
      artifactManifestPath: artifactPath,
      sbomPath,
      noticesPath,
      releaseManifestPath: inputs.releaseManifestPath,
      stagingRoot,
    }),
    /staging content does not match artifact manifest/,
  )
  await assert.rejects(
    verifyDetachedSignature({
      data: 'release payload',
      detachedSignature: 'bad-signature',
      publicVerificationKey: { id: 'test-key', material: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----', privateKey: 'must reject' },
      verifier: () => true,
    }),
    /private or secret field/,
  )
})

test('detached signature adapters are injected and a wrong signature fails closed', async () => {
  const calls = []
  assert.equal(await verifyDetachedSignature({
    data: '{"a":1}\n',
    detachedSignature: Buffer.from('signature'),
    publicVerificationKey: { id: 'test-key', material: 'PUBLIC-KEY', algorithm: 'Ed25519' },
    verifier: input => {
      calls.push(input)
      return input.publicVerificationKey.id === 'test-key' && input.signature.toString() === 'signature'
    },
  }), true)
  assert.equal(calls.length, 1)
  assert.equal(Buffer.isBuffer(calls[0].data), true)
  await assert.rejects(
    verifyDetachedSignature({
      data: 'payload',
      detachedSignature: 'wrong',
      publicVerificationKey: { id: 'test-key', material: 'PUBLIC-KEY' },
      verifier: () => false,
    }),
    /verification failed/,
  )
})

test('built-in Ed25519 verification works without a custom verifier', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const data = Buffer.from('{"release":"fixture"}\n')
  const detachedSignature = sign(null, data, privateKey)
  const trustedKey = {
    id: 'fixture-ed25519',
    algorithm: 'Ed25519',
    material: publicKey.export({ type: 'spki', format: 'pem' }),
  }
  assert.equal(await verifyDetachedSignature({ data, detachedSignature, publicVerificationKey: trustedKey }), true)
  const tampered = Buffer.from(detachedSignature)
  tampered[0] ^= 0xff
  await assert.rejects(
    verifyDetachedSignature({ data, detachedSignature: tampered, publicVerificationKey: trustedKey }),
    /verification failed/,
  )
})
