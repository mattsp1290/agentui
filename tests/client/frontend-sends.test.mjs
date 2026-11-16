import { assertCompileCases } from '../support/compile.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalJson, parseCommand } from '@agentui/contracts';
import { parseServiceRequest, parseServiceResponse } from '@agentui/contracts/service';
import { createMacConnection } from '@agentui/client/mac';

const cases = JSON.parse(readFileSync(new URL('./fixtures/frontend-sends.json', import.meta.url), 'utf8'));
for (const item of cases) test(`frontend wire golden ${item.name}`, () => {
  if (item.accepted) assert.deepEqual(parseServiceRequest(item.request), item.request);
  else assert.throws(() => parseServiceRequest(item.request));
});
test('plain commands preserve their canonical identity and offered response identity is checked against the request', () => {
  const command = cases[0].request.command, scope = command.scope;
  const plain = { version: 1, scope, clientCommandId: command.clientCommandId, body: { kind: 'send', text: 'Original' } };
  assert.equal(canonicalJson(parseCommand(plain)), canonicalJson(plain));
  const request = { op: 'frontend-binding', scope, id: command.clientCommandId, action: 'recover' };
  const bound = { kind: 'bound', command, hostOperationId: 'operation', threadId: 'thread', run: { conversation: scope, runId: 'run',
    authority: { kind: 'remote-provider', binding: { namespace: 'provider', installationId: 'installation', opaqueSessionId: 'session' } } } };
  assert.deepEqual(parseServiceResponse(request, { ok: true, value: bound }).value, bound);
  for (const value of [{ ...bound, threadId: '' }, { ...bound, command: { ...command, clientCommandId: 'different' } },
    { ...bound, run: { ...bound.run, conversation: { ...scope, conversationId: 'different' } } },
    { kind: 'pending', id: 'different' }, { kind: 'unavailable', id: 'different', reason: 'closures-unavailable' }]) {
    assert.throws(() => parseServiceResponse(request, { ok: true, value }));
  }
});
test('Mac binding recovery uses the shared native transport and response parser', async () => {
  const scope = cases[0].request.command.scope, requests = [];
  const connection = createMacConnection({ kind: 'ready', observation: 'epoch', hostId: scope.hostId, principalId: 'owner' }, async command => {
    requests.push(command);
    return { status: 200, body: JSON.stringify({ ok: true, value: { kind: 'pending', id: 'command' } }) };
  });
  assert.deepEqual(await connection.frontendBinding({ scope, id: 'command', action: 'recover' }), { kind: 'pending', id: 'command' });
  assert.deepEqual(requests, [{ kind: 'execute', observation: 'epoch', request: { op: 'frontend-binding', scope, id: 'command', action: 'recover' } }]);
});

for (const reason of ['provider-rejected', 'not-dispatched', 'closures-unavailable']) test(`Mac binding recovery retains final ${reason} through the shared response parser`, async () => {
  const scope = cases[0].request.command.scope, value = { kind: 'unavailable', id: 'command', reason };
  const connection = createMacConnection({ kind: 'ready', observation: 'epoch', hostId: scope.hostId, principalId: 'owner' }, async () => ({
    status: 200, body: JSON.stringify({ ok: true, value }),
  }));
  assert.deepEqual(await connection.frontendBinding({ scope, id: 'command', action: 'recover' }), value);
  assert.throws(() => parseServiceResponse({ op: 'frontend-binding', scope, id: 'command', action: 'recover' },
    { ok: true, value: { ...value, reason: 'rejected' } }));
});


test('public response parsing requires binding context while preserving generic service transport typing', () => assertCompileCases({
  config: new URL('../../packages/contracts/tsconfig.json', import.meta.url).pathname,
  prefix: `import { parseServiceResponse } from '@agentui/contracts/service';
    import type { ServiceRequest, ServiceValueMap, ServiceResponse } from '@agentui/contracts/service';
    import type { FrontendBinding } from '@agentui/contracts';
    export type { ServiceRequest, ServiceValueMap, ServiceResponse, FrontendBinding };
    export const scope = { hostId: 'host', conversationId: 'conversation' };`,
  cases: [
    ["parseServiceResponse({ op: 'metadata' }, null);", null],
    ["const response: ServiceResponse<FrontendBinding> = parseServiceResponse({ op: 'frontend-binding', scope, id: 'command', action: 'recover' }, null); void response;", null],
    ["function transport<K extends ServiceRequest['op']>(request: ServiceRequest & { readonly op: K }): ServiceResponse<ServiceValueMap[K]> { return parseServiceResponse<K>(request, null); } void transport;", null],
    ["parseServiceResponse({ op: 'frontend-binding' }, null);", /not assignable|missing/u],
    ["parseServiceResponse({ op: 'frontend-binding', scope, action: 'recover' }, null);", /not assignable|missing/u],
    ["parseServiceResponse({ op: 'frontend-binding', id: 'command', action: 'recover' }, null);", /not assignable|missing/u],
  ],
}));

test('host binding requires the lazy scoped register and cancel capability', () => assertCompileCases({
  config: new URL('../../packages/host/tsconfig.json', import.meta.url).pathname,
  prefix: `import type { LocalHost, FrontendSendActor } from '@agentui/host';
    export declare const host: LocalHost<unknown, unknown>;
    export declare const actor: FrontendSendActor;
    export declare const producerFor: Parameters<typeof host.frontendBinding>[2];
    export const request = { scope: { hostId: 'host', conversationId: 'conversation' }, id: 'command', action: 'recover' as const };`,
  cases: [
    ['host.frontendBinding(request, actor, producerFor);', null],
    ['host.frontendBinding(request, actor);', /Expected 3 arguments/u],
    ['host.frontendBinding(request, actor, producerFor(request.scope));', /not assignable/u],
    ['host.frontendBinding(request, actor, () => ({ register() {} }));', /cancel/u],
  ],
}));

test('frontend wire definitions retain object-valued parameters and nested boolean schemas', () => {
  const request = structuredClone(cases[0].request);
  request.command.body.frontend.tools[0].definition.parameters = { properties: { enabled: true } };
  assert.deepEqual(parseServiceRequest(request), request);
  request.command.body.frontend.tools[0].definition.parameters = true;
  assert.throws(() => parseServiceRequest(request));
});
