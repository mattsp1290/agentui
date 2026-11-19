import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionRows, openableRow } from '../../apps/desktop/dist/application/ExtensionsView.js';

const namespace = 'ledger';
const customizations = [{ manifest: { namespace } }];
const activations = [{ namespace, kind: 'ready', lifetime: 1, presentation: { workspace: { label: 'Ledger', component: () => null } }, fail() {} }];
const metadata = extensions => ({ hostId: 'host', principalId: 'principal', agents: [], defaultAgentId: null, extensions });
const rowOf = value => extensionRows({ customizations, activations, enabled: true, metadata: value })[0];

test('a bundled extension reads Loading, not Not configured, until the host reports its extensions', () => {
  const waiting = rowOf(null);
  assert.equal(waiting.state, 'Loading');
  assert.match(waiting.detail, /Waiting for the host/);
  assert.equal(openableRow(waiting), null, 'no setup guidance opens while the host has said nothing');
  assert.equal(rowOf(metadata([])).state, 'Not configured');
  assert.equal(rowOf(metadata([{ namespace, state: 'active', operations: [], installations: [] }])).state, 'Not configured');
  assert.equal(rowOf(metadata([{ namespace, state: 'active', operations: [], installations: [{ installationId: 'books', status: 'available' }] }])).state, 'Ready');
});
