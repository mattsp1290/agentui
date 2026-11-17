import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOutputId } from '@agentui/contracts/output';
import { fixture, empty, scope, deferred } from './controller-fixture.mjs';
const id=parseOutputId('output-'+ 'a'.repeat(64));
const listing={kind:'available',outputs:[]};
const read={kind:'available',output:{outputId:id,name:'report.txt',mediaType:'text/plain',byteLength:4,sha256:'a'.repeat(64),lifetime:'provider-retained'},bytes:new Uint8Array([0,239,187,191])};
async function open(t,configure=()=>{}) {
 const f=fixture();t.after(()=>f.app.dispose());
 f.views.set('original-view/host',{...empty(),route:scope});
 f.calls=[];
 f.behavior.outputs=async input=>{f.calls.push(['list',input]);return listing;};
 f.behavior.readOutput=async (input,id)=>{f.calls.push(['read',input,id]);return read;};
 configure(f);await f.app.start();assert.ok(f.app.getSnapshot().active);return f;
}
test('real controller/store stable reader preserves canonical value/error identity and unrelated updates',async t=>{
 const f=await open(t),target=f.app.getSnapshot().active,reader=f.app.conversationActions(target).outputs;
 assert.equal(reader,target.outputs);assert.equal(f.app.conversationActions(target).outputs,reader);
 await target.store.setDraft('unrelated draft');await f.app.moreSavedViews();
 assert.equal(f.app.conversationActions(target).outputs,reader);assert.equal(f.app.conversationActions(target).outputs.list,reader.list);
 assert.equal(await reader.list(),listing);assert.equal(await reader.read(id),read);assert.equal((await reader.read(id)).bytes,read.bytes);
 const failure=new Error('Exact transport failure');f.behavior.readOutput=()=>Promise.reject(failure);f.behavior.outputs=()=>Promise.reject(failure);
 await assert.rejects(reader.read(id),error=>error===failure);await assert.rejects(reader.list(),error=>error===failure);
 assert.equal(f.app.getSnapshot().error,'');assert.equal(f.app.getSnapshot().storageFailure,'');
 assert.deepEqual(f.submitted,[]);
});
for(const method of ['list','read'])for(const rejected of [false,true])for(const transition of ['same-store','navigation','view','host','storage','session']) {
 test(`real ${method} ${rejected?'rejection':'success'} fenced after ${transition}`,async t=>{
  const f=await open(t),target=f.app.getSnapshot().active,reader=target.outputs,gate=deferred(),failure=new Error('OBSOLETE TRANSPORT');
  f.behavior[method==='list'?'outputs':'readOutput']=()=>{f.calls.push([method]);return gate.promise;};
  const pending=reader[method](id);const settled=pending.then(value=>({value}),error=>({error}));
  assert.equal(f.calls.length,1);
  if(transition==='same-store') {await f.app.reconnect();assert.equal(f.app.getSnapshot().active.store,target.store);assert.notEqual(f.app.getSnapshot().active,target);assert.notEqual(f.app.getSnapshot().active.outputs,reader);}
  if(transition==='navigation') await f.app.open({...scope,conversationId:'next'});
  if(transition==='view') {f.views.set('next-view/host',{...empty(),route:scope});await f.app.reopenView('next-view');}
  if(transition==='host') f.connectionLost(new Error('connection lost'));
  if(transition==='storage') f.leases[0].failure(new Error('storage lost'));
  if(transition==='session') {await f.app.dispose();await f.app.start();}
  if (rejected) gate.reject(failure); else gate.resolve(method === 'list' ? listing : read);
  const outcome=await settled;assert.ok(outcome.error instanceof Error);assert.notEqual(outcome.error,failure);
  assert.match(outcome.error.message,/conversation|storage|host|ready/iu);
  await assert.rejects(reader[method](id));assert.equal(f.calls.length,1,'obsolete reader never redispatches');
  assert.deepEqual(f.submitted,[]);
 });
}
test('queries do not inherit busy, agent readiness, feed, or send gates',async t=>{
 const f=await open(t),target=f.app.getSnapshot().active,reader=target.outputs;
 target.store.disconnect();target.agent.commands.splice(0);target.agent.availability={kind:'unavailable',reason:'fixture unavailable'};
 assert.equal(await reader.list(),listing);assert.equal(await reader.read(id),read);
 const gate=deferred();f.behavior.catalog=()=>gate.promise;const busy=f.app.moreConversations();
 assert.equal(f.app.getSnapshot().busy,true);assert.equal(await reader.list(),listing);gate.resolve([]);await busy;
 assert.deepEqual(f.submitted,[]);
});

