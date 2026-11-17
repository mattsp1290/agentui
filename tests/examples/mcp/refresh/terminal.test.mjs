import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { appendFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { syntheticReceipt } from './receipt-fixture.mjs';
import { absent, main, synthetic, until } from './support.mjs';

const journal = process.env.AGENTUI_MCP_RESOURCE_JOURNAL;
const record = async value => { if (journal) await appendFile(journal, JSON.stringify(value) + '\n'); };
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'terminal-proof', version: '1' } } };
const call = { jsonrpc: '2.0', id: 'original-rpc', method: 'tools/call', params: { name: 'agentui_refresh', arguments: { operation: { kind: 'request', id: 'original', reference: { repository: '/source', commit: 'a'.repeat(40) }, expectedSelectionRevision: 0 } } } };
async function start(t, mode, patch = '', rpcId = call.id) {
  const f = await synthetic(t, mode), preload = join(f.root, 'fault.mjs');
  await writeFile(preload, `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; ${patch}`);
  const child = spawn(process.execPath, ['--import', preload, main, f.entry, f.root, '10000'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PROVIDER_SECRET_SENTINEL: 'never-forward' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; }); child.stdin.on('error', () => {});
  const closed = once(child, 'close');
  t.after(async () => { if (!absent(child.pid)) child.kill('SIGKILL'); await closed; });
  await record({ type: 'adapter', fixtureBytes: Buffer.byteLength(mode), pid: child.pid, root: f.root, ports: [] });
  child.stdin.write(JSON.stringify(init) + '\n');
  await until(() => stdout.includes('"id":1'));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' + JSON.stringify({ ...call, id: rpcId }) + '\n');
  const observed = await until(f.read);
  await record({ type: 'cli', ...observed });
  return { ...f, child, closed, observed, stdout: () => stdout, stderr: () => stderr };
}

for (const mode of ['eof', 'signals', 'stdin-error', 'stdout-error', 'owner-kill']) test(`actual SDK stdio synthetic ${mode} has no late reply and removes the exact CLI group/source`, { timeout: 8000 }, async t => {
  const patch = mode === 'stdin-error' ? `process.on('SIGUSR2',()=>process.stdin.emit('error',new Error('injected stdin failure')));` : '';
  const f = await start(t, `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`, patch);
  assert.equal(f.observed.env.PROVIDER_SECRET_SENTINEL, undefined);
  if (mode === 'eof') f.child.stdin.end();
  if (mode === 'signals') { f.child.kill('SIGTERM'); f.child.kill('SIGINT'); }
  if (mode === 'stdin-error') f.child.kill('SIGUSR2');
  if (mode === 'stdout-error') {
    f.child.stdout.destroy();
    f.child.stdin.write(JSON.stringify({ ...init, id: 2 }) + '\n');
  }
  if (mode === 'owner-kill') f.child.kill('SIGKILL');
  const [code, signal] = await f.closed;
  if (mode === 'owner-kill') assert.equal(signal, 'SIGKILL'); else assert.equal(code, 0);
  await until(() => absent(f.observed.pid, true));
  await until(() => !existsSync(dirname(f.observed.source)));
  assert.equal(f.stdout().includes('"id":"original-rpc"'), false);
  assert.equal(f.stderr(), '');
  await record({ type: 'absent', adapter: f.child.pid, group: f.observed.pid, source: f.observed.source, directory: dirname(f.observed.source) });
});

for (const mode of ['removal-failure', 'removal-hang', 'observer-failure', 'kill-unavailable']) test(`synthetic ${mode} exits nonzero within the terminal bound and preserves cleanup uncertainty`, { timeout: 10000 }, async t => {
  let patch = '';
  if (mode === 'removal-failure') patch = `fs.unlink=async()=>{throw new Error('injected removal failure')};syncBuiltinESMExports();`;
  if (mode === 'removal-hang') patch = `fs.unlink=()=>new Promise(()=>{});syncBuiltinESMExports();`;
  if (mode === 'observer-failure') patch = `const actual=process.kill;process.kill=(pid,signal)=>{if(pid<0&&signal===0)throw Object.assign(new Error('injected observer failure'),{code:'EPERM'});return actual(pid,signal)};`;
  if (mode === 'kill-unavailable') patch = `const actual=process.kill;process.kill=(pid,signal)=>{if(pid<0)return true;return actual(pid,signal)};`;
  const program = `process.on('SIGTERM',()=>{});${mode === 'kill-unavailable' ? "process.stdin.removeAllListeners('end');process.stdin.removeAllListeners('error');" : ''}setInterval(()=>{},1000);`;
  const f = await start(t, program, patch);
  const started = Date.now(); f.child.stdin.end();
  const [code] = await f.closed;
  assert.equal(code, 75); assert.ok(Date.now() - started < 3500);
  assert.equal(f.stdout().includes('"id":"original-rpc"'), false);
  if (mode === 'kill-unavailable') {
    assert.equal(absent(f.observed.pid, true), false);
    await record({ type: 'outer-harness-cleanup', reason: 'deliberately unconfirmed fixture group', group: f.observed.pid, source: f.observed.source });
    process.kill(-f.observed.pid, 'SIGKILL');
  }
  await until(() => absent(f.observed.pid, true));
  if (existsSync(dirname(f.observed.source))) {
    await record({ type: 'outer-harness-cleanup', reason: 'source retained after deliberately unconfirmed fixture death', source: f.observed.source });
    await rm(dirname(f.observed.source), { recursive: true });
  }
  assert.equal(existsSync(f.observed.source), false);
  await record({ type: 'absent', adapter: f.child.pid, group: f.observed.pid, source: f.observed.source, directory: dirname(f.observed.source) });
});

test('actual SDK input is bounded at 64 KiB including coalesced messages', { timeout: 5000 }, async t => {
  const f = await start(t, `setInterval(()=>{},1000);`);
  f.child.stdin.write(Buffer.alloc(65537, 32));
  const [code] = await f.closed;
  assert.equal(code, 0);
  await until(() => absent(f.observed.pid, true));
  assert.equal(existsSync(f.observed.source), false);
  assert.equal(f.stdout().includes('"id":"original-rpc"'), false);
});

for (const mode of ['escaped', 'oversized']) test(`actual SDK stdio ${mode} canonical receipt preserves actual long RPC ID`, { timeout: 10000 }, async t => {
  const receipt = syntheticReceipt(), rpcId = '"\\'.repeat(4096);
  receipt.job.build.provenance.sdkVersion = mode === 'escaped' ? '"\\\n'.repeat(1000000) : '';
  if (mode === 'oversized') receipt.job.build.provenance.sdkVersion = 'x'.repeat(16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(receipt)));
  const f = await start(t, `console.log(JSON.stringify({ok:true,value:${JSON.stringify(receipt)}}));`, '', rpcId);
  const response = await until(() => {
    for (const line of f.stdout().split('\n').filter(Boolean)) {
      try { const value = JSON.parse(line); if (value.id === rpcId) return value; } catch {}
    }
  });
  assert.equal(response.id, rpcId);
  assert.equal(response.result.structuredContent.requestId, 'original');
  if (mode === 'escaped') assert.deepEqual(response.result.structuredContent.receipt, receipt);
  else { assert.equal(response.result.isError, true); assert.match(response.result.content[0].text, /direct installed-CLI status/); }
  assert.ok(Buffer.byteLength(JSON.stringify(response) + '\n') <= 8 * 1024 * 1024);
  f.child.stdin.end(); assert.equal((await f.closed)[0], 0);
  assert.equal(absent(f.observed.pid, true), true); assert.equal(existsSync(f.observed.source), false);
});
