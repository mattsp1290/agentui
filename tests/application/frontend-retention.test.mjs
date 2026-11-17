import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendToolGeneration } from '@agentui/sdk/tools';
import { createFrontendSends, createGenerationSource } from '../../apps/desktop/dist/application/frontend-sends.js';
import { scope } from '../client/support.mjs';

test('a failed view stays refused across authority changes until a new registry owns it', async t => {
  const source = createGenerationSource(), token = {};
  const { generation } = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'A', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) {
      frontendTools.add({ definition: { name: 'echo', description: 'A' }, decodeInput: value => value, execute() { throw new Error('Execution disabled'); } });
      return { dispose() {} };
    } });
  source.begin(token); source.publish(token, { kind: 'ready', generations: [generation] });
  const connection = {}, registries = [];
  t.after(async () => { await Promise.all(registries.map(owner => owner.dispose())); await generation.retire(); });
  const create = () => {
    const owner = createFrontendSends({ generations: source, rowsChanged() {}, unauthorized() {} });
    registries.push(owner); return owner;
  };
  const capture = { borrow: () => ({ failed() {}, release() {} }) };
  const admission = owner => owner.forStore({ recoveryNeeded() {}, viewId: 'view', scope, capture, eligibility: () => 'ag-ui-capture-and-bind' });
  const original = create(); await original.session({ hostId: scope.hostId, principalId: 'A' }, connection);
  admission(original).capture().release();
  original.storageFailed('view');
  await original.session({ hostId: scope.hostId, principalId: 'B' }, connection);
  assert.throws(() => admission(original).capture(), /Local storage failed/);
  const fresh = create(); await fresh.session({ hostId: scope.hostId, principalId: 'B' }, connection);
  const borrowed = admission(fresh).capture();
  assert.equal(borrowed.ownerId, 'B'); borrowed.release();
});
