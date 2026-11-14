import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixture, installed, scope, command, snapshot, until } from './fixture.mjs';

function worker(t, mode, f) {
  const child = fork(fileURLToPath(new URL('./process-worker.mjs', import.meta.url)), [mode, f.path, f.backendPath], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let result, output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => { if (message.kind === 'ready') resolve(); else result = message; });
    child.once('error', reject);
  });
  const exited = new Promise(resolve => child.once('exit', code => resolve({ code, result, output })));
  return { child, ready, exited };
}
test('child crash after external acceptance leaves recovery-only intent; retry never repeats native entry', async t => {
  const f = fixture(t), host = f.open();
  host.createConversation(scope, installed);
  host.close();
  const child = worker(t, 'crash', f);
  await child.ready;
  child.child.send('start');
  const exit = await child.exited;
  assert.equal(exit.code, 73, exit.output);
  assert.equal(readFileSync(f.backendPath, 'utf8').trim().split('\n').length, 1);
  const recovered = f.open();
  const retry = await recovered.conversation(scope).submit(command('process-command'));
  assert.equal(retry.receipt.state.kind, 'pending');
  assert.equal(readFileSync(f.backendPath, 'utf8').trim().split('\n').length, 1);
  assert.equal((await recovered.reconcile(scope, 'process-command')).state.kind, 'completed');
  assert.deepEqual((await snapshot(recovered.conversation(scope))).document.domain, ['external-effect']);
  assert.equal(readFileSync(f.backendPath, 'utf8').trim().split('\n').length, 1);
});

test('two independent processes race one id and produce one recorded external entry', async t => {
  const f = fixture(t), host = f.open();
  host.createConversation(scope, installed);
  host.close();
  const a = worker(t, 'race', f), b = worker(t, 'race', f);
  await Promise.all([a.ready, b.ready]);
  a.child.send('start');
  b.child.send('start');
  const exits = await Promise.all([a.exited, b.exited]);
  for (const exit of exits) {
    assert.equal(exit.code, 0, exit.output);
    assert.equal(exit.result.kind, 'result');
    assert.equal(exit.result.result.kind, 'receipt');
  }
  assert.equal(readFileSync(f.backendPath, 'utf8').trim().split('\n').length, 1);
  const reopened = f.open();
  assert.deepEqual((await snapshot(reopened.conversation(scope))).document.domain, ['external-effect']);
});

test('polling delivers a child commit even when the process exits before post-commit wakeup', async t => {
  const f = fixture(t), host = f.open({ budgets: { pollMs: 5 } });
  host.createConversation(scope, installed);
  const seen = [];
  const feed = host.conversation(scope).watch({ after: 0, projectionVersion: 1 }, async item => {
    seen.push(...item.events);
  });
  const child = worker(t, 'commit-crash', f);
  await child.ready;
  child.child.send('start');
  assert.equal((await child.exited).code, 74);
  await until(() => seen.length === 1);
  assert.equal(seen[0].sequence, 1);
  assert.equal(seen[0].event.event.text, 'committed-before-wakeup');
  feed.close();
  assert.equal((await feed.ended).cursor, 1);
});
