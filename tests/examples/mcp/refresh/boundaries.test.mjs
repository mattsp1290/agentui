import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { EXTENSION_SDK_VERSION, SERVICE_WIRE_VERSION } from '@agentui/contracts/compatibility';
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import test from 'node:test';
import { canonicalOutput, operation, toolInput } from '../../../../examples/mcp-control/refresh/dist/refresh.js';
import { outgoingLimit, present } from '../../../../examples/mcp-control/refresh/dist/main.js';
import { parseRefreshReceipt } from '../../../../apps/host/build/tsc/refresh-jobs.js';
import { syntheticReceipt } from './receipt-fixture.mjs';
import { directory, main, recordResource } from './support.mjs';


const bytes = value => Buffer.from(JSON.stringify(value));
const wire = (value, id) => Buffer.byteLength(serializeMessage({ jsonrpc: '2.0', id, result: value }));

test('symlinked executable still validates startup instead of silently exiting', async t => {
  const link = join(await directory(t), 'refresh.mjs');
  await symlink(main, link);
  const child = spawn(process.execPath, [link], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const exited = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  await recordResource({ type: 'cli', pid: child.pid, processGroup: child.pid });
  assert.equal(await exited, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /AgentUI refresh MCP startup failed/u);
});

test('strict operation union rejects command/path controls and leaves references unchanged', () => {
  const input = { kind: 'request', id: 'original', expectedSelectionRevision: 0, reference: { repository: '-repo', commit: 'A'.repeat(40) } };
  assert.deepEqual(operation.parse(input), input);
  for (const invalid of [{ ...input, command: 'sh' }, { ...input, source: '/path' }, { kind: 'status', id: 'original', reference: input.reference }, { kind: 'promote', id: 'original', expectedSelectionRevision: 0 }, { ...input, reference: { ...input.reference, extra: true } }, { ...input, expectedSelectionRevision: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal(operation.safeParse(invalid).success, false);
  assert.equal(toolInput.safeParse({ operation: input, path: '/' }).success, false);
});

test('fatal UTF-8, exact CLI success envelope, and original identity are checked without receipt variants', () => {
  const receipt = syntheticReceipt();
  assert.deepEqual(parseRefreshReceipt(receipt), receipt);
  assert.deepEqual(canonicalOutput(bytes({ ok: true, value: receipt }), 'original').receipt, receipt);
  for (const value of [Buffer.from([255]), bytes({ ok: false, value: receipt }), bytes({ ok: true, value: receipt, extra: true }), bytes({ ok: true, value: [] }), bytes({ ok: true, value: {} }), Buffer.concat([bytes({ ok: true, value: receipt }), bytes({ ok: true, value: receipt })])]) assert.throws(() => canonicalOutput(value, 'original'));
  assert.throws(() => canonicalOutput(bytes({ ok: true, value: receipt }), 'replacement'));
});

test('actual serializer admits exact output limit with quoted long RPC ID and never mirrors/truncates large canonical receipts', () => {
  const rpcId = '"\\'.repeat(4096), receipt = syntheticReceipt();
  receipt.job.build.provenance.sdkVersion = '"\\\n'.repeat(1000000);
  assert.deepEqual(parseRefreshReceipt(receipt), receipt);
  const outcome = canonicalOutput(bytes({ ok: true, value: receipt }), 'original');
  const shown = present(outcome, rpcId);
  assert.equal(shown.structuredContent.kind, 'receipt');
  assert.equal(shown.content.length, 1); assert.ok(shown.content[0].text.length < 300);
  assert.equal(shown.structuredContent.receipt.job.build.provenance.sdkVersion, receipt.job.build.provenance.sdkVersion);
  const plain = syntheticReceipt(); plain.job.build.provenance.sdkVersion = '';
  const base = canonicalOutput(bytes({ ok: true, value: plain }), 'original');
  plain.job.build.provenance.sdkVersion = 'x'.repeat(outgoingLimit - wire(present(base, rpcId), rpcId));
  const exact = canonicalOutput(bytes({ ok: true, value: plain }), 'original');
  assert.equal(wire(present(exact, rpcId), rpcId), outgoingLimit);
  plain.job.build.provenance.sdkVersion += 'x';
  const over = present(canonicalOutput(bytes({ ok: true, value: plain }), 'original'), rpcId);
  assert.equal(over.structuredContent.kind, 'adapter-error'); assert.equal(over.structuredContent.requestId, 'original');
  assert.match(over.content[0].text, /direct installed-CLI status/); assert.ok(wire(over, rpcId) < 20000);
  plain.job.build.provenance.sdkVersion = '';
  plain.job.build.provenance.sdkVersion = 'x'.repeat(16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(plain)));
  assert.equal(Buffer.byteLength(JSON.stringify(plain)), 16 * 1024 * 1024);
  assert.deepEqual(parseRefreshReceipt(plain), plain);
  assert.equal(present(canonicalOutput(bytes({ ok: true, value: plain }), 'original'), rpcId).structuredContent.kind, 'adapter-error');
});

test('compiled fixture compatibility matches current checkout source', async () => {
  const source = await readFile(new URL('../../../../packages/contracts/src/compatibility.ts', import.meta.url), 'utf8');
  assert.equal(EXTENSION_SDK_VERSION, /EXTENSION_SDK_VERSION = '([^']+)'/u.exec(source)?.[1]);
  assert.equal(SERVICE_WIRE_VERSION, Number(/SERVICE_WIRE_VERSION = (\d+)/u.exec(source)?.[1]));
});
