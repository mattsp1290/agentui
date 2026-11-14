import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { aguiProtocol } from '@agentui/host/agui';
import { retained } from './inputs.mjs';
import { canonicalDefinitions } from './canonical.mjs';
import { evidenceKinds, evidenceTest, validateCoverage } from './evidence.mjs';
import { behaviorLimits, coverage, coverageContractVersion, projectionFacts, reportText } from './coverage.mjs';

const root = new URL('../../', import.meta.url);
export const reportFile = new URL('docs/protocol/conformance.json', root);
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const retainedPath = (file) => `${retained.retainedDir}${file}`;

function projectCategories({ pin, definitions, fixtures }, registry) {
  const categories = Object.entries(pin.categories).map(([category, purpose]) => {
    const rows = definitions.filter((row) => row.category === category);
    const names = rows.map((row) => row.definition);
    const owned = coverage[category];
    const canonicalFixtures = fixtures.filter((fixture) => names.includes(fixture.definition));
    const installedFixtures = owned.evidence.filter((id) => registry[id] === 'installedFixtures');
    const canonicalControls = owned.evidence.filter((id) => registry[id] === 'canonicalControls');
    const publishedTypeContracts = owned.evidence.filter((id) => registry[id] === 'publishedTypeContracts');
    assert.equal(installedFixtures.length + canonicalControls.length + publishedTypeContracts.length, owned.evidence.length, category);
    return {
      category, purpose, definitions: names, canonicalEventDiscriminators: rows.flatMap((row) => row.event ? [row.event] : []),
      canonicalFixtures: canonicalFixtures.map((fixture) => fixture.path),
      sdkRuntimeDivergences: canonicalFixtures.filter((fixture) => fixture.typescriptAccepts !== fixture.valid || fixture.pythonAccepts !== fixture.valid)
        .map(({ path, typescriptAccepts, pythonAccepts }) => ({ path, typescriptAccepts, pythonAccepts })),
      mapping: owned.mapping, scope: owned.scope,
      installedFixtures, canonicalControls, publishedTypeContracts,
      pendingProductOwners: owned.pending,
    };
  });
  assert.equal(categories.flatMap((row) => row.definitions).length, definitions.length);
  assert.equal(categories.flatMap((row) => row.canonicalFixtures).length, fixtures.length);
  return categories;
}

export function buildConformanceReport() {
  const { provenance, pin, schema, definitions, fixtures } = retained;
  const vendor = json(new URL('vendor/switchboard.json', root));
  const project = json(new URL('package.json', root));
  const sdk = pin.artifacts.find((artifact) => artifact.package === '@ag-ui/core');
  const pythonSdk = pin.artifacts.find((artifact) => artifact.package === 'ag-ui-protocol');
  assert.equal(provenance.sources.switchboard.revision, vendor.sourceRevision);
  assert.equal(provenance.sources.canonical.revision, pin.sourceCommit);
  assert.equal(provenance.files['schema.json'].sha256, pin.upstreamFiles['spec/1.0/schema.json']);
  assert.equal(provenance.files['UPSTREAM-LICENSE'].sha256, pin.upstreamFiles.LICENSE);
  assert.deepEqual(aguiProtocol, {
    version: pin.protocol, sourceCommit: pin.sourceCommit, typescriptSdk: sdk.version, pythonSdk: pythonSdk.version,
    mapping: pin.classification.switchboardMapping, planned: projectionFacts.plannedDescriptor,
  });
  assert.deepEqual(Object.keys(coverage).sort(), Object.keys(pin.categories).sort());
  assert.deepEqual(definitions.map((row) => row.definition).sort(), Object.keys(schema.$defs).sort());
  assert.deepEqual(definitions.flatMap((row) => row.event ? [row.event] : []).sort(), [...schema.$defs.EventType.enum].sort());
  assert.equal(new Set(definitions.map((row) => row.definition)).size, definitions.length);
  assert.equal(new Set(fixtures.map((fixture) => fixture.path)).size, fixtures.length);
  const registry = validateCoverage();
  const categories = projectCategories(retained, registry);
  const kindEvidence = (kind) => ({ testName: evidenceTest(kind, '<id>'), ids: Object.keys(evidenceKinds[kind].bodies).sort() });
  const count = (predicate) => fixtures.filter(predicate).length;
  return {
    coverageContractVersion,
    canonical: {
      version: pin.protocol, sourceCommit: pin.sourceCommit, typescriptSdk: sdk.version, pythonSdk: pythonSdk.version,
      fixturePathsExecutedByAgentUI: false,
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
        canonicalLabels: { validator: 'ajv', validatorVersion: pin.verifierTools.ajv, verifier: pin.ownership.schemaTest, rerunByAgentUI: false },
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
      emittedEventDefinition: canonicalDefinitions.event, contractDefinitions: Object.values(canonicalDefinitions.contracts) },
    evidence: {
      registrar: 'tests/protocol/conformance.test.mjs',
      installedFixtures: kindEvidence('installedFixtures'),
      canonicalControls: kindEvidence('canonicalControls'),
      publishedTypeContracts: kindEvidence('publishedTypeContracts'),
    },
    behaviorLimits,
    retainedInputs: {
      [retainedPath('provenance.json')]: retained.provenanceDigest,
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
  const [mode, ...extra] = process.argv.slice(2);
  assert.ok(extra.length === 0 && (mode === undefined || mode === '--check'), 'Usage: node tests/protocol/report.mjs [--check]');
  if (mode === '--check') assertReportFresh();
  else writeFileSync(reportFile, serializeConformanceReport(buildConformanceReport()));
  console.log(mode === '--check' ? 'Protocol conformance report matches its versioned inputs.' : 'Wrote docs/protocol/conformance.json.');
}
