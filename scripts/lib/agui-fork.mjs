import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { digest, forkFile, parseJson } from './agui-fork/bytes.mjs';
import { resolveLockedFork } from './agui-fork/identity.mjs';
import { verifyArchive } from './agui-fork/archives.mjs';
import { verifyEvidence } from './agui-fork/ledger.mjs';

const aguiPackages = ['core', 'proto', 'encoder', 'client', 'codex-sdk', 'pi'].map((name) => `@ag-ui/${name}`);

function countByteLines(body) {
  if (body.length === 0) return 0;
  const lines = body.toString('latin1').split(/\r\n|\n|\r/u);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
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
  const ledgerKeys = ['sourceRevision', 'identityProvenanceSha256', 'knownLimitations', 'nodeReplays', 'evidence', 'metadataHistory'];
  assert.deepEqual(Object.keys(qualification).filter((key) => !ledgerKeys.includes(key)), [], 'unexpected qualification ledger fields');
  assert.equal(qualification.sourceRevision, fork.metadata.sourceRevision, 'qualification source revision');
  assert.equal(qualification.identityProvenanceSha256, fork.provenanceSha256, 'qualification identity digest');
  assert.deepEqual(fork.metadata.artifacts.map((artifact) => artifact.package).toSorted(), aguiPackages.toSorted(), 'exact six AG-UI archives');
  const packages = new Map();
  for (const artifact of fork.metadata.artifacts) {
    assert.ok(!packages.has(artifact.package), `duplicate artifact ${artifact.package}`);
    packages.set(artifact.package, verifyArchive(fork.folder, artifact));
  }
  verifyEvidence(fork, qualification);
  const fixtures = verifyFixtures(fork);
  return { ...fork, packages, ...fixtures, qualificationSha256: digest(qualificationBody) };
}
