import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { digest, forkFile, parseJson } from './agui-fork/bytes.mjs';
import { resolveLockedFork } from './agui-fork/identity.mjs';
import { verifyArchive } from './agui-fork/archives.mjs';
import { verifyLedger } from './agui-fork/ledger.mjs';

const aguiPackages = ['core', 'proto', 'encoder', 'client', 'codex-sdk', 'pi'].map((name) => `@ag-ui/${name}`);

export const OFFLINE_RECORD_SCOPE = 'retained archives, evidence, source lock, fixtures and frozen consumer lock; no install';

export const consumerScripts = ['all-imports.mjs', 'codex-esm.mjs', 'codex-commonjs.cjs']
  .map((name) => `tests/dependencies/ag-ui/${name}`);

export function measureVerifierSources(root) {
  const library = readdirSync(join(root, 'scripts/lib/agui-fork')).filter((name) => name.endsWith('.mjs')).sort()
    .map((name) => `scripts/lib/agui-fork/${name}`);
  const bytes = new Map(['scripts/lib/agui-fork.mjs', 'scripts/verify-agui-fork.mjs', ...library, ...consumerScripts]
    .map((file) => [file, readFileSync(join(root, file))]));
  return { bytes, sha256: Object.fromEntries([...bytes].map(([file, body]) => [file, digest(body)])) };
}

export async function writeConsumerScripts(directory, sources) {
  for (const file of consumerScripts) {
    assert.ok(sources.bytes.has(file), `consumer script ${file} was not measured`);
    await writeFile(join(directory, basename(file)), sources.bytes.get(file));
  }
}

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
  const ledger = verifyLedger(fork, readFileSync(forkFile(fork.folder, 'qualification.json')));
  assert.deepEqual(fork.metadata.artifacts.map((artifact) => artifact.package).toSorted(), aguiPackages.toSorted(), 'exact six AG-UI archives');
  const packages = new Map();
  for (const artifact of fork.metadata.artifacts) {
    assert.ok(!packages.has(artifact.package), `duplicate artifact ${artifact.package}`);
    packages.set(artifact.package, verifyArchive(fork.folder, artifact));
  }
  const fixtures = verifyFixtures(fork);
  return { ...fork, packages, ...fixtures, ledger };
}
