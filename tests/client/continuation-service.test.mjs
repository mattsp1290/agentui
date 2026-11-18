import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createBrowserConnection, ServiceProtocolError } from '@agentui/client/service';
import { createMacConnection } from '@agentui/client/mac';
import { parseServiceRequest } from '@agentui/contracts/service';

const scope = { hostId: 'host', conversationId: 'chat' };
const earlier = { hostId: 'host', conversationId: 'earlier' }, later = { hostId: 'host', conversationId: 'later' };
const carried = { carriedTurns: 3, omittedTurns: 1, uncertainTurns: 0, carriedBytes: 2048, limitBytes: 65536 };
const none = { predecessor: null, carried: null, closure: null, successor: null };
const views = [
  none,
  { ...none, closure: 'cancelled', successor: { kind: 'starting' } },
  ...['pending', 'unconfirmed'].map(kind => ({ predecessor: earlier, carried, closure: 'failed', successor: { kind } })),
  ...['busy', 'limit', 'unavailable', 'continued-elsewhere'].map(refusal => ({ ...none, closure: 'exhausted', successor: { kind: 'refused', refusal } })),
  { predecessor: earlier, carried, closure: 'exhausted', successor: { kind: 'confirmed', scope: later } },
  { predecessor: earlier, carried: null, closure: 'unknown', successor: { kind: 'confirmed', scope: later } },
];
const malformed = [
  null, {}, { ...none, extra: true }, { ...none, closure: 'paused' }, { ...none, closure: 'Unknown' },
  { ...none, carried },
  { ...none, predecessor: scope },
  { ...none, predecessor: { hostId: 'other', conversationId: 'earlier' } },
  { ...none, predecessor: { ...earlier, generation: 'new' } },
  { ...none, successor: { kind: 'confirmed', scope } },
  { ...none, predecessor: earlier, successor: { kind: 'confirmed', scope: earlier } },
  { ...none, successor: { kind: 'confirmed', scope: { hostId: 'other', conversationId: 'later' } } },
  { ...none, successor: { kind: 'confirmed' } },
  { ...none, successor: { kind: 'pending', scope: later } },
  { ...none, successor: { kind: 'refused', refusal: 'Crew said no' } },
  { ...none, successor: { kind: 'refused' } },
  { ...none, successor: { kind: 'resumed' } },
  { ...none, predecessor: earlier, carried: { ...carried, limitBytes: -1 } },
  { ...none, predecessor: earlier, carried: { ...carried, carriedBytes: 65537 } },
  { ...none, predecessor: earlier, carried: { ...carried, carriedTurns: 1.5 } },
  { ...none, predecessor: earlier, carried: { ...carried, transcriptDigest: 'a' } },
];
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('TypeScript and Rust share exact continuation request golden cases', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/continuation-requests.json', import.meta.url)));
  assert.deepEqual(cases.filter(row => row.valid).map(row => row.request.action), ['read', 'check', 'start']);
  for (const row of cases) {
    if (row.valid) assert.deepEqual(parseServiceRequest(row.request), row.request);
    else assert.throws(() => parseServiceRequest(row.request), undefined, JSON.stringify(row.request));
  }
});

test('continuation views round-trip on the browser and Mac adapters for every action', async () => {
  for (const action of ['read', 'check', 'start']) for (const view of views) {
    const body = JSON.stringify({ ok: true, value: view });
    const browser = createBrowserConnection({ fetch: async (path, init) => {
      assert.equal(path, '/api/v1');
      assert.deepEqual(JSON.parse(init.body), { op: 'continuation', scope, action });
      return json({ ok: true, value: view });
    } });
    const mac = createMacConnection({ observation: 'current' }, async command => {
      assert.deepEqual(command, { kind: 'execute', observation: 'current', request: { op: 'continuation', scope, action } });
      return { status: 200, body };
    });
    for (const client of [browser, mac]) assert.deepEqual(await client.continuation({ scope, action }), view);
  }
});

test('continuation rejects foreign or malformed views and extra request fields, and forwards host refusals', async () => {
  for (const value of malformed) {
    const client = createBrowserConnection({ fetch: async () => json({ ok: true, value }) });
    await assert.rejects(client.continuation({ scope, action: 'read' }), ServiceProtocolError, JSON.stringify(value));
  }
  let calls = 0;
  const strict = createBrowserConnection({ fetch: async () => { calls++; return json({ ok: true, value: none }); } });
  for (const input of [{ scope, action: 'retry' }, { scope, action: 'start', predecessor: earlier }, { scope: { ...scope, hostId: '' }, action: 'read' }]) {
    await assert.rejects(strict.continuation(input));
  }
  assert.equal(calls, 0);
  const message = 'Only a concluded provider conversation without frontend tool activity can be continued.';
  const refused = createBrowserConnection({ fetch: async () => new Response(JSON.stringify({ ok: false, error: { kind: 'invalid', message } }),
    { status: 400, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(refused.continuation({ scope, action: 'start' }), error => error.kind === 'invalid' && error.message === message);
});
