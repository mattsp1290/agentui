import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { aguiProtocol } from '@agentui/host/agui';
import { behaviorLimits, canonicalDefinitions, coverage, coverageContractVersion, projectionFacts, reportText } from '../tests/protocol/coverage.mjs';
import { evidenceKinds, validateCoverage } from '../tests/protocol/evidence.mjs';

const root = new URL('../', import.meta.url);
const retainedDir = 'tests/protocol/fixtures/upstream/';
const upstream = new URL(retainedDir, root);
export const reportFile = new URL('docs/protocol/conformance.json', root);
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const retainedPath = (file) => `${retainedDir}${file}`;

function table(file) {
  const [header, ...lines] = readFileSync(new URL(file, upstream), 'utf8').trimEnd().split('\n');
  const columns = header.split('\t');
  return lines.map((line) => {
    const cells = line.split('\t');
    assert.equal(cells.length, columns.length, `${file}: ${line}`);
    return Object.fromEntries(columns.map((column, index) => [column, cells[index]]));
  });
}

function verifiedInputs() {
  const provenance = json(new URL('provenance.json', upstream));
  for (const [file, input] of Object.entries(provenance.files)) {
    assert.equal(digest(readFileSync(new URL(file, upstream))), input.sha256, `Retained upstream input changed: ${file}`);
  }
  const pin = json(new URL('ag-ui-pin.json', upstream));
  const vendor = json(new URL('vendor/switchboard.json', root));
  const schema = json(new URL('schema.json', upstream));
  const definitions = table('ag-ui-matrix.tsv');
  const fixtures = table('upstream.tsv').map(({ path, typescriptAccepts, pythonAccepts }) => {
    const [definition, validity] = path.split('/');
    assert.ok(['valid', 'invalid'].includes(validity), path);
    return { path, definition, valid: validity === 'valid', typescriptAccepts: typescriptAccepts === 'true', pythonAccepts: pythonAccepts === 'true' };
  });
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
  assert.equal(json(new URL('node_modules/@ag-ui/core/package.json', root)).version, sdk.version);
  assert.equal(json(new URL('node_modules/ajv/package.json', root)).version, project.devDependencies.ajv);
  assert.deepEqual(aguiProtocol, {
    version: pin.protocol, sourceCommit: pin.sourceCommit, typescriptSdk: sdk.version, pythonSdk: pythonSdk.version,
    mapping: pin.classification.switchboardMapping, planned: projectionFacts.plannedDescriptor,
  });
  assert.deepEqual(Object.keys(coverage).sort(), Object.keys(pin.categories).sort());
  assert.deepEqual(definitions.map((row) => row.definition).sort(), Object.keys(schema.$defs).sort());
  assert.deepEqual(definitions.flatMap((row) => row.event ? [row.event] : []).sort(), [...schema.$defs.EventType.enum].sort());
  assert.equal(new Set(definitions.map((row) => row.definition)).size, definitions.length);
  assert.equal(new Set(fixtures.map((fixture) => fixture.path)).size, fixtures.length);
  return { provenance, pin, vendor, definitions, fixtures, sdk, pythonSdk, project };
}

function projectCategories({ pin, definitions, fixtures }, registry) {
  const categories = Object.entries(pin.categories).map(([category, purpose]) => {
    const rows = definitions.filter((row) => row.category === category);
    const names = rows.map((row) => row.definition);
    const owned = coverage[category];
    const canonicalFixtures = fixtures.filter((fixture) => names.includes(fixture.definition));
    assert.ok(['represented', 'partial', 'wire-only'].includes(owned.mapping), category);
    assert.ok(owned.pending.length > 0 && owned.pending.every((owner) => owner.length > 0), category);
    return {
      category, purpose, definitions: names, canonicalEventDiscriminators: rows.flatMap((row) => row.event ? [row.event] : []),
      canonicalFixtures: canonicalFixtures.map((fixture) => fixture.path),
      sdkRuntimeDivergences: canonicalFixtures.filter((fixture) => fixture.typescriptAccepts !== fixture.valid || fixture.pythonAccepts !== fixture.valid)
        .map(({ path, typescriptAccepts, pythonAccepts }) => ({ path, typescriptAccepts, pythonAccepts })),
      mapping: owned.mapping, scope: owned.scope,
      ...Object.fromEntries(Object.keys(evidenceKinds).map((kind) => [kind, owned.evidence.filter((id) => registry[id].kind === kind)])),
      pendingProductOwners: owned.pending,
    };
  });
  assert.equal(categories.flatMap((row) => row.definitions).length, definitions.length);
  assert.equal(categories.flatMap((row) => row.canonicalFixtures).length, fixtures.length);
  return categories;
}

