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

  // The responses the provider and browser tests rely on beyond the success paths.
  const receiptTemplate = '/v1/conversations/{conversationId}/requests/{requestId}', submitTemplate = '/v1/conversations/{conversationId}/requests';
  const receiptOf = id => call('GET', `/v1/conversations/${conversationId}/requests/${id}`);
  const submit = (id, text) => call('POST', `/v1/conversations/${conversationId}/requests`, { requestId: id, text });
  const failed = '3a2b3c4d-1111-4222-8333-444455556666', uncertain = '4a2b3c4d-1111-4222-8333-444455556666', hidden = '5a2b3c4d-1111-4222-8333-444455556666';
  for (const id of [failed, uncertain, hidden]) check(submitTemplate, 'post', ...Object.values(await submit(id, `Text ${id}`)));
  remote.fail(failed); remote.markUncertain(uncertain);
  for (const id of [failed, uncertain]) {
    const result = await receiptOf(id);
    assert.equal(typeof result.body.reason, 'string', `${id} carries a reason`);
    check(receiptTemplate, 'get', result.status, result.body);
  }
  remote.hideReceipt(hidden);
  const missingReceipt = await receiptOf(hidden);
  assert.equal(missingReceipt.status, '404');
  check(receiptTemplate, 'get', missingReceipt.status, missingReceipt.body);
  remote.invisible(hidden);
  const invisible = await receiptOf(hidden);
  assert.equal(invisible.status, '404');
  check(receiptTemplate, 'get', invisible.status, invisible.body);
  const full = await coworkersService(t, { maxQueued: 1 });
  const fullCall = async (path, body) => {
    const response = await fetch(full.origin + path, { method: 'POST', headers: { authorization: `Bearer ${full.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: String(response.status), body: await response.json() };
  };
  await fullCall('/v1/conversations', { conversationId, coworkerId: 'ada' });
  await fullCall(`/v1/conversations/${conversationId}/requests`, { requestId, text: 'First' });
  const queueFull = await fullCall(`/v1/conversations/${conversationId}/requests`, { requestId: failed, text: 'Second' });
  assert.deepEqual([queueFull.status, queueFull.body.error], ['409', 'queue_full']);
  check(submitTemplate, 'post', queueFull.status, queueFull.body);
});
