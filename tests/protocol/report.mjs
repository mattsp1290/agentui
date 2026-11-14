import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConformanceInputs } from './coherence.mjs';
import { canonicalDefinitions } from './canonical.mjs';
import { evidenceKinds, evidenceTest, buildEvidenceRegistry } from './evidence.mjs';
import { behaviorLimits, coverage, coverageContractVersion, projectionFacts, reportText } from './coverage.mjs';

const root = new URL('../../', import.meta.url);
export const reportFile = new URL('docs/protocol/conformance.json', root);
const byKind = (project) => Object.fromEntries(Object.keys(evidenceKinds).map((kind) => [kind, project(kind)]));

function projectCategories({ pin, definitions, fixtures }, registry) {
  const categories = Object.entries(pin.categories).map(([category, purpose]) => {
    const rows = definitions.filter((row) => row.category === category);
    const names = rows.map((row) => row.definition);
    const owned = coverage[category];
    const canonicalFixtures = fixtures.filter((fixture) => names.includes(fixture.definition));
    return {
      category, purpose, definitions: names, canonicalEventDiscriminators: rows.flatMap((row) => row.event ? [row.event] : []),
      canonicalFixtures: canonicalFixtures.map((fixture) => fixture.path),
      sdkRuntimeDivergences: canonicalFixtures.filter((fixture) => fixture.typescriptAccepts !== fixture.valid || fixture.pythonAccepts !== fixture.valid)
        .map(({ path, typescriptAccepts, pythonAccepts }) => ({ path, typescriptAccepts, pythonAccepts })),
      mapping: owned.mapping, scope: owned.scope,
      ...byKind((kind) => owned.evidence.filter((id) => registry[id] === kind)),
      pendingProductOwners: owned.pending,
    };
  });
  assert.equal(categories.flatMap((row) => row.definitions).length, definitions.length, 'Every retained definition must be projected into a category');
  assert.equal(categories.flatMap((row) => row.canonicalFixtures).length, fixtures.length, 'Every retained fixture must be projected into a category');
  return categories;
}

function buildConformanceReport({ inputs: { retained, vendor, project, descriptor, sdk, pythonSdk, fork }, registry }) {
  const { provenance, pin, definitions, fixtures } = retained;
  const { metadata, core: installedSdk } = fork;
  const retainedPath = (file) => `${retained.retainedDir}${file}`;
  const categories = projectCategories(retained, registry);
  const kindEvidence = (kind) => ({ testName: evidenceTest(kind, '<id>'), ids: Object.keys(registry).filter((id) => registry[id] === kind).sort() });
  const count = (predicate) => fixtures.filter(predicate).length;
  return {
    coverageContractVersion,
    installedSdk: {
      repository: metadata.sourceRepository, branch: metadata.sourceBranch, sourceRevision: metadata.sourceRevision,
      provenance: fork.provenancePath, provenanceSha256: fork.provenanceSha256,
      package: installedSdk.package, version: installedSdk.version,
      artifact: installedSdk.artifact, sha256: installedSdk.sha256, integrity: installedSdk.npmIntegrity,
      matchesHistoricalRuntimeArtifactSha256: installedSdk.sha256 === sdk.sha256,
      matchesHistoricalRuntimeArtifactIntegrity: installedSdk.npmIntegrity === sdk.integrity,
      scope: reportText.installedSdkScope,
    },
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
      descriptor,
      retainedCanonicalComparison: { log: `vendor/${vendor.qualification.logs['verify-agui'].path}`, scope: reportText.canonicalComparisonScope },
    },
    nativeEvidence: {
      availability: projectionFacts.nativeAvailability, declarationScope: reportText.nativeDeclarationScope,
      qualificationsByRoute: pin.classification.nativeAdapters,
    },
    agentuiCanonicalValidator: { package: 'ajv', version: project.devDependencies.ajv, schema: retainedPath('schema.json'),
      emittedEventDefinition: canonicalDefinitions.event, contractDefinitions: Object.values(canonicalDefinitions.contracts) },
    evidence: { registrar: 'tests/protocol/conformance.test.mjs', ...byKind(kindEvidence) },
    behaviorLimits,
    retainedInputs: {
      [retainedPath('provenance.json')]: retained.provenanceDigest,
      ...Object.fromEntries(Object.entries(provenance.files).map(([file, input]) => [retainedPath(file), input.sha256])),
    },
    categories,
  };
}

export const serializeConformanceReport = (report) => `${JSON.stringify(report, null, 2)}\n`;

function currentConformanceReport() {
  return buildConformanceReport({ inputs: loadConformanceInputs(), registry: buildEvidenceRegistry() });
}

export function assertReportFresh() {
  assert.equal(readFileSync(reportFile, 'utf8'), serializeConformanceReport(currentConformanceReport()), 'Conformance report is stale; regenerate it');
}

if (import.meta.main) {
  const [mode, ...extra] = process.argv.slice(2);
  assert.ok(extra.length === 0 && (mode === undefined || mode === '--check'), 'Usage: node tests/protocol/report.mjs [--check]');
  if (mode === '--check') assertReportFresh();
  else writeFileSync(reportFile, serializeConformanceReport(currentConformanceReport()));
  console.log(mode === '--check' ? 'Protocol conformance report matches its versioned inputs.' : 'Wrote docs/protocol/conformance.json.');
}
