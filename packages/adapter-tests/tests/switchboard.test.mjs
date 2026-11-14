import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseInteractionContinuation, parseSessionReference } from '@agentui/host';

const root = new URL('../../../', import.meta.url);
const binding = { engine: 'fixture/native', nativeVersion: '1', account: 'fixture-account', authorizedScope: 'fixture-scope', nativeFormat: 'fixture-format' };
const session = { kind: 'session', formatVersion: 1, binding, opaque: 'native-session-a' };
const target = { kind: 'approval', session, nativeApprovalId: 'native-approval-a', tool: null };
const native = { namespace: 'fixture/native', schemaVersion: 1, data: { fixture: true } };
const pending = { kind: 'approval', target, nativePolicy: native, request: native,
  choices: [{ nativeChoiceId: 'native-once', label: 'Allow once' }] };
const reply = { formatVersion: 1, kind: 'approval', target, nativeChoiceId: 'native-once' };

test('host artifact matches its source pin, manifest and npm integrity', async () => {
  const pin = JSON.parse(await readFile(new URL('vendor/switchboard.json', root), 'utf8'));
  const host = JSON.parse(await readFile(new URL('packages/host/package.json', root), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
  assert.match(pin.sourceRevision, /^[a-f0-9]{40}$/u);
  assert.equal(pin.artifact, `switchboard-${pin.sourceRevision}.tgz`);
  const bytes = await readFile(new URL(`vendor/${pin.artifact}`, root));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256);
  assert.equal(host.dependencies['@mattsp1290/switchboard'], `file:../../vendor/${pin.artifact}`);
  const installed = lock.packages['node_modules/@mattsp1290/switchboard'];
  assert.equal(installed.resolved, `file:vendor/${pin.artifact}`);
  assert.equal(installed.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
});

test('host parses a native session and preserves an advertised approval choice', () => {
  assert.deepEqual(parseSessionReference({ value: session, expected: binding }), { kind: 'ok', value: session });
  assert.deepEqual(parseInteractionContinuation({ value: reply, expected: pending }), { kind: 'ok', value: reply });
});

test('host rejects continuation binding, session, target and choice mismatches', () => {
  const cases = Object.keys(binding).map((field) => [
    { ...reply, target: { ...target, session: { ...session, binding: { ...binding, [field]: 'other' } } } },
    'binding-mismatch',
  ]);
  cases.push(
    [{ ...reply, target: { ...target, session: { ...session, opaque: 'other-session' } } }, 'session-mismatch'],
    [{ ...reply, target: { ...target, nativeApprovalId: 'other-approval' } }, 'target-mismatch'],
    [{ ...reply, target: { ...target, tool: { nativeToolCallId: 'other-tool' } } }, 'target-mismatch'],
    [{ ...reply, nativeChoiceId: 'host-permit' }, 'choice-mismatch'],
    [{ ...reply, formatVersion: 2 }, 'unsupported-version'],
    [{ formatVersion: 1, kind: 'withhold' }, 'invalid-input'],
    [null, 'invalid-input'],
  );
  for (const [value, code] of cases) {
    assert.deepEqual(parseInteractionContinuation({ value, expected: pending }), { kind: 'error', error: { code } }, code);
  }
});

test('host preserves tool failure, occurred effects and unknown delivery independently', () => {
  const tool = { kind: 'tool', session, nativeToolCallId: 'native-tool-a' };
  const value = { formatVersion: 1, kind: 'tool', outcome: {
    target: tool, result: { kind: 'error', error: native },
    effect: { kind: 'known', effect: 'occurred', evidence: native }, delivery: { kind: 'unknown' },
  } };
  assert.deepEqual(parseInteractionContinuation({ value, expected: { kind: 'tool', target: tool } }), { kind: 'ok', value });
});
