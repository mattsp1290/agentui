import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aguiProtocol } from '@agentui/host/agui';
import { retained } from './inputs.mjs';
import { coverage, projectionFacts } from './coverage.mjs';

export function readConformanceInputs() {
  const root = new URL('../../', import.meta.url);
  const json = (file) => JSON.parse(readFileSync(new URL(file, root), 'utf8'));
  return { retained, vendor: json('vendor/switchboard.json'), project: json('package.json'), descriptor: aguiProtocol };
}

export function assertRetainedInputsCoherent({ retained: { provenance, pin, schema, definitions, fixtures }, vendor, descriptor }) {
  const sdk = pin.artifacts.find((artifact) => artifact.package === '@ag-ui/core');
  const pythonSdk = pin.artifacts.find((artifact) => artifact.package === 'ag-ui-protocol');
  assert.equal(provenance.sources.switchboard.revision, vendor.sourceRevision, 'Retained Switchboard revision must match the installed vendor');
  assert.equal(provenance.sources.canonical.revision, pin.sourceCommit, 'Retained canonical revision must match its pin');
  assert.equal(provenance.files['schema.json'].sha256, pin.upstreamFiles['spec/1.0/schema.json'], 'Retained schema digest must match its upstream pin');
  assert.equal(provenance.files['UPSTREAM-LICENSE'].sha256, pin.upstreamFiles.LICENSE, 'Retained upstream license digest must match its pin');
  assert.deepEqual(descriptor, {
    version: pin.protocol, sourceCommit: pin.sourceCommit, typescriptSdk: sdk.version, pythonSdk: pythonSdk.version,
    mapping: pin.classification.switchboardMapping, planned: projectionFacts.plannedDescriptor,
  }, 'Installed protocol descriptor must match retained inputs');
  assert.deepEqual(Object.keys(coverage).sort(), Object.keys(pin.categories).sort(), 'Coverage categories must match retained pin categories');
  assert.deepEqual(definitions.map((row) => row.definition).sort(), Object.keys(schema.$defs).sort(), 'Retained definitions must match canonical schema definitions');
  assert.deepEqual(definitions.flatMap((row) => row.event ? [row.event] : []).sort(), [...schema.$defs.EventType.enum].sort(), 'Retained event discriminators must match the canonical event enum');
  assert.equal(new Set(definitions.map((row) => row.definition)).size, definitions.length, 'Retained definition names must be unique');
  assert.equal(new Set(fixtures.map((fixture) => fixture.path)).size, fixtures.length, 'Retained fixture paths must be unique');
}
