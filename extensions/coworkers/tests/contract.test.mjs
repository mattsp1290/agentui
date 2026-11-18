import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { COWORKERS_API_VERSION, COWORKERS_REQUEST_CONTRACT, COWORKERS_REVISION } from '../dist/client.js';
import { coworkersService } from './support/coworkers-service.mjs';

const openapi = JSON.parse(await readFile(new URL('../openapi/crabber-coworkers.v1.json', import.meta.url), 'utf8'));
const revision = (await readFile(new URL('../openapi/REVISION', import.meta.url), 'utf8')).trim();

function validator() {
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
  ajv.addSchema({ $id: 'coworkers', components: openapi.components });
  return (path, method, status, body) => {
    let response = openapi.paths[path][method].responses[status];
    assert.ok(response, `${method} ${path} has no ${status}`);
    if (response.$ref) response = openapi.components.responses[response.$ref.split('/').at(-1)];
    const schema = response.content['application/json'].schema;
    const validate = ajv.compile(schema.$ref ? { $ref: `coworkers${schema.$ref}` } : schema);
    assert.equal(validate(body), true, `${method} ${path} ${status}: ${JSON.stringify(validate.errors)}`);
  };
}

test('the vendored OpenAPI document matches the client constants and its recorded revision', () => {
  assert.match(revision, /^[0-9a-f]{40}$/u);
  assert.equal(revision, COWORKERS_REVISION);
  assert.equal(openapi.info.version, '1.0.0');
  assert.deepEqual(openapi.components.schemas.Capabilities.properties.apiVersion.enum, [COWORKERS_API_VERSION]);
  assert.deepEqual(openapi.components.schemas.Capabilities.properties.requestContract.enum, [COWORKERS_REQUEST_CONTRACT]);
});

test('every fake response the tests use matches the vendored OpenAPI document', async t => {
  const remote = await coworkersService(t), check = validator();
  const call = async (method, path, body) => {
    const response = await fetch(remote.origin + path, { method, headers: { authorization: `Bearer ${remote.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: String(response.status), body: await response.json() };
  };
  const conversationId = '0f8d8e4c-1111-4222-8333-444455556666', requestId = '1a2b3c4d-1111-4222-8333-444455556666';
  const cases = [
    ['GET', '/v1/capabilities', '/v1/capabilities'], ['GET', '/v1/coworkers', '/v1/coworkers'], ['GET', '/v1/health', '/v1/health'],
    ['POST', '/v1/conversations', '/v1/conversations', { conversationId, coworkerId: 'ada' }],
    ['POST', '/v1/conversations', '/v1/conversations', { conversationId, coworkerId: 'grace' }],
    ['POST', '/v1/conversations', '/v1/conversations', { conversationId: '2a2b3c4d-1111-4222-8333-444455556666', coworkerId: 'nobody' }],
    ['GET', '/v1/conversations', '/v1/conversations'],
    ['POST', `/v1/conversations/${conversationId}/requests`, '/v1/conversations/{conversationId}/requests', { requestId, text: 'Hello' }],
    ['POST', `/v1/conversations/${conversationId}/requests`, '/v1/conversations/{conversationId}/requests', { requestId, text: 'Other' }],
    ['GET', `/v1/conversations/${conversationId}/requests/${requestId}`, '/v1/conversations/{conversationId}/requests/{requestId}'],
    ['GET', `/v1/conversations/${conversationId}`, '/v1/conversations/{conversationId}'],
  ];
  for (const [method, path, template, body] of cases) {
    const result = await call(method, path, body);
    check(template, method.toLowerCase(), result.status, result.body);
  }
  remote.complete('Done');
  for (const [method, path, template] of [['GET', `/v1/conversations/${conversationId}`, '/v1/conversations/{conversationId}'],
    ['GET', `/v1/conversations/${conversationId}/requests/${requestId}`, '/v1/conversations/{conversationId}/requests/{requestId}'],
    ['POST', `/v1/conversations/${conversationId}/requests/${requestId}/cancel`, '/v1/conversations/{conversationId}/requests/{requestId}/cancel']]) {
    const result = await call(method, path, method === 'POST' ? {} : undefined);
    check(template, method.toLowerCase(), result.status, result.body);
  }
  const unauthorized = await fetch(`${remote.origin}/v1/coworkers`);
  check('/v1/coworkers', 'get', String(unauthorized.status), await unauthorized.json());
});