for(const mode of ['running','concluded'])test(`retained queries succeed in real store ${mode} state`,async t=>{
 const f=await open(t,fixture=>{if(mode==='concluded')fixture.behavior.observation=async()=>({kind:'concluded',cause:'exhausted'});});
 const target=f.app.getSnapshot().active;
 if(mode==='running'){
  const feed=f.feeds.at(-1);await feed.receive({kind:'snapshot',snapshot:{scope:feed.scope,projectionVersion:4,cursor:1,document:{domain:{messages:[],currentRun:{kind:'running',runId:'run'}},decisions:{},receipts:{}}}});
  assert.equal(target.store.getSnapshot().document.domain.currentRun.kind,'running');
 }else{await new Promise(resolve=>setImmediate(resolve));assert.equal(f.app.getSnapshot().observation.status.kind,'concluded');}
 assert.equal(await target.outputs.list(),listing);assert.equal(await target.outputs.read(id),read);assert.deepEqual(f.submitted,[]);
});

async function connected(f, domain = { messages: [], currentRun: null }) {
  const feed = f.feeds.at(-1);
  await feed.receive({ kind: 'snapshot', snapshot: { scope: feed.scope, projectionVersion: 4, cursor: 1,
    document: { domain, decisions: {}, receipts: {} } } });
}

test('known conclusion rejects only new SDK sends and preserves original uncertain intent and retry', async t => {
  const f = await open(t);
  await connected(f);
  const target = f.app.getSnapshot().active, commands = f.app.conversationActions(target).commands;
  await assert.rejects(commands.send.run('original'), /Reply lost/);
  const original = structuredClone(target.store.getSnapshot().outbox);
  f.behavior.observation = async () => ({ kind: 'concluded', cause: 'exhausted' });
  await f.app.reconnect(); await connected(f);
  const current = f.app.getSnapshot().active, actions = f.app.conversationActions(current);
  assert.equal(f.app.getSnapshot().observation.status.kind, 'concluded');
  assert.equal(actions.commands.send.availability('new').kind, 'disabled');
  await assert.rejects(actions.commands.send.run('new'), /conversation ended/);
  assert.deepEqual(current.store.getSnapshot().outbox, original);
  assert.equal(f.submitted.length, 1);
  assert.equal(actions.commands.approve.availability('pending', 'yes').kind, 'available');
  assert.equal(actions.commands.cancel.availability('run').kind, 'available');
  current.store.disconnect();
  await actions.submit(() => current.store.retry(original[0].command.clientCommandId));
  assert.equal(f.submitted.length, 2);
  assert.deepEqual(f.submitted[1], f.submitted[0]);
  await actions.reconcile(original[0].command.clientCommandId);
  assert.equal(f.submitted.length, 2);
});

test('availability keeps approve/cancel and exact-grant revoke predicates unequal', async t => {
  const f = await open(t);
  await connected(f, { messages: [], currentRun: { kind: 'running', runId: 'run' } });
  const target = f.app.getSnapshot().active, actions = f.app.conversationActions(target);
  target.agent.commands.splice(target.agent.commands.indexOf('send'), 1);
  assert.equal(actions.commands.send.availability('hello').kind, 'disabled');
  for (const [handle, args] of [[actions.commands.approve, ['pending', 'yes']], [actions.commands.cancel, ['run']]]) {
    assert.equal(handle.availability(...args).kind, 'available');
    await assert.rejects(handle.run(...args), /Reply lost/);
  }
  target.store.disconnect(); target.agent.commands.splice(0);
  f.behavior.permissions = async () => ({ kind: 'available', observedAt: new Date().toISOString(),
    permissions: [{ permissionId: 'grant', scope: 'agent', actionLabel: 'Grant', detail: 'Exact' }] });
  await actions.permissions.read();
  const revoke = actions.commands.revokePermission;
  for (const args of [['other', 'agent'], ['grant', 'conversation']]) {
    assert.equal(revoke.availability(...args).kind, 'disabled');
    await assert.rejects(revoke.run(...args), /Refresh permissions/);
  }
  assert.equal(revoke.availability('grant', 'agent').kind, 'available');
  await assert.rejects(revoke.run('grant', 'agent'), /Reply lost/);
  assert.equal(f.submitted.at(-1).body.kind, 'revoke-permission');
  target.agent.availability = { kind: 'unavailable', reason: 'Agent unavailable' };
  assert.equal(revoke.availability('grant', 'agent').kind, 'disabled');
  assert.equal(await target.outputs.list(), listing);
  await actions.reconcile(f.submitted[0].clientCommandId);
});

test('availability does not validate text or add feed restrictions to direct store intent', async t => {
  const f = await open(t); await connected(f);
  const target = f.app.getSnapshot().active, send = f.app.conversationActions(target).commands.send;
  assert.equal(send.availability('').kind, 'available');
  await assert.rejects(send.run(''));
  assert.equal(f.submitted.length, 0);
  target.store.disconnect();
  assert.equal(send.availability('offline').kind, 'disabled');
  const before = f.app.getSnapshot(), outbox = structuredClone(target.store.getSnapshot().outbox);
  await assert.rejects(send.run('disabled invocation'), /Connect the conversation/);
  assert.equal(f.app.getSnapshot(), before, 'disabled invocation publishes no busy or permission transition');
  assert.deepEqual(target.store.getSnapshot().outbox, outbox);
  assert.equal(f.submitted.length, 0);
  await assert.rejects(target.store.send('offline intent'), /Reply lost/);
  assert.equal(f.submitted[0].body.text, 'offline intent');
});
