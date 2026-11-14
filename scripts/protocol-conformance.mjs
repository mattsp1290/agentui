import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { aguiProtocol } from '@agentui/host/agui';
import { coverage } from '../tests/protocol/fixtures/coverage.mjs';
import { installedFixtures } from '../tests/protocol/fixtures/installed.mjs';

const root = new URL('../', import.meta.url);
const upstream = new URL('tests/protocol/fixtures/upstream/', root);
export const reportFile = new URL('docs/protocol/conformance.json', root);
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function table(file) {
  const [header, ...lines] = readFileSync(new URL(file, upstream), 'utf8').trimEnd().split('\n');
  const columns = header.split('\t');
  return lines.map((line) => Object.fromEntries(columns.map((column, index) => [column, line.split('\t')[index]])));
}

export function buildConformanceReport() {
  const provenance = json(new URL('provenance.json', upstream));
  for (const [file, input] of Object.entries(provenance.files)) {
    assert.equal(digest(readFileSync(new URL(file, upstream))), input.sha256, `Retained upstream input changed: ${file}`);
  }
  const pin = json(new URL('ag-ui-pin.json', upstream));
  const vendor = json(new URL('vendor/switchboard.json', root));
  const schema = json(new URL('schema.json', upstream));
  const definitions = table('ag-ui-matrix.tsv');
  const fixtures = table('upstream.tsv').map(({ path, sha256, typescriptAccepts, pythonAccepts }) => ({
    path, sha256, canonical: path.split('/')[1], typescriptAccepts: typescriptAccepts === 'true', pythonAccepts: pythonAccepts === 'true',
  }));
  const sdk = pin.artifacts.find((artifact) => artifact.package === '@ag-ui/core');
  const pythonSdk = pin.artifacts.find((artifact) => artifact.package === 'ag-ui-protocol');
  const lock = json(new URL('package-lock.json', root));
  const project = json(new URL('package.json', root));
  assert.equal(provenance.sources.switchboard.revision, vendor.sourceRevision);
  assert.equal(provenance.sources.canonical.revision, pin.sourceCommit);
  assert.equal(provenance.files['schema.json'].sha256, pin.upstreamFiles['spec/1.0/schema.json']);
  assert.equal(provenance.files['UPSTREAM-LICENSE'].sha256, pin.upstreamFiles.LICENSE);
  assert.equal(digest(readFileSync(new URL(`vendor/${vendor.artifact}`, root))), vendor.sha256);
  for (const workspace of ['packages/protocol', 'packages/host']) {
    assert.equal(json(new URL(`${workspace}/package.json`, root)).dependencies[sdk.package], sdk.version, workspace);
  }
  assert.equal(lock.packages['node_modules/@ag-ui/core'].version, sdk.version);
  assert.equal(lock.packages['node_modules/@ag-ui/core'].integrity, sdk.integrity);
  assert.deepEqual(aguiProtocol, {
    version: pin.protocol, sourceCommit: pin.sourceCommit, typescriptSdk: sdk.version, pythonSdk: pythonSdk.version,
    mapping: pin.classification.switchboardMapping, planned: 'reasoning-subagents',
  });
  assert.deepEqual(Object.keys(coverage).sort(), Object.keys(pin.categories).sort());
  assert.deepEqual(definitions.map((row) => row.definition).sort(), Object.keys(schema.$defs).sort());
  assert.equal(new Set(definitions.map((row) => row.definition)).size, definitions.length);
  assert.equal(new Set(fixtures.map((fixture) => fixture.path)).size, fixtures.length);
  const ownedIds = Object.keys(installedFixtures).sort();
  const referencedIds = [...new Set(Object.values(coverage).flatMap((row) => row.fixtures))].sort();
  assert.deepEqual(referencedIds, ownedIds, 'Every registered installed fixture must have a coverage owner');
  const categories = Object.entries(pin.categories).map(([category, purpose]) => {
    const rows = definitions.filter((row) => row.category === category);
    const names = rows.map((row) => row.definition);
    const owned = coverage[category];
    assert.ok(owned.pending.length > 0 && owned.pending.every((owner) => owner.length > 0), category);
    assert.ok(owned.fixtures.length > 0 || owned.contracts?.length > 0, category);
    for (const fixture of owned.contracts ?? []) assert.ok(existsSync(new URL(fixture.file, root)), fixture.file);
    return {
      category, purpose, definitions: names, eventDiscriminators: rows.flatMap((row) => row.event ? [row.event] : []),
      canonicalFixtures: fixtures.filter((fixture) => names.includes(fixture.path.split('/')[0])),
      mapping: owned.mapping, scope: owned.scope, installedFixtures: owned.fixtures, contractFixtures: owned.contracts ?? [],
      nativeAvailability: 'undeclared', nativeQualification: 'unqualified', pendingProductOwners: owned.pending,
    };
  });
  assert.equal(categories.flatMap((row) => row.definitions).length, definitions.length);
  assert.equal(categories.flatMap((row) => row.canonicalFixtures).length, fixtures.length);
  return {
    coverageContractVersion: 1,
    canonical: {
      version: pin.protocol, sourceCommit: pin.sourceCommit, typescriptSdk: sdk.version, pythonSdk: pythonSdk.version,
      authority: 'Retained closed canonical schema. SDK acceptance never changes canonical validity.',
      definitionCoverageOwner: { source: vendor.sourceRevision, matrix: 'docs/protocol/ag-ui-matrix.tsv', verifier: pin.ownership.schemaTest },
      fixtureCoverageOwner: { source: vendor.sourceRevision, index: pin.ownership.schemaFixtures, python: pin.ownership.pythonTest },
      counts: { categories: categories.length, definitions: definitions.length, eventDiscriminators: categories.flatMap((row) => row.eventDiscriminators).length,
        fixtures: fixtures.length, valid: fixtures.filter((fixture) => fixture.canonical === 'valid').length,
        invalid: fixtures.filter((fixture) => fixture.canonical === 'invalid').length,
        typescriptPermissiveInvalid: fixtures.filter((fixture) => fixture.canonical === 'invalid' && fixture.typescriptAccepts).length,
        pythonPermissiveInvalid: fixtures.filter((fixture) => fixture.canonical === 'invalid' && fixture.pythonAccepts).length },
    },
    switchboard: {
      repository: vendor.sourceRepository, sourceRevision: vendor.sourceRevision, artifact: vendor.artifact, sha256: vendor.sha256,
      descriptor: aguiProtocol,
      nativeRoutes: Object.fromEntries(Object.entries(pin.classification.nativeAdapters).map(([route, qualification]) => [route, { availability: 'undeclared', qualification }])),
      retainedCanonicalComparison: { log: `vendor/${vendor.qualification.logs['verify-agui'].path}`, scope: 'Historical canonical schema and published SDK comparison; not native or installed AgentUI output.' },
    },
    agentuiCanonicalValidator: { package: 'ajv', version: project.devDependencies.ajv, schema: 'tests/protocol/fixtures/upstream/schema.json', definition: 'Event' },
    installedFixtures: ownedIds.map((id) => ({ id, file: 'tests/protocol/conformance.test.mjs', test: `protocol installed fixture: ${id}` })),
    behaviorLimits: {
      unknownOrUnimplementedFact: 'Explicit error and faulted actor; no successful empty batch.',
      notObservable: 'Acknowledged absence for an allowed family; empty batch and usable actor.',
      qualification: 'Fixture registration and retained evidence inventory are not current execution results or native qualification.',
      downstream: 'Provider operation contracts/admission: agentui-k4zj/agentui-7s6y. Full native, transport/replay and UI qualification: agentui-ckpw.',
    },
    provenance, categories,
  };
}

export const serializeConformanceReport = () => `${JSON.stringify(buildConformanceReport(), null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--check'), 'Usage: node scripts/protocol-conformance.mjs [--check]');
  const report = serializeConformanceReport();
  if (process.argv[2] === '--check') assert.equal(readFileSync(reportFile, 'utf8'), report, 'Conformance report is stale; regenerate it');
  else writeFileSync(reportFile, report);
  console.log(process.argv[2] === '--check' ? 'Protocol conformance report matches its versioned inputs.' : 'Wrote docs/protocol/conformance.json.');
}
