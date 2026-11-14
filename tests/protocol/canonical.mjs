import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import { canonicalDefinitions } from './coverage.mjs';

const schema = JSON.parse(readFileSync(new URL('./fixtures/upstream/schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false });
ajv.addSchema(schema);
function validateDefinition(name) {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  assert.equal(typeof validate, 'function', name);
  return validate;
}
export const validateEvent = validateDefinition(canonicalDefinitions.event);

export const canonicalControls = {
  'event-closed-shapes'() {
    assert.equal(validateEvent({ type: 'UNKNOWN_EVENT' }), false);
    assert.equal(validateEvent({ type: 'TEXT_MESSAGE_END', messageId: 'm' }), true);
    assert.equal(validateEvent({ type: 'TEXT_MESSAGE_END', messageId: 'm', unexpected: true }), false);
    assert.equal(validateEvent({ type: 'RUN_FINISHED', threadId: 't', runId: 'r', outcome: { type: 'cancelled' } }), true);
    assert.equal(validateEvent({ type: 'RUN_FINISHED', threadId: 't', runId: 'r', outcome: { type: 'cancelled', interrupts: [] } }), false);
  },

  'request-capability-shapes'() {
    const request = validateDefinition(canonicalDefinitions.contracts.request);
    const minimal = { threadId: 't', runId: 'r', messages: [] };
    assert.equal(request(minimal), true);
    for (const extra of [{ state: null }, { forwardedProps: null }, { unexpected: 1 }]) assert.equal(request({ ...minimal, ...extra }), false);
    const capabilities = validateDefinition(canonicalDefinitions.contracts.capabilities);
    assert.equal(capabilities({ multiAgent: { supported: true } }), true);
    assert.equal(capabilities({ multiAgent: { supported: true, unexpected: true } }), false);
  },
};
