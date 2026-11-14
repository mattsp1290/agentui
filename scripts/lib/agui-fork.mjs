import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, lstatSync } from 'node:fs';
import { isAbsolute, join, basename, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const fullConsumerScope = 'controlled package consumer; no native provider or Apple qualification';

const parseJson = (body) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
const readJson = (path) => parseJson(readFileSync(path));
const digest = (body, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(body).digest(encoding);
const printableAsciiWithoutBackslash = /^[\x20-\x5b\x5d-\x7e]+$/u;

function forkFile(folder, file) {
  const target = resolve(folder, file);
  const local = relative(folder, target);
  assert.ok(!isAbsolute(file) && local !== '' && local !== '..' && !local.startsWith(`..${sep}`), `${file}: must stay inside the fork folder`);
  return target;
}

export function resolveLockedFork(root) {
  assert.ok(typeof root === 'string' && isAbsolute(root), 'fork root must be an absolute filesystem path');
  const locked = readJson(join(root, 'package-lock.json')).packages?.['node_modules/@ag-ui/core'];
  assert.ok(locked, 'root lock must contain @ag-ui/core');
  const match = /^file:(vendor\/ag-ui\/([a-f0-9]{40})\/)([^/]+\.tgz)$/u.exec(locked.resolved);
  assert.ok(match, 'SDK must resolve to a local fork archive');
  const [, directory, revision, archive] = match;
  const provenancePath = `${directory}provenance.json`;
  const bytes = readFileSync(join(root, provenancePath));
  const metadata = parseJson(bytes);
  assert.ok(metadata && Array.isArray(metadata.artifacts) && Array.isArray(metadata.evidence)
    && metadata.qualification && typeof metadata.qualification === 'object' && !Array.isArray(metadata.qualification),
    'fork metadata must declare artifacts and evidence arrays and a qualification object');
  assert.equal(metadata.sourceRevision, revision, 'fork source revision must match its directory');
  assert.equal(metadata.sourceRepository, 'https://github.com/mattsp1290/ag-ui', 'fork source repository');
  assert.equal(metadata.sourceBranch, 'matt.spurlin/typescript-sdks', 'fork source branch');
  assert.equal(metadata.sourcePullRequest, 'https://github.com/mattsp1290/ag-ui/pull/49', 'fork pull request');
  const core = metadata.artifacts.find((artifact) => artifact.package === '@ag-ui/core');
  assert.ok(core, 'fork metadata must contain @ag-ui/core');
  assert.equal(core.artifact, archive, 'fork core archive');
  assert.equal(locked.integrity, core.npmIntegrity, 'fork lock integrity');
  assert.equal(locked.version, core.version, 'fork lock version');
  for (const workspace of ['packages/protocol', 'packages/host']) {
    assert.equal(readJson(join(root, workspace, 'package.json')).dependencies?.['@ag-ui/core'],
      `file:../../${directory}${archive}`, `${workspace}: fork dependency`);
  }
  return {
    folder: join(root, directory), provenancePath, metadata, core,
    provenanceSha256: digest(bytes),
  };
}

const aguiPackages = ['core', 'proto', 'encoder', 'client', 'codex-sdk', 'pi'].map((name) => `@ag-ui/${name}`);
const nativeVersions = {
  '@openai/codex-sdk': '0.167.1', '@openai/codex': '0.167.1',
  '@earendil-works/pi-agent-core': '1.5.0', '@earendil-works/pi-ai': '1.5.0',
  '@earendil-works/pi-coding-agent': '1.5.0', zod: '3.25.76',
};
const donorNotices = {
  '@ag-ui/pi': {
    copyright: 'Copyright (c) 2026 YS-BW', member: 'package/PROVENANCE.md',
    retained: 'notices/ag-ui-pi.PROVENANCE.md', revision: 'ee810dfb9ad3fe81d8854e9121b84ddee4c59148',
  },
};
const codexVersion = nativeVersions['@openai/codex'];
function tar(args, label) {
  const env = { ...process.env, LC_ALL: 'C' };
  for (const key of ['TAR_OPTIONS', 'TAR_READER_OPTIONS', 'TAR_WRITER_OPTIONS', 'GZIP', 'TAPE']) delete env[key];
  try {
    return execFileSync('tar', args, {
      env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    throw new Error(`tar ${args.join(' ')} failed for ${label}`, { cause });
  }
}
export const tarVersion = () => tar(['--version'], 'version probe').toString('utf8').split('\n')[0];

function countByteLines(body) {
  if (body.length === 0) return 0;
  const lines = body.toString('latin1').split(/\r\n|\n|\r/u);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}
function extractOnce(archive, members, member) {
  assert.equal(members.filter((name) => name === member).length, 1, `${archive}: ${member} must occur exactly once`);
  return tar(['-xzOf', archive, member], archive);
}
function verifyArchive(folder, artifact) {
  assert.equal(basename(artifact.artifact), artifact.artifact, 'archive must be inside fork folder');
  const archive = forkFile(folder, artifact.artifact);
  const body = readFileSync(archive);
  assert.equal(body.length, artifact.bytes, `${archive}: bytes`);
  assert.equal(digest(body), artifact.sha256, `${archive}: sha256`);
  assert.equal(digest(body, 'sha512'), artifact.sha512, `${archive}: sha512`);
  const integrity = `sha512-${digest(body, 'sha512', 'base64')}`;
  assert.equal(integrity, artifact.npmIntegrity, `${archive}: integrity`);
  assert.ok(artifact.members.every((member) => printableAsciiWithoutBackslash.test(member)), `${archive}: members must be printable ASCII without backslashes`);
  const listing = tar(['-tzf', archive], archive).toString('utf8');
  assert.ok(listing.endsWith('\n'), `${archive}: member listing must end with a newline`);
  const members = listing.slice(0, -1).split('\n');
  assert.deepEqual(members, artifact.members, `${archive}: ordered members`);
  const manifest = parseJson(extractOnce(archive, members, 'package/package.json'));
  assert.equal(manifest.name, artifact.package, `${archive}: package identity`);
  assert.deepEqual(manifest, artifact.packedManifest, `${archive}: packed manifest`);
  assert.equal(manifest.version, artifact.version, `${archive}: artifact version`);
  assert.ok(!JSON.stringify(manifest).includes('workspace:'), `${archive}: workspace reference`);
  assert.equal(manifest.license, 'MIT', `${archive}: license`);
  const prefix = artifact.package.replace('@', '').replace('/', '-');
  assert.deepEqual(manifest, readJson(forkFile(folder, `manifests/${prefix}.json`)), `${archive}: retained manifest`);
  const notice = extractOnce(archive, members, 'package/LICENSE');
  assert.deepEqual(notice, readFileSync(forkFile(folder, `notices/${prefix}.LICENSE`)), `${archive}: retained license`);
  assert.ok(notice.includes(Buffer.from('MIT License')), `${archive}: MIT notice`);
  const donor = donorNotices[artifact.package];
  if (donor) {
    assert.ok(notice.includes(Buffer.from(donor.copyright)), `${archive}: donor copyright`);
    const provenance = extractOnce(archive, members, donor.member);
    assert.deepEqual(provenance, readFileSync(forkFile(folder, donor.retained)), `${archive}: donor notice`);
    assert.ok(provenance.includes(Buffer.from(donor.revision)), `${archive}: donor revision`);
  }
  return { filename: artifact.artifact, integrity, manifest };
}
const replayKeys = {
  'coordinator-observed': ['kind', 'log', 'measuredBase', 'sourceSha256', 'note'],
  'self-reported': ['kind', 'log', 'measuredBase', 'note'],
};
function verifyReplay(replay, raws, sourceRevision) {
  assert.ok(replay && typeof replay === 'object' && !Array.isArray(replay), 'replay must be an index record');
  const allowed = Object.hasOwn(replayKeys, replay.kind) ? replayKeys[replay.kind] : undefined;
  assert.ok(allowed, `${replay.log}: unknown replay kind`);
  assert.deepEqual(Object.keys(replay).filter((key) => !allowed.includes(key)), [], `${replay.log}: unexpected replay fields`);
  assert.ok(typeof replay.log === 'string' && raws.has(replay.log), `${replay.log}: replay log must be verified evidence`);
  assert.ok(typeof replay.measuredBase === 'string' && /^[a-f0-9]{40}$/u.test(replay.measuredBase), `${replay.log}: replay base must be a full commit SHA`);
  assert.ok(replay.note === undefined || typeof replay.note === 'string', `${replay.log}: replay note must be a string`);
  let report;
  if (replay.kind === 'self-reported') {
    const reports = [];
    for (const line of new TextDecoder('utf-8', { fatal: true }).decode(raws.get(replay.log)).split(/\r?\n/u)) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.scope === fullConsumerScope) reports.push(entry);
    }
    assert.equal(reports.length, 1, `${replay.log}: exactly one full consumer record is required`);
    [report] = reports;
    assert.equal(report.result, 'PASS', `${replay.log}: full consumer result`);
    assert.equal(report.sourceRevision, sourceRevision, `${replay.log}: full consumer source revision`);
  }
  const hashes = replay.kind === 'self-reported' ? report.sourceSha256 : replay.sourceSha256;
  assert.ok(hashes && typeof hashes === 'object' && !Array.isArray(hashes)
    && Object.keys(hashes).length > 0, `${replay.log}: replay source hashes must be a nonempty map`);
  for (const [file, hash] of Object.entries(hashes)) {
    assert.ok(typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash), `${replay.log}: ${file}: replay source digest`);
  }
  return replay.kind === 'self-reported' ? { ...replay, report } : replay;
}
function verifyEvidence({ folder, metadata }, qualification) {
  const raws = new Map();
  for (const entry of [...metadata.evidence, ...qualification.evidence]) {
    assert.ok(!raws.has(entry.path), `${entry.path}: duplicate evidence path`);
    const packed = readFileSync(forkFile(folder, entry.path));
    assert.equal(packed.length, entry.compressedBytes, `${entry.path}: compressed bytes`);
    assert.equal(digest(packed), entry.compressedSha256, `${entry.path}: compressed hash`);
    const raw = gunzipSync(packed);
    assert.equal(raw.length, entry.rawBytes, `${entry.path}: raw bytes`);
    assert.equal(raw.length, entry.retainedBytes, `${entry.path}: retained bytes`);
    assert.equal(digest(raw), entry.rawSha256, `${entry.path}: raw hash`);
    assert.equal(digest(raw), entry.retainedSha256, `${entry.path}: retained hash`);
    raws.set(entry.path, raw);
  }
  const sourceLock = 'evidence/source-pnpm-lock.yaml.gz';
  assert.ok(raws.has(sourceLock), 'source lock must be verified evidence');
  assert.equal(digest(raws.get(sourceLock)), metadata.sourceLockSha256, 'source lock digest');
  assert.ok(raws.has(qualification.metadataHistory), `${qualification.metadataHistory}: metadata history must be verified evidence`);
  for (const limitation of qualification.knownLimitations) {
    for (const field of ['failureEvidence', 'reproductionEvidence']) {
      assert.ok(raws.has(limitation[field]), `${limitation[field]}: limitation ${field} must be verified evidence`);
    }
  }
  return qualification.nodeReplays.map((replay) => verifyReplay(replay, raws, metadata.sourceRevision));
}
function verifyFixtures({ folder, metadata }) {
  const fixtureBody = readFileSync(forkFile(folder, metadata.qualification.fixtureProvenance));
  assert.equal(digest(fixtureBody), metadata.qualification.fixtureProvenanceSha256, 'fixture provenance digest');
  const fixtures = parseJson(fixtureBody);
  assert.equal(fixtures.sourceRevision, metadata.sourceRevision, 'fixture source revision');
  assert.ok(fixtures.unchangedSourceCopies, 'fixtures must be unchanged source copies');
  const fixturePaths = fixtures.files.map((fixture) => fixture.path);
  assert.equal(new Set(fixturePaths).size, fixturePaths.length, 'fixture paths must be unique');
  const codexFixture = 'qualification-fixtures/codex/codex-exec.mjs';
  assert.ok(fixturePaths.includes(codexFixture), 'controlled Codex executable must be a verified fixture');
  for (const fixture of fixtures.files) {
    const body = readFileSync(forkFile(folder, fixture.path));
    assert.equal(digest(body), fixture.sha256, `${fixture.path}: fixture hash`);
    assert.equal(body.length, fixture.bytes, `${fixture.path}: fixture bytes`);
    assert.equal(countByteLines(body), fixture.rawLines, `${fixture.path}: fixture lines`);
  }
  return { fixturePaths, codexFixture };
}
export function verifyFork(root) {
  const fork = resolveLockedFork(root);
  const qualificationBody = readFileSync(forkFile(fork.folder, 'qualification.json'));
  const qualification = parseJson(qualificationBody);
  assert.ok(qualification && Array.isArray(qualification.evidence) && Array.isArray(qualification.nodeReplays)
    && Array.isArray(qualification.knownLimitations), 'qualification ledger must declare evidence, nodeReplays and knownLimitations arrays');
  assert.equal(qualification.sourceRevision, fork.metadata.sourceRevision, 'qualification source revision');
  assert.equal(qualification.identityProvenanceSha256, fork.provenanceSha256, 'qualification identity digest');
  assert.deepEqual(fork.metadata.artifacts.map((artifact) => artifact.package).toSorted(), aguiPackages.toSorted(), 'exact six AG-UI archives');
  const packages = new Map();
  for (const artifact of fork.metadata.artifacts) {
    assert.ok(!packages.has(artifact.package), `duplicate artifact ${artifact.package}`);
    packages.set(artifact.package, verifyArchive(fork.folder, artifact));
  }
  const replays = verifyEvidence(fork, qualification);
  const fixtures = verifyFixtures(fork);
  return { ...fork, packages, ...fixtures, qualification, qualificationSha256: digest(qualificationBody), replays };
}
export function verifyConsumerLock(consumer, verified) {
  const { metadata, packages: expected } = verified;
  const lockBody = readFileSync(join(consumer, 'package-lock.json'));
  const manifestBody = readFileSync(join(consumer, 'package.json'));
  assert.equal(digest(lockBody), metadata.qualification.consumerLockSha256, 'frozen consumer lock digest');
  assert.equal(digest(manifestBody), metadata.qualification.consumerPackageSha256, 'frozen consumer manifest digest');
  const lock = parseJson(lockBody);
  const manifest = parseJson(manifestBody);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies, 'consumer root dependencies');
  const seen = new Set();
  for (const [path, entry] of Object.entries(lock.packages)) {
    const name = path.split('node_modules/').at(-1);
    if (!name.startsWith('@ag-ui/') && !entry.name?.startsWith('@ag-ui/')) continue;
    assert.ok(expected.has(name) && !seen.has(name), `${path}: unexpected or repeated AG-UI package`);
    assert.equal(path, `node_modules/${name}`, `${path}: nested or aliased AG-UI`);
    assert.ok(!entry.name || entry.name === name, `${path}: aliased AG-UI identity`);
    const packed = expected.get(name);
    assert.equal(entry.resolved, `file:../artifacts/${packed.filename}`, `${path}: resolution`);
    assert.equal(manifest.dependencies[name], entry.resolved, `${path}: manifest resolution`);
    assert.equal(entry.integrity, packed.integrity, `${path}: integrity`);
    seen.add(name);
  }
  assert.deepEqual([...seen].sort(), [...expected.keys()].sort(), 'consumer AG-UI package set');
  for (const [name, version] of Object.entries(nativeVersions)) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name}: locked native version`);
    assert.equal(manifest.dependencies[name], version, `${name}: native dependency`);
  }
  for (const os of ['darwin', 'linux', 'win32']) for (const arch of ['arm64', 'x64']) {
    const entry = lock.packages[`node_modules/@openai/codex-${os}-${arch}`];
    assert.ok(entry?.optional, `${os}-${arch}: optional Codex payload declaration`);
    assert.equal(entry.version, `${codexVersion}-${os}-${arch}`, `${os}-${arch}: optional Codex payload version`);
  }
}
function* packageRoots(modules) {
  if (!existsSync(modules) || !lstatSync(modules).isDirectory()) return;
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(modules, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      yield* packageRoots(path);
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const manifest = join(path, 'package.json');
    if (existsSync(manifest)) yield { root: path, manifest, linked: entry.isSymbolicLink() };
    if (entry.isDirectory()) yield* packageRoots(join(path, 'node_modules'));
  }
}
export function verifyInstalled(consumer, verified) {
  const { packages: expected } = verified;
  const installed = new Set();
  for (const { root, manifest, linked } of packageRoots(join(consumer, 'node_modules'))) {
    const body = readJson(manifest);
    const name = relative(consumer, root).split('node_modules/').at(-1);
    if (!body.name?.startsWith('@ag-ui/') && !name.startsWith('@ag-ui/')) continue;
    assert.ok(!linked, `${root}: linked AG-UI root`);
    assert.ok(expected.has(body.name) && !installed.has(body.name), `${root}: unexpected or repeated AG-UI`);
    assert.equal(relative(consumer, root), `node_modules/${body.name}`, `${root}: nested or aliased AG-UI`);
    assert.deepEqual(body, expected.get(body.name).manifest, `${root}: packed manifest`);
    installed.add(body.name);
  }
  assert.deepEqual([...installed].sort(), [...expected.keys()].sort(), 'installed AG-UI package set');
  for (const [name, version] of Object.entries(nativeVersions)) {
    assert.equal(readJson(join(consumer, 'node_modules', name, 'package.json')).version, version, `${name}: installed native version`);
  }
  const native = join(consumer, 'node_modules/@openai', `codex-${process.platform}-${process.arch}`);
  assert.equal(readJson(join(native, 'package.json')).version, `${codexVersion}-${process.platform}-${process.arch}`, 'installed optional Codex package');
  assert.ok(readdirSync(join(native, 'vendor'), { recursive: true }).some((path) => basename(path) === 'codex'), 'optional native Codex CLI payload absent');
}
