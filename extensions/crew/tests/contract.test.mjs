import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { crewService } from './support/crew-service.mjs';

const require = createRequire(import.meta.url);
const openapi = require('@birbcrew/client/openapi.json');
const token = 'private-contract-token';
const instance = { namespace: 'crew', installationId: 'contract', generation: '1', protocolVersion: '1' };

/** Validates fake responses against the vendored client's OpenAPI document, so the fake cannot drift from Crew. */
function validator() {
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
  ajv.addSchema({ $id: 'crew', components: openapi.components });
  return (path, method, status, body) => {
    let response = openapi.paths[path][method].responses[status];
    if (response.$ref) response = openapi.components.responses[response.$ref.split('/').at(-1)];
    const schema = response.content['application/json'].schema;
    const validate = ajv.compile({ $ref: `crew${schema.$ref}` });
    assert.equal(validate(body), true, `${method.toUpperCase()} ${path} ${status}: ${JSON.stringify(validate.errors)}`);
  };
}

test('the fake Crew member and conversation responses match the vendored OpenAPI contract', async t => {
  const memberId = randomUUID();
  const remote = await crewService(t, { memberId, token, instance, members: [{ memberId: randomUUID(), engine: 'pi', profile: 'research' }], pageSize: 1 });
  const check = validator();
  const call = async (method, path, body) => {
    const response = await fetch(remote.origin + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: String(response.status), body: await response.json() };
  };
  const first = await call('GET', '/v1/members');
  check('/v1/members', 'get', first.status, first.body);
  assert.equal(first.body.next, '1');
  const second = await call('GET', `/v1/members?after=${first.body.next}`);
  check('/v1/members', 'get', second.status, second.body);
  const created = await call('POST', '/v1/members', { requestId: randomUUID(), engine: 'claude', profile: 'research', instructions: 'Be brief.' });
  assert.equal(created.status, '201');
  check('/v1/members', 'post', created.status, created.body);
  const unknown = await call('POST', '/v1/members', { requestId: randomUUID(), engine: 'claude', profile: 'missing' });
  assert.equal(unknown.status, '409');
  check('/v1/members', 'post', unknown.status, unknown.body);
  const conversationId = randomUUID();
  const opened = await call('POST', '/v1/conversations', { conversationId, memberId: created.body.memberId });
  check('/v1/conversations', 'post', opened.status, opened.body);
  const read = await call('GET', `/v1/conversations/${conversationId}`);
  check('/v1/conversations/{conversationId}', 'get', read.status, read.body);
});
