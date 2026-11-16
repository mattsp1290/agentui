import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCommand } from '@agentui/contracts';
import { parseServiceRequest, parseServiceResponse } from '@agentui/contracts/service';

const scope = { hostId: 'host', conversationId: 'conversation' };
const permission = { permissionId: 'permission', scope: 'conversation', actionLabel: 'Create work items', detail: 'This conversation' };
const read = value => parseServiceResponse({ op: 'conversation-permissions' }, { ok: true, value });

test('permission service reads decode bounded complete listings and preserve unsupported outcomes', () => {
  assert.deepEqual(parseServiceRequest({ op: 'conversation-permissions', scope }), { op: 'conversation-permissions', scope });
  const listing = { kind: 'available', observedAt: '2026-11-16T00:00:00.000Z', permissions: [permission] };
  for (const value of [listing, { ...listing, permissions: [] }, { kind: 'unsupported', reason: 'No supported permission domain' },
    { kind: 'unavailable', reason: 'Read failed' }]) assert.deepEqual(read(value), { ok: true, value });
  for (const value of [{ ...listing, observedAt: 'invalid' }, { ...listing, permissions: [permission, permission] },
    { ...listing, permissions: [{ ...permission, scope: 'member' }] }, { ...listing, permissions: Array(1001).fill(permission) },
    { ...listing, permissions: [{ ...permission, detail: 'x'.repeat(1025) }] }]) assert.throws(() => read(value));
});

test('revoke intents require exact permission identity and owner-confirmed scope', () => {
  const command = { version: 1, scope, clientCommandId: 'revoke', body: { kind: 'revoke-permission', permissionId: 'permission', scope: 'agent' } };
  assert.deepEqual(parseCommand(command), command);
  for (const body of [{ ...command.body, scope: 'member' }, { ...command.body, scope: undefined },
    { ...command.body, permissionId: '' }, { ...command.body, runId: 'run' }]) assert.throws(() => parseCommand({ ...command, body }));
});
