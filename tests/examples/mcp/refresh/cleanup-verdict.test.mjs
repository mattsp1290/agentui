import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { RefreshSession } from '../../../../examples/mcp-control/refresh/dist/refresh.js';
import { absent, main, recordResource, synthetic, until } from './support.mjs';

const input = { kind: 'request', id: 'original', reference: { repository: '/source', commit: 'a'.repeat(40) }, expectedSelectionRevision: 0 };
const program = `
const host=args[args.indexOf('--data-dir')+1];
process.on('SIGTERM',()=>{});
spawn(process.execPath,['-e',\`require('node:fs').writeFileSync(\${JSON.stringify(host+'/pipe-holder.json')},JSON.stringify({pid:process.pid,parent:process.ppid}));setInterval(()=>{},1000);\`],{detached:true,stdio:['ignore',process.stdout,process.stderr]}).unref();
setInterval(()=>{},1000);
`;

async function fault(t) {
  let f, original, holder, session, adapter, closed;
  const note = async value => { t.diagnostic(JSON.stringify(value)); await recordResource(value); };
  const readHolder = async () => JSON.parse(await readFile(join(f.root, 'pipe-holder.json'), 'utf8').catch(() => 'null'));
  t.after(async () => {
    if (adapter && !absent(adapter.pid)) {
      await note({ type: 'outer-harness-cleanup', reason: 'adapter still running after assertion or deadline', pid: adapter.pid });
      adapter.kill('SIGKILL');
    }
    if (closed) await closed;
    if (session) { await session.close(); session.destroy(); }
    original ??= await f?.read();
    holder ??= f ? await readHolder() : null;
    if (original && !absent(original.pid, true)) {
      await note({ type: 'outer-harness-cleanup', reason: 'original fixture group still running', group: original.pid });
      process.kill(-original.pid, 'SIGKILL');
      await until(() => absent(original.pid, true));
    }
    if (holder && !absent(holder.pid)) {
      await note({ type: 'outer-harness-cleanup', reason: 'deliberately detached fixture pipe holder', pid: holder.pid });
      process.kill(holder.pid, 'SIGKILL');
      await until(() => absent(holder.pid));
    }
    if (original && existsSync(dirname(original.source))) {
      await note({ type: 'outer-harness-cleanup', reason: 'source retained without child close confirmation', source: original.source });
      await rm(dirname(original.source), { recursive: true, force: true });
    }
    await note({ type: 'absent', adapter: adapter?.pid, group: original?.pid, helper: holder?.pid, source: original?.source,
      groupAbsent: original ? absent(original.pid, true) : true, helperAbsent: holder ? absent(holder.pid) : true,
      sourceAbsent: original ? !existsSync(dirname(original.source)) : true });
  });
  f = await synthetic(t, program);
  return { ...f, note,
    ownSession: value => { session = value; },
    ownAdapter: value => { adapter = value; closed = once(value, 'close'); return closed; },
    observe: async () => {
      original = await until(f.read);
      holder = await until(readHolder);
      assert.equal(holder.parent, original.pid);
      assert.notEqual(holder.pid, original.pid);
      assert.equal(absent(holder.pid, true), false, 'detached helper owns a different live group');
      await note({ type: 'fixture-ready', group: original.pid, helper: holder.pid, source: original.source });
      return { original, holder };
    },
  };
}

for (const cancelled of [false, true]) test(`missing child close with absent original group preserves cleanup uncertainty${cancelled ? ' over cancellation' : ''}`, { timeout: 6000 }, async t => {
  const f = await fault(t);
  const session = new RefreshSession({ executable: process.execPath, installedEntry: f.entry, hostDirectory: f.root, invocationDirectory: process.cwd(), waitMs: 10000 });
  f.ownSession(session);
  const collect = session.collect.bind(session);
  let verdict, exitSignal;
  session.collect = async (child, signal) => {
    child.once('exit', (_code, signal) => { exitSignal = signal; });
    verdict = await collect(child, signal);
    await f.note({ type: 'collector-verdict', closed: verdict.closed, absent: verdict.absent, reason: verdict.reason, exitSignal });
    return verdict;
  };
  const abort = new AbortController(), task = session.invoke(input, abort.signal);
  const { original, holder } = await f.observe();
  if (cancelled) abort.abort();
  else process.kill(original.pid, 'SIGKILL');
  const outcome = await task, clean = await session.close();
  await f.note({ type: 'session-verdict', outcome, clean, helperAlive: !absent(holder.pid), sourceRetained: existsSync(original.source) });
  assert.equal(exitSignal, 'SIGKILL');
  assert.equal(verdict.closed, false);
  assert.equal(verdict.absent, true);
  assert.equal(verdict.reason, 'cleanup-unconfirmed');
  assert.equal(existsSync(original.source), true, 'unconfirmed close forbids fallback source deletion');
  assert.equal(absent(holder.pid), false, 'adapter did not kill the deliberately escaped helper');
  assert.deepEqual(outcome, { kind: 'adapter-error', requestId: 'original', reason: 'cleanup-unconfirmed' });
  assert.equal(clean, false, 'missing close confirmation prevents a clean session drain');
});

test('actual SDK stdio exits nonzero within bound after separate-group pipe holder survives original SIGKILL', { timeout: 8000 }, async t => {
  const f = await fault(t);
  const adapter = spawn(process.execPath, [main, f.entry, f.root, '10000'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = f.ownAdapter(adapter);
  let stdout = '', stderr = '';
  adapter.stdout.on('data', bytes => { stdout += bytes; });
  adapter.stderr.on('data', bytes => { stderr += bytes; });
  adapter.stdin.on('error', () => {});
  adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cleanup-verdict-proof', version: '1' } } }) + '\n');
  await until(() => stdout.includes('"id":1'));
  adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
    + JSON.stringify({ jsonrpc: '2.0', id: 'original-rpc', method: 'tools/call', params: { name: 'agentui_refresh', arguments: { operation: input } } }) + '\n');
  const { original, holder } = await f.observe();
  const started = Date.now();
  process.kill(original.pid, 'SIGKILL');
  const [code, signal] = await closed;
  const elapsedMs = Date.now() - started;
  await f.note({ type: 'terminal-verdict', adapter: adapter.pid, code, signal, elapsedMs, groupAbsent: absent(original.pid, true),
    helperAlive: !absent(holder.pid), sourceRetained: existsSync(original.source) });
  assert.equal(absent(original.pid, true), true);
  assert.equal(absent(holder.pid), false);
  assert.equal(existsSync(original.source), true);
  assert.equal(code, 75);
  assert.equal(signal, null);
  assert.ok(elapsedMs < 3500, 'terminal exit stays within the shutdown bound');
  assert.equal(stdout.includes('"id":"original-rpc"'), false);
  assert.equal(stderr, '');
});
