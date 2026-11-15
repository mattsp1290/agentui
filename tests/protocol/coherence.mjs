import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveLockedFork } from '../../scripts/lib/agui-fork/identity.mjs';
import { aguiProtocol } from '@agentui/host/agui';
import { retained } from './inputs.mjs';
import { coverage, projectionFacts } from './coverage.mjs';

export function loadConformanceInputs() {
  const root = new URL('../../', import.meta.url);
  const json = (file) => JSON.parse(readFileSync(new URL(file, root), 'utf8'));
  const vendor = json('vendor/switchboard.json');
  const historicalVendor = json(`vendor/${vendor.historicalRecord}`);
  const inputs = {
    retained, vendor, historicalVendor, project: json('package.json'), descriptor: aguiProtocol,
    sdk: retained.pin.artifacts.find((artifact) => artifact.package === '@ag-ui/core'),
    pythonSdk: retained.pin.artifacts.find((artifact) => artifact.package === 'ag-ui-protocol'),
  };
  assertCoherent(inputs);
  return { ...inputs, fork: resolveLockedFork(fileURLToPath(root)) };
}

function assertCoherent({ retained: { provenance, pin, schema, definitions, fixtures }, historicalVendor, descriptor, sdk, pythonSdk }) {
  assert.ok(sdk, 'Retained pin must list the historical @ag-ui/core artifact');
  assert.ok(pythonSdk, 'Retained pin must list the historical ag-ui-protocol artifact');
  assert.equal(provenance.sources.switchboard.revision, historicalVendor.sourceRevision, 'Retained Switchboard revision must match its historical qualification');
  assert.equal(provenance.sources.canonical.revision, pin.sourceCommit, 'Retained canonical revision must match its pin');
  assert.equal(provenance.files['schema.json'].sha256, pin.upstreamFiles['spec/1.0/schema.json'], 'Retained schema digest must match its upstream pin');
  assert.equal(provenance.files['UPSTREAM-LICENSE'].sha256, pin.upstreamFiles.LICENSE, 'Retained upstream license digest must match its pin');
  assert.deepEqual(descriptor, {
    version: pin.protocol, sourceCommit: pin.sourceCommit, typescriptSdk: sdk.version, pythonSdk: pythonSdk.version,
    mapping: projectionFacts.mappingDescriptor, planned: projectionFacts.plannedDescriptor,
  }, 'Installed protocol descriptor must match retained inputs');
  assert.deepEqual(Object.keys(coverage).sort(), Object.keys(pin.categories).sort(), 'Coverage categories must match retained pin categories');
  assert.deepEqual(definitions.map((row) => row.definition).sort(), Object.keys(schema.$defs).sort(), 'Retained definitions must match canonical schema definitions');
  assert.deepEqual(definitions.flatMap((row) => row.event ? [row.event] : []).sort(), [...schema.$defs.EventType.enum].sort(), 'Retained event discriminators must match the canonical event enum');
  assert.equal(new Set(definitions.map((row) => row.definition)).size, definitions.length, 'Retained definition names must be unique');
  assert.equal(new Set(fixtures.map((fixture) => fixture.path)).size, fixtures.length, 'Retained fixture paths must be unique');
  const names = new Set(definitions.map((row) => row.definition));
  for (const row of definitions) assert.ok(Object.hasOwn(pin.categories, row.category), `Retained definition has unknown category: ${row.definition}`);
  for (const fixture of fixtures) assert.ok(names.has(fixture.definition), `Retained fixture names an unknown definition: ${fixture.path}`);
}