export function buildConformanceReport() {
  const inputs = verifiedInputs();
  const { provenance, pin, vendor, definitions, fixtures, sdk, pythonSdk, project } = inputs;
  const registry = validateCoverage();
  const categories = projectCategories(inputs, registry);
  const entries = (kind) => Object.values(registry).filter((entry) => entry.kind === kind).sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, file, test }) => ({ id, file, test }));
  const count = (predicate) => fixtures.filter(predicate).length;
  return {
    coverageContractVersion,
    canonical: {
      version: pin.protocol, sourceCommit: pin.sourceCommit, typescriptSdk: sdk.version, pythonSdk: pythonSdk.version,
      authority: reportText.authority,
      definitionCoverageOwner: { repository: vendor.sourceRepository, source: vendor.sourceRevision,
        matrix: provenance.files['ag-ui-matrix.tsv'].path, retained: retainedPath('ag-ui-matrix.tsv'), verifier: pin.ownership.schemaTest },
      fixtureCoverageOwner: { repository: vendor.sourceRepository, source: vendor.sourceRevision,
        index: provenance.files['upstream.tsv'].path, retained: retainedPath('upstream.tsv'), python: pin.ownership.pythonTest },
      counts: { categories: categories.length, definitions: definitions.length, eventDiscriminators: categories.flatMap((row) => row.canonicalEventDiscriminators).length,
        fixtures: fixtures.length, valid: count((fixture) => fixture.valid),
        invalid: count((fixture) => !fixture.valid),
        typescriptSdkRuntimePermissiveInvalid: count((fixture) => !fixture.valid && fixture.typescriptAccepts),
        pythonSdkRuntimePermissiveInvalid: count((fixture) => !fixture.valid && fixture.pythonAccepts),
        typescriptSdkRuntimeRestrictiveValid: count((fixture) => fixture.valid && !fixture.typescriptAccepts),
        pythonSdkRuntimeRestrictiveValid: count((fixture) => fixture.valid && !fixture.pythonAccepts) },
      sdkRuntimeEvidence: { kind: reportText.sdkRuntimeEvidenceKind,
        typescript: { package: sdk.package, version: sdk.version, validator: 'zod', validatorVersion: pin.verifierTools.zod },
        python: { package: pythonSdk.package, version: pythonSdk.version, validator: 'pydantic', validatorVersion: pin.verifierTools.pydantic },
        publishedTypes: reportText.publishedTypeEvidence },
    },
    switchboard: {
      repository: vendor.sourceRepository, sourceRevision: vendor.sourceRevision, artifact: vendor.artifact, sha256: vendor.sha256,
      descriptor: aguiProtocol,
      retainedCanonicalComparison: { log: `vendor/${vendor.qualification.logs['verify-agui'].path}`, scope: reportText.canonicalComparisonScope },
    },
    nativeEvidence: {
      availability: projectionFacts.nativeAvailability, declarationScope: reportText.nativeDeclarationScope,
      qualificationsByRoute: pin.classification.nativeAdapters,
    },
    agentuiCanonicalValidator: { package: 'ajv', version: project.devDependencies.ajv, schema: retainedPath('schema.json'),
      emittedEventDefinition: canonicalDefinitions.event, contractDefinitions: Object.values(canonicalDefinitions.contracts),
      controls: entries('canonicalControls') },
    installedFixtures: entries('installedFixtures'),
    publishedTypeContracts: entries('publishedTypeContracts'),
    behaviorLimits,
    retainedInputs: {
      [retainedPath('provenance.json')]: digest(readFileSync(new URL('provenance.json', upstream))),
      ...Object.fromEntries(Object.entries(provenance.files).map(([file, input]) => [retainedPath(file), input.sha256])),
    },
    categories,
  };
}

export const serializeConformanceReport = (report) => `${JSON.stringify(report, null, 2)}\n`;

export function assertReportFresh() {
  assert.equal(readFileSync(reportFile, 'utf8'), serializeConformanceReport(buildConformanceReport()), 'Conformance report is stale; regenerate it');
}

if (import.meta.main) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--check'), 'Usage: node scripts/protocol-conformance.mjs [--check]');
  if (process.argv[2] === '--check') assertReportFresh();
  else writeFileSync(reportFile, serializeConformanceReport(buildConformanceReport()));
  console.log(process.argv[2] === '--check' ? 'Protocol conformance report matches its versioned inputs.' : 'Wrote docs/protocol/conformance.json.');
}
