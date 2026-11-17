import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import test from 'node:test';
import { RefreshSession } from '../../../../examples/mcp-control/refresh/dist/refresh.js';
import { absent, synthetic, until } from './support.mjs';

const success = `console.log(JSON.stringify({ok:true,value:{job:{request:{id}}}}));`;
const input = { kind: 'request', id: 'original', reference: { repository: '-repo', commit: 'A'.repeat(40) }, expectedSelectionRevision: 0 };
async function fixture(t, mode, waitMs = 600) {
  const f = await synthetic(t, mode);
  const session = new RefreshSession({ executable: process.execPath, installedEntry: f.entry, hostDirectory: f.root, invocationDirectory: process.cwd(), waitMs });
  t.after(async () => { assert.equal(await session.close(), true); });
  return { ...f, session, invoke: (signal = new AbortController().signal) => session.invoke(input, signal) };
}
async function cleaned(f) {
  const record = await until(f.read);
  await until(() => absent(record.pid, true));
  assert.equal(existsSync(record.source), false);
  assert.equal(existsSync(dirname(record.source)), false);
  return record;
}

test('synthetic CLI receives unchanged reference, fixed launch cwd, fixed argv and minimal environment', async t => {
  const cwd = process.cwd(), f = await fixture(t, success);
  const task = f.invoke(); process.chdir(f.root);
  try { assert.equal((await task).kind, 'receipt'); } finally { process.chdir(cwd); }
  const record = await cleaned(f);
  assert.equal(record.cwd, cwd); assert.deepEqual(record.reference, input.reference);
  assert.deepEqual(Object.keys(record.env).filter(key => key !== '__CF_USER_TEXT_ENCODING').sort(), ['AGENTUI_REFRESH_SOURCE', 'AGENTUI_REFRESH_WAIT_MS', 'LANG']);
  assert.equal(record.args[0], 'extensions-refresh-request');
  assert.equal(record.args.includes('--expected-revision'), true);
});

for (const [name, program, reason] of [
  ['nonzero', `process.stderr.write('Refresh invented-canonical-kind');process.exitCode=2;`, 'cli-exit'],
  ['invalid-utf8', `process.stdout.write(Buffer.from([255]));`, 'invalid-output'],
  ['wrong-id', `console.log(JSON.stringify({ok:true,value:{job:{request:{id:'wrong'}}}}));`, 'invalid-output'],
  ['stdout-flood', `process.stdout.write('x'.repeat(16*1024*1024+22));setInterval(()=>{},1000);`, 'output-limit'],
  ['stderr-flood', `process.stderr.write('x'.repeat(65537));setInterval(()=>{},1000);`, 'output-limit'],
  ['timeout', `setInterval(()=>{},1000);`, 'timeout'],
  ['inherited-pipes', `spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore',process.stdout,process.stderr]}).unref();`, 'inherited-pipes'],
]) test(`synthetic ${name} retains original ID and confirms file/group cleanup`, { timeout: 5000 }, async t => {
  const f = await fixture(t, program);
  const result = await f.invoke();
  assert.equal(result.kind, 'adapter-error'); assert.equal(result.requestId, 'original');
  assert.equal(result.reason, reason);
  await cleaned(f);
});

test('three waits admit immediately and cancellation drains only their own CLI groups', async t => {
  const f = await fixture(t, `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`, 3000);
  const signals = Array.from({ length: 3 }, () => new AbortController());
  const tasks = signals.map(signal => f.invoke(signal.signal));
  assert.equal((await f.invoke()).reason, 'busy');
  await until(f.records, values => values.length === 3);
  await f.read();
  signals.forEach(signal => signal.abort());
  for (const result of await Promise.all(tasks)) assert.equal(result.reason, 'cancelled');
  for (const entry of await f.records()) { assert.equal(absent(entry.pid, true), true); assert.equal(existsSync(dirname(entry.source)), false); }
  await cleaned(f);
});

test('already-cancelled and synchronously closed sessions spawn nothing', async t => {
  const f = await fixture(t, success), cancelled = AbortSignal.abort();
  assert.equal((await f.invoke(cancelled)).reason, 'cancelled');
  const close = f.session.close();
  assert.equal((await f.invoke()).reason, 'closed');
  assert.equal(await close, true); assert.equal(await f.read(), null);
});

for (const boundary of ['mkdtemp', 'writeFile']) test(`close during asynchronous ${boundary} preparation cleans before returning`, async t => {
  const f = await fixture(t, success), actual = fs[boundary];
  let created;
  const mock = t.mock.method(fs, boundary, async (...args) => {
    const result = await actual(...args); created = boundary === 'mkdtemp' ? result : dirname(args[0]);
    void f.session.close(); return result;
  });
  syncBuiltinESMExports();
  try { assert.equal((await f.invoke()).reason, 'cancelled'); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(existsSync(created), false); assert.equal(await f.read(), null);
});

test('failed exclusive source write removes its exact attempt directory', async t => {
  const f = await fixture(t, success); let path;
  const mock = t.mock.method(fs, 'writeFile', async value => { path = value; throw new Error('injected write failure'); });
  syncBuiltinESMExports();
  try { assert.equal((await f.invoke()).reason, 'io'); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(existsSync(dirname(path)), false); assert.equal(await f.read(), null);
});

for (const mode of ['spawn-failure', 'guard-startup-failure', 'stream-error']) test(`synthetic ${mode} reaches parent cleanup after child close`, async t => {
  const f = await fixture(t, `setInterval(()=>{},1000);`), actual = childProcess.spawn;
  let source;
  const mock = t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    source = options.env.AGENTUI_REFRESH_SOURCE;
    const child = actual(mode === 'spawn-failure' ? '/nonexistent-agentui-test-node' : executable,
      mode === 'guard-startup-failure' ? ['--import', '/nonexistent-agentui-test-guard', ...args.slice(2)] : args, options);
    if (mode === 'stream-error') child.once('spawn', () => child.stdout.emit('error', new Error('injected stream failure')));
    return child;
  });
  syncBuiltinESMExports();
  try { assert.equal((await f.invoke()).reason, mode === 'spawn-failure' ? 'spawn' : mode === 'guard-startup-failure' ? 'cli-exit' : 'io'); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(existsSync(source), false); assert.equal(existsSync(dirname(source)), false);
});

test('cancellation during parent cleanup cannot return a late receipt', async t => {
  const f = await fixture(t, success), actual = fs.unlink, cancelled = new AbortController();
  const mock = t.mock.method(fs, 'unlink', async (...args) => { try { return await actual(...args); } finally { cancelled.abort(); } });
  syncBuiltinESMExports();
  try { assert.equal((await f.invoke(cancelled.signal)).reason, 'cancelled'); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  await cleaned(f);
});

test('exact 64 KiB CLI stderr allowance does not reject a successful receipt', async t => {
  const f = await fixture(t, `process.stderr.write('x'.repeat(65536));${success}`);
  assert.equal((await f.invoke()).kind, 'receipt');
  await cleaned(f);
});
