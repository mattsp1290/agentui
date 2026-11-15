import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostDependencyManifest, importHostDependency } from '../../host/test-support/dependencies.mjs';
import { parseInteractionContinuation, parseSessionReference } from '@agentui/host';

const root = new URL('../../../', import.meta.url);
const binding = { engine: 'fixture/native', nativeVersion: '1', account: 'fixture-account', authorizedScope: 'fixture-scope', nativeFormat: 'fixture-format' };
const session = { kind: 'session', formatVersion: 1, binding, opaque: 'native-session-a' };
const target = { kind: 'approval', session, nativeApprovalId: 'native-approval-a', tool: null };
const native = { namespace: 'fixture/native', schemaVersion: 1, data: { fixture: true } };
const pending = { kind: 'approval', target, nativePolicy: native, request: native,
  choices: [{ nativeChoiceId: 'native-once', label: 'Allow once' }] };
const reply = { formatVersion: 1, kind: 'approval', target, nativeChoiceId: 'native-once' };

test('host artifact and retained logs match the pin, manifest and npm integrity', async () => {
  const pin = JSON.parse(await readFile(new URL('vendor/switchboard.json', root), 'utf8'));
  const host = JSON.parse(await readFile(new URL('packages/host/package.json', root), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
  assert.match(pin.sourceRevision, /^[a-f0-9]{40}$/u);
  assert.equal(pin.artifact, `switchboard-${pin.sourceRevision}.tgz`);
  const bytes = await readFile(new URL(`vendor/${pin.artifact}`, root));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256);
  assert.equal(host.dependencies['@mattsp1290/switchboard'], `file:../../vendor/${pin.artifact}`);
  const installedPath = relative(fileURLToPath(root), dirname(hostDependencyManifest('@mattsp1290/switchboard'))).split(sep).join('/');
  const installed = lock.packages[installedPath];
  assert.equal(installed.resolved, `file:vendor/${pin.artifact}`);
  assert.equal(installed.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  for (const [name, log] of Object.entries(pin.qualification.logs)) {
    const raw = gunzipSync(await readFile(new URL(`vendor/${log.path}`, root)));
    assert.equal(createHash('sha256').update(raw).digest('hex'), log.uncompressedSha256, name);
  }
});

test('all runtime aliases expose the current public Switchboard entries and exact peers', async () => {
  const pin = JSON.parse(await readFile(new URL('vendor/switchboard.json', root), 'utf8'));
  const host = JSON.parse(await readFile(new URL('packages/host/package.json', root), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
  for (const [alias, pinFile] of [
    ['@mattsp1290/switchboard', 'switchboard.json'],
    ['@agentui/switchboard-pi', 'switchboard-pi.json'],
    ['@agentui/switchboard-codex', 'switchboard-codex.json'],
    ['@agentui/switchboard-claude', 'switchboard-claude.json'],
  ]) {
    const adapterPin = JSON.parse(await readFile(new URL(`vendor/${pinFile}`, root), 'utf8'));
    assert.equal(adapterPin.sourceRevision, pin.sourceRevision, alias);
    assert.equal(adapterPin.sha256, pin.sha256, alias);
    assert.equal(host.dependencies[alias], `file:../../vendor/${pin.artifact}`, alias);
    const manifestPath = hostDependencyManifest(alias);
    const installedPath = relative(fileURLToPath(root), dirname(manifestPath)).split(sep).join('/');
    assert.equal(lock.packages[installedPath].resolved, `file:vendor/${pin.artifact}`, alias);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.peerDependencies['@opentelemetry/api'], host.dependencies['@opentelemetry/api']);
    for (const [entry, exported] of [
      ['', 'createDispatchOperation'], ['/agui', 'createAguiProjection'], ['/testkit', 'createFakeFixture'],
      ['/pi', 'createPiRuntime'], ['/codex', 'createCodexRuntime'], ['/claude', 'createClaudeRuntime'],
      ['/observability', 'createGenAiObserver'],
    ]) {
      assert.equal(typeof (await importHostDependency(`${alias}${entry}`))[exported], 'function', `${alias}${entry}`);
    }
    await assert.rejects(importHostDependency(`${alias}/dist/index.js`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});

test('historical Switchboard receipts retain their original artifacts and log bytes', async () => {
  const current = JSON.parse(await readFile(new URL('vendor/switchboard.json', root), 'utf8'));
  for (const name of ['switchboard', 'switchboard-pi', 'switchboard-codex', 'switchboard-claude']) {
    const active = JSON.parse(await readFile(new URL(`vendor/${name}.json`, root), 'utf8'));
    const historical = JSON.parse(await readFile(new URL(`vendor/${active.historicalRecord}`, root), 'utf8'));
    assert.notEqual(historical.sourceRevision, current.sourceRevision);
    const bytes = await readFile(new URL(`vendor/${historical.artifact}`, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), historical.sha256);
    for (const [name, log] of Object.entries(historical.qualification?.logs ?? {})) {
      const raw = gunzipSync(await readFile(new URL(`vendor/${log.path}`, root)));
      assert.equal(createHash('sha256').update(raw).digest('hex'), log.uncompressedSha256, name);
    }
  }
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
