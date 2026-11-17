import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openReportExample } from '@agentui/example-generated-text-output';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';

assert.equal(EXTENSION_SDK_VERSION, '0.10.0');
process.env.AGENTUI_REPORT_DATABASE = join(process.cwd(), 'reports.sqlite');
const scope = { hostId: 'packed', conversationId: 'reports' }, hostPath = join(process.cwd(), 'host.sqlite');
let example = await openReportExample({ hostPath, scope });
try {
  const commandId = randomUUID(), text = 'Packed consumer report. é🐦\n';
  const receipt = await example.send(text, commandId);
  assert.equal(receipt.receipt.state.kind, 'completed');
  const original = example.host.creation(scope);
  const first = (await example.outputs()).outputs[0], bytes = await example.read(first.outputId);
  assert.equal(new TextDecoder().decode(bytes.bytes), text);
  for (let i = 1; i < 33; i++) assert.equal((await example.send('Report ' + i, randomUUID())).receipt.state.kind, 'completed');
  const retained = await example.outputs(); assert.equal(retained.outputs.length, 32);
  const newest = retained.outputs.at(-1), newestBytes = await example.read(newest.outputId);
  assert.equal(new TextDecoder().decode(newestBytes.bytes), 'Report 32');
  assert.equal((await example.read(first.outputId)).kind, 'missing');
  await example.close(); example = await openReportExample({ hostPath, scope });
  assert.deepEqual(example.host.creation(scope), original);
  assert.deepEqual(await example.send(text, commandId), receipt);
  assert.deepEqual(await example.host.reconcile(scope, commandId), receipt.receipt);
  assert.equal((await example.send('changed', commandId)).kind, 'rejected');
  assert.equal((await example.send('', randomUUID())).kind, 'rejected');
  assert.deepEqual(await example.outputs(), retained);
  assert.deepEqual(await example.read(newest.outputId), newestBytes);
  assert.equal((await example.read(first.outputId)).kind, 'missing');
  console.log('Packed SDK 0.9 entry, LocalHost, 33 outputs, replay, conflict and restart passed.');
} finally { await example.close(); }
