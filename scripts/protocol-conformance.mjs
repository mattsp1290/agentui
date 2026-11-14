import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aguiProtocol } from '@agentui/host/agui';
import { coverage, coverageContract, installedFixtureFile, installedFixtureIds, installedFixtureTest } from '../tests/protocol/fixtures/coverage.mjs';

const root = new URL('../', import.meta.url);
const upstream = new URL('tests/protocol/fixtures/upstream/', root);
export const reportFile = new URL('docs/protocol/conformance.json', root);
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const retainedPath = (file) => relative(fileURLToPath(root), fileURLToPath(new URL(file, upstream))).split(sep).join('/');

function table(file) {
  const [header, ...lines] = readFileSync(new URL(file, upstream), 'utf8').trimEnd().split('\n');
  const columns = header.split('\t');
  return lines.map((line) => {
    const cells = line.split('\t');
    assert.equal(cells.length, columns.length, `${file}: ${line}`);
    return Object.fromEntries(columns.map((column, index) => [column, cells[index]]));
  });
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
  for (const fixture of fixtures) assert.ok(['valid', 'invalid'].includes(fixture.canonical), fixture.path);
  const sdk = pin.artifacts.find((artifact) => artifact.package === '@ag-ui/core');
  const pythonSdk = pin.artifacts.find((artifact) => artifact.package === 'ag-ui-protocol');
  const lock = json(new URL('package-lock.json', root));
  const project = json(new URL('package.json', root));
  assert.equal(provenance.sources.switchboard.revision, vendor.sourceRevision);
  assert.equal(provenance.sources.canonical.revision, pin.sourceCommit);
  assert.equal(provenance.files['schema.json'].sha256, pin.upstreamFiles['spec/1.0/schema.json']);
  assert.equal(provenance.files['UPSTREAM-LICENSE'].sha256, pin.upstreamFiles.LICENSE);
  assert.equal(digest(readFileSync(new URL('node_modules/@mattsp1290/switchboard/LICENSE', root))), provenance.files['SWITCHBOARD-LICENSE'].sha256);
  for (const workspace of ['packages/protocol', 'packages/host']) {
    assert.equal(json(new URL(`${workspace}/package.json`, root)).dependencies[sdk.package], sdk.version, workspace);
  }
  assert.equal(lock.packages['node_modules/@ag-ui/core'].version, sdk.version);
  assert.equal(lock.packages['node_modules/@ag-ui/core'].integrity, sdk.integrity);
  assert.equal(lock.packages['node_modules/ajv'].version, project.devDependencies.ajv);
  assert.deepEqual(aguiProtocol, {
    version: pin.protocol, sourceCommit: pin.sourceCommit, typescriptSdk: sdk.version, pythonSdk: pythonSdk.version,
    mapping: pin.classification.switchboardMapping, planned: coverageContract.plannedFamilies.join('-'),
  });
  assert.deepEqual(Object.keys(coverage).sort(), Object.keys(pin.categories).sort());
  assert.deepEqual(definitions.map((row) => row.definition).sort(), Object.keys(schema.$defs).sort());
  assert.deepEqual(definitions.flatMap((row) => row.event ? [row.event] : []).sort(), [...schema.$defs.EventType.enum].sort());
  assert.equal(new Set(definitions.map((row) => row.definition)).size, definitions.length);
  assert.equal(new Set(fixtures.map((fixture) => fixture.path)).size, fixtures.length);
  assert.ok(existsSync(new URL(installedFixtureFile, root)), installedFixtureFile);
  const categories = Object.entries(pin.categories).map(([category, purpose]) => {
    const rows = definitions.filter((row) => row.category === category);
    const names = rows.map((row) => row.definition);
    const owned = coverage[category];
    const canonicalFixtures = fixtures.filter((fixture) => names.includes(fixture.path.split('/')[0]));
    assert.ok(['represented', 'partial', 'planned', 'wire-only'].includes(owned.mapping), category);
    assert.ok(owned.pending.length > 0 && owned.pending.every((owner) => owner.length > 0), category);
    assert.ok(owned.fixtures.length > 0 || owned.contracts.length > 0, category);
    for (const fixture of owned.contracts) assert.ok(existsSync(new URL(fixture.file, root)), fixture.file);
    return {
      category, purpose, definitions: names, canonicalEventDiscriminators: rows.flatMap((row) => row.event ? [row.event] : []),
      canonicalFixtures: canonicalFixtures.map((fixture) => fixture.path),
      sdkDivergences: canonicalFixtures.filter((fixture) => [fixture.typescriptAccepts, fixture.pythonAccepts].some((accepted) => accepted !== (fixture.canonical === 'valid')))
        .map(({ path, typescriptAccepts, pythonAccepts }) => ({ path, typescriptAccepts, pythonAccepts })),
      mapping: owned.mapping, scope: owned.scope, installedFixtures: owned.fixtures, contractFixtures: owned.contracts,
      pendingProductOwners: owned.pending,
    };
  });
  assert.equal(categories.flatMap((row) => row.definitions).length, definitions.length);
  assert.equal(categories.flatMap((row) => row.canonicalFixtures).length, fixtures.length);
  return {
    coverageContractVersion: coverageContract.version,
    canonical: {
      version: pin.protocol, sourceCommit: pin.sourceCommit, typescriptSdk: sdk.version, pythonSdk: pythonSdk.version,
      authority: coverageContract.authority,
      definitionCoverageOwner: { repository: vendor.sourceRepository, source: vendor.sourceRevision,
        matrix: provenance.files['ag-ui-matrix.tsv'].path, retained: retainedPath('ag-ui-matrix.tsv'), verifier: pin.ownership.schemaTest },
      fixtureCoverageOwner: { repository: vendor.sourceRepository, source: vendor.sourceRevision,
        index: provenance.files['upstream.tsv'].path, retained: retainedPath('upstream.tsv'), python: pin.ownership.pythonTest },
      counts: { categories: categories.length, definitions: definitions.length, eventDiscriminators: categories.flatMap((row) => row.canonicalEventDiscriminators).length,
        fixtures: fixtures.length, valid: fixtures.filter((fixture) => fixture.canonical === 'valid').length,
        invalid: fixtures.filter((fixture) => fixture.canonical === 'invalid').length,
        typescriptPermissiveInvalid: fixtures.filter((fixture) => fixture.canonical === 'invalid' && fixture.typescriptAccepts).length,
        pythonPermissiveInvalid: fixtures.filter((fixture) => fixture.canonical === 'invalid' && fixture.pythonAccepts).length,
        typescriptRestrictiveValid: fixtures.filter((fixture) => fixture.canonical === 'valid' && !fixture.typescriptAccepts).length,
        pythonRestrictiveValid: fixtures.filter((fixture) => fixture.canonical === 'valid' && !fixture.pythonAccepts).length },
      sdkRuntimeEvidence: { kind: coverageContract.sdkRuntimeEvidenceKind,
        typescript: { package: sdk.package, version: sdk.version, validator: 'zod', validatorVersion: pin.verifierTools.zod },
        python: { package: pythonSdk.package, version: pythonSdk.version, validator: 'pydantic', validatorVersion: pin.verifierTools.pydantic },
        publishedTypes: coverageContract.publishedTypeEvidence },
    },
    switchboard: {
      repository: vendor.sourceRepository, sourceRevision: vendor.sourceRevision, artifact: vendor.artifact, sha256: vendor.sha256,
      descriptor: aguiProtocol,
      retainedCanonicalComparison: { log: `vendor/${vendor.qualification.logs['verify-agui'].path}`, scope: coverageContract.canonicalComparisonScope },
    },
    nativeEvidence: {
      availability: coverageContract.nativeAvailability, declarationScope: coverageContract.nativeDeclarationScope,
      qualificationsByRoute: pin.classification.nativeAdapters,
    },
    agentuiCanonicalValidator: { package: 'ajv', version: project.devDependencies.ajv, schema: retainedPath('schema.json'),
      emittedEventDefinition: 'Event', contractDefinitions: ['RunAgentInput', 'AgentCapabilities'], file: installedFixtureFile,
      tests: [coverageContract.validatorControlTest, coverageContract.requestControlTest] },
    installedFixtures: installedFixtureIds.map((id) => ({ id, file: installedFixtureFile, test: installedFixtureTest(id) })),
    behaviorLimits: coverageContract.behaviorLimits,
    retainedInputs: {
      [retainedPath('provenance.json')]: digest(readFileSync(new URL('provenance.json', upstream))),
      ...Object.fromEntries(Object.entries(provenance.files).map(([file, input]) => [retainedPath(file), input.sha256])),
    },
    categories,
  };
}

export const serializeConformanceReport = (report) => `${JSON.stringify(report, null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--check'), 'Usage: node scripts/protocol-conformance.mjs [--check]');
  const report = serializeConformanceReport(buildConformanceReport());
  if (process.argv[2] === '--check') assert.equal(readFileSync(reportFile, 'utf8'), report, 'Conformance report is stale; regenerate it');
  else writeFileSync(reportFile, report);
  console.log(process.argv[2] === '--check' ? 'Protocol conformance report matches its versioned inputs.' : 'Wrote docs/protocol/conformance.json.');
}
