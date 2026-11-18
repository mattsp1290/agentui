import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@agentui/contracts';
import { ContinuationRefused } from '@agentui/host';
import { observationFixture, actor, scope, events } from './provider-observations-fixture.mjs';
import { until } from '../host/fixture.mjs';

test('HTTP feed acknowledges a complete prefix before submit confirmation, survives reopen, and binds only original evidence', async t => {
  const f = await observationFixture(t, { held: true });
  const submit = f.submit(); await until(() => f.submissions.length === 1);
  const operation = f.submissions[0];
  assert.equal(await f.emit([f.batch()]), true);
  assert.throws(() => f.inspect(), /Unknown frontend run/);
  assert.equal(f.dump().frontend_observation_events.length, 6);
  assert.equal((await f.host.conversation(scope, actor).receipt('send')).state.kind, 'pending');
  f.release('uncertain'); await submit;
  await f.restart(); assert.throws(() => f.inspect(), /Unknown frontend run/);
  f.release('confirmed'); await f.host.reconcile(scope, 'send', actor);
  const expected = { status: 'ready', calls: [{ id: 'call', name: 'test__inspect', status: 'pending', activationId: 'original-activation',
    argumentsDigest: createHash('sha256').update(canonicalJson({ value: 42 })).digest('hex') }] };
  assert.deepEqual(f.inspect(), expected);
  await f.restart(); assert.deepEqual(f.inspect(), expected);
  assert.equal(f.submissions.at(-1).operationId, operation.operationId);
  assert.deepEqual(f.submissions.at(-1).request, operation.request);
  assert.equal(f.dump().frontend_events.length, 6);
  assert.equal(f.dump().frontend_receipts.length, 0);
});

test('HTTP duplicate IDs skip mapping, positioned duplicates persist once, and after-finish conflicts block', async t => {
  const f = await observationFixture(t); await f.submit(); const batch = f.batch();
  assert.equal(await f.emit([batch], 'same'), true); const maps = f.provider.counters.eventMaps, before = f.dump();
  assert.equal(await f.emit([batch], 'same'), true); assert.equal(f.provider.counters.eventMaps, maps); assert.deepEqual(f.dump(), before);
  assert.equal(await f.emit([batch], 'different'), true); assert.equal(f.inspect().status, 'ready'); assert.equal(f.dump().frontend_events.length, 6);
  assert.equal(await f.emit([f.batch(undefined, [{ type: 'RUN_ERROR', message: 'late' }], 7)]), true);
  assert.equal(f.inspect().status, 'blocked'); assert.equal(f.dump().frontend_observation_events.length, 7);
});

test('schema-valid faulting chunks and the remaining source suffix stay in the retained journal', async t => {
  const f = await observationFixture(t); await f.submit();
  const list = [events(f.submissions[0])[0], { type: 'TOOL_CALL_CHUNK', toolCallId: 'chunk', toolCallName: 'test__inspect', delta: '{}' }, events(f.submissions[0]).at(-1)];
  const batch = f.batch(undefined, list);
  assert.equal(await f.emit([batch]), true); assert.equal(f.inspect().status, 'faulted');
  assert.equal(f.dump().frontend_events.length, 1); assert.equal(f.dump().frontend_observation_events.length, 3);
  const retained = f.dump().frontend_observation_events;
  assert.equal(await f.emit([batch]), true); assert.deepEqual(f.dump().frontend_observation_events, retained);
  await f.restart(); assert.equal(await f.emit([batch]), true); assert.deepEqual(f.dump().frontend_observation_events, retained);
});

for (const damage of ['operation','thread','run','gap','overlap','source-id']) test(`HTTP ${damage} evidence cannot yield pending consent`, async t => {
  const f = await observationFixture(t); await f.submit(); const batch = f.batch(undefined, events(f.submissions[0]).slice(0,2));
  assert.equal(await f.emit([batch], 'first'), true); const before = f.dump();
  let invalid = f.batch(); let id;
  if (damage === 'operation') invalid.operationId = 'unknown';
  if (damage === 'thread') invalid.threadId = 'other';
  if (damage === 'run') invalid.runId = 'other';
  if (damage === 'gap') invalid.firstPosition = 9;
  if (damage === 'overlap') invalid.events[0].threadId = 'other';
  if (damage === 'source-id') id = 'first';
  const accepted = await f.emit([invalid], id);
  if (['gap','overlap'].includes(damage)) { assert.equal(accepted,true); assert.equal(f.inspect().status,'blocked'); }
  else { assert.equal(accepted,false); assert.deepEqual(f.dump(),before); }
});

for (const history of ['complete','omitted','short','unavailable','removed']) test(`snapshot ${history} coverage after reopen is explicit and sticky`, async t => {
  const f = await observationFixture(t); await f.submit(); const operation = f.submissions[0], list = events(operation);
  await f.emit([f.batch(operation,list.slice(0,2))]);
  if (history !== 'omitted' && history !== 'removed') f.histories.push({ ...f.batch(), kind: history === 'unavailable' ? 'unavailable' : 'complete', events: history === 'short' ? list.slice(0,1) : list });
  await f.restart(history !== 'removed'); await f.resnapshot();
  assert.equal(f.inspect().status, history === 'complete' ? 'ready' : 'blocked');
  if (history !== 'complete') { await f.emit([f.batch(operation,list)]); assert.equal(f.inspect().status,'blocked'); }
});

test('terminal snapshot omission keeps pending consent but explicitly changed history blocks it', async t => {
  const f = await observationFixture(t); await f.submit(); await f.emit([f.batch()]);
  await f.restart(); await f.resnapshot(); assert.equal(f.inspect().status,'ready');
  f.histories.push({ ...f.batch(), kind:'complete', events:[{ ...events(f.submissions[0])[0], threadId:'changed' }] });
  await f.restart(); await f.resnapshot(); assert.equal(f.inspect().status,'blocked');
});

for (const table of ['frontend_observation_events','frontend_runs','frontend_events','provider_checkpoints','provider_event_ids']) test(`HTTP ${table} failure rolls back the whole provider transaction and retries once`, async t => {
  const f = await observationFixture(t); await f.submit(); const before = f.dump();
  f.database(db => db.exec(`CREATE TRIGGER fail_observation BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected rollback'); END`));
  assert.equal(await f.emit([f.batch()], 'retry'),false); assert.deepEqual(f.dump(),before);
  f.database(db => db.exec('DROP TRIGGER fail_observation')); await f.restart();
  assert.equal(await f.emit([f.batch()], 'retry'),true); assert.equal(f.inspect().status,'ready');
});

test('settlement materialization failure rolls command evidence back outside the output quarantine savepoint', async t => {
  const f = await observationFixture(t,{held:true}); const submit = f.submit(); await until(() => f.submissions.length===1);
  await f.emit([f.batch()]); const before = f.dump();
  f.database(db => db.exec("CREATE TRIGGER fail_settlement BEFORE INSERT ON frontend_events BEGIN SELECT RAISE(ABORT,'settlement rollback'); END"));
  f.release('confirmed'); await assert.rejects(submit,/settlement rollback/); assert.deepEqual(f.dump(),before);
  f.database(db => db.exec('DROP TRIGGER fail_settlement')); await f.host.reconcile(scope,'send',actor); assert.equal(f.inspect().status,'ready');
});

test('withdrawn original retains journal and never regains eligibility', async t => {
  const f = await observationFixture(t,{held:true}); const submit=f.submit(); await until(()=>f.submissions.length===1);
  await f.emit([f.batch()]); await f.withdraw(); f.release(); await submit;
  assert.equal(f.inspect().status,'blocked'); assert.equal(f.dump().frontend_observation_events.length,6);
  await f.restart(); assert.equal(f.inspect().status,'blocked');
});

test('request-only AG-UI registration leaves observation-shaped data opaque', async t => {
  const f=await observationFixture(t,{enabled:false}); await f.submit(); assert.equal(await f.emit([f.batch()]),true);
  assert.equal(f.dump().frontend_observation_runs.length,0); assert.equal(f.dump().frontend_runs.length,0); assert.equal(f.provider.counters.eventMaps,0);
});

for (const change of ['binding','installation','owner']) test(`foreign ${change} fails closed without reconstructing original ownership`, async t => {
  let rewrite = false;
  const f = await observationFixture(t,{configure(provider) {
    const map=provider.mappings.event;
    provider.mappings.event=value=>{
      const batches=structuredClone(map(value));
      if(rewrite) for(const batch of batches) {
        if(change==='binding') batch.run.binding.authority.binding.opaqueSessionId='foreign';
        if(change==='installation') batch.run.ref.instance.installationId='foreign';
      }
      return batches;
    };
  }});
  await f.submit();
  if(change==='owner') f.database(db=>db.exec('DELETE FROM frontend_send_owners'));
  rewrite=true; const before=f.dump(); assert.equal(await f.emit([f.batch()]),false); assert.deepEqual(f.dump(),before);
});

test('mapper withdrawal runs before BEGIN and the final owner fence blocks confirmation', async t=>{
  let f, withdrawal;
  f=await observationFixture(t,{configure(provider){const map=provider.mappings.event; provider.mappings.event=value=>{withdrawal=f.withdraw();return map(value);};}});
  await f.submit(); assert.equal(await f.emit([f.batch()]),true); await withdrawal;
  assert.equal(f.inspect().status,'blocked'); assert.equal(f.dump().frontend_observation_events.length,6);
});

test('existing canonical rendering still refuses nested public writes and rolls back the item',async t=>{
  let f;
  f=await observationFixture(t,{configure(provider){provider.presentation.apply=()=>{
    f.host.createConversation({hostId:'host',conversationId:'nested'},{installationId:'generic',binding:{engine:'fixture',nativeVersion:'1',account:'test',authorizedScope:'test',nativeFormat:'v1'}});
    assert.fail('Nested write must fail');
  };}});
  await f.submit(); const before=f.dump(); assert.equal(await f.emit([f.batch()]),false); assert.deepEqual(f.dump(),before);
});

test('feed retirement during rendering prevents all journal/checkpoint writes',async t=>{
  let f, retiring;
  f=await observationFixture(t,{configure(provider){const apply=provider.presentation.apply;provider.presentation.apply=(...args)=>{retiring=f.retire();return apply(...args);};}});
  await f.submit(); const before=f.dump(); assert.equal(await f.emit([f.batch()]),false); await retiring; assert.deepEqual(f.dump(),before);
});

test('snapshot preparation rejects a reentrantly changed original set and retries with current identities',async t=>{
  let f, change=false, admission;
  f=await observationFixture(t,{configure(provider){const map=provider.mappings.snapshot;provider.mappings.snapshot=(state,originals)=>{
    const result=map(state,originals);if(change){change=false;admission=f.submit('second');}return result;
  };}});
  await f.submit(); const first=f.submissions[0]; await f.emit([f.batch(first,events(first).slice(0,1))]);
  f.histories.push({...f.batch(first),kind:'complete'}); const before=f.dump(); change=true;
  assert.equal((await f.resnapshot()).kind,'stopped'); await admission;
  assert.deepEqual(f.dump().provider_checkpoints,before.provider_checkpoints);
  assert.deepEqual(f.dump().frontend_observation_events,before.frontend_observation_events);
  const second=f.submissions.at(-1); f.histories.push({...f.batch(second,[]),kind:'complete'});
  await f.host.retryObservation(scope); assert.equal(f.inspect(first).status,'ready'); assert.equal(f.inspect(second).status,'collecting');
});

test('a request-only original stays opaque after installing an opted-in mapper',async t=>{
  const f=await observationFixture(t,{enabled:false});await f.submit();await f.restart(true);
  const before=f.dump();assert.equal(await f.emit([f.batch()]),true);
  assert.notDeepEqual(f.dump().provider_checkpoints,before.provider_checkpoints);assert.equal(f.dump().frontend_observation_runs.length,0);
  assert.equal(f.dump().frontend_runs.length,0);
});

test('two original runs in one item keep distinct evidence positions and original activation bindings',async t=>{
  const f=await observationFixture(t);await f.submit('send');await f.submit('second');
  const [first,second]=f.submissions;assert.notEqual(first.request.runId,second.request.runId);
  assert.equal(await f.emit([f.batch(first),f.batch(second)]),true);
  assert.equal(f.inspect(first).status,'ready');assert.equal(f.inspect(second).status,'ready');assert.equal(f.dump().frontend_observation_events.length,12);
});

for(const invalid of ['empty-batch','bad-event','bad-position','overlarge-mapping','throws']) test(`mapper ${invalid} rejects the whole item at the boundary`,async t=>{
  const f=await observationFixture(t,{configure(provider){const map=provider.mappings.event;provider.mappings.event=value=>{
    const batches=map(value);const batch=batches[0];
    if(invalid==='empty-batch')batch.events=[];
    if(invalid==='bad-event')batch.events=[{type:'NOT_AN_EVENT'}];
    if(invalid==='bad-position')batch.firstPosition=1.5;
    if(invalid==='overlarge-mapping')batch.events=[{type:'RAW',event:'x'.repeat(1_000_001)}];
    if(invalid==='throws')throw new Error('mapper error');
    return batches;
  };}});
  await f.submit();const before=f.dump();assert.equal(await f.emit([f.batch()]),false);assert.deepEqual(f.dump(),before);
});

test('journal event count and byte budgets remain bounded even for canonical faults',async t=>{
  const f=await observationFixture(t);await f.submit();
  const raw={type:'RAW',event:'x'.repeat(63000)};
  await f.emit([f.batch(undefined,[events(f.submissions[0])[0],...Array(8).fill(raw)])]);
  assert.equal(await f.emit([f.batch(undefined,Array(8).fill(raw),10)]),true);
  assert.equal(f.inspect().status,'blocked');
  const rows=f.dump().frontend_observation_events;assert(rows.reduce((sum,row)=>sum+row.bytes,0)<=1_000_000);assert.equal(rows.length,16);
});

test('backend answered tools do not become frontend pending consent',async t=>{
  const f=await observationFixture(t);await f.submit();const list=events(f.submissions[0]);
  list.splice(-1,0,{type:'TOOL_CALL_RESULT',messageId:'answer',toolCallId:'call',content:'answered',role:'tool'});
  assert.equal(await f.emit([f.batch(undefined,list)]),true);assert.equal(f.inspect().status,'ready');assert.equal(f.inspect().calls.some(call=>call.status==='pending'),false);
});

test('immutable observation capture accepts only the named AG-UI protocol combination',async t=>{
  const f=await observationFixture(t);await f.submit();
  const {parseProviderCapture}=await import('../../packages/host/dist/provider-commands.js');
  const target=JSON.parse(f.dump().commands[0].target);assert.equal(target.operation.observationProtocol,'ag-ui-v1');
  assert.deepEqual(parseProviderCapture(target,scope).target,target);
  for(const mutate of [value=>delete value.operation.protocol,value=>value.operation.observationProtocol='future',value=>value.operation.observationProtocol=null]) {
    const invalid=structuredClone(target);mutate(invalid);assert.throws(()=>parseProviderCapture(invalid,scope),/protocol/);
  }
  const plain=structuredClone(target);delete plain.operation.observationProtocol;assert.equal(parseProviderCapture(plain,scope).target.operation.observationProtocol,undefined);
});

test('mapper snapshot input is detached from canonical renderer identity',async t=>{
  let mutate=false;
  const f=await observationFixture(t,{configure(provider){const snapshot=provider.mappings.snapshot;provider.mappings.snapshot=(state,originals)=>{
    const result=structuredClone(snapshot(state,originals));
    if(mutate&&originals[0])originals[0].run.binding.authority.binding.opaqueSessionId='mutated mapper input';
    return result;
  };}});
  await f.submit();f.histories.push({...f.batch(),kind:'complete'});mutate=true;
  assert.equal((await f.resnapshot()).kind,'observing');assert.equal(f.inspect().status,'ready');
});

test('a killed HTTP host retains its acknowledged original journal before the held submit response',async t=>{
  const {fork}=await import('node:child_process'),{once}=await import('node:events'),{rmSync}=await import('node:fs');
  const child=fork(new URL('./provider-observations-crash-worker.mjs',import.meta.url),{stdio:['ignore','ignore','pipe','ipc']});
  let errors='';child.stderr.on('data',bytes=>{errors+=bytes;});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const [saved]=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error(errors);})]);
  let restored=false;t.after(()=>{if(!restored)rmSync(saved.directory,{recursive:true,force:true});});
  assert.equal(saved.journalRows,6);assert.equal(saved.registrations,0);
  const exited=once(child,'exit');child.kill('SIGKILL');const [,signal]=await exited;assert.equal(signal,'SIGKILL');
  const f=await observationFixture(t,{directory:saved.directory});restored=true;
  assert.equal(f.dump().frontend_runs.length,0);assert.equal(f.dump().frontend_observation_events.length,6);
  const recovered=await f.host.reconcile(scope,'send',actor);assert.equal(recovered.state.kind,'completed',JSON.stringify({recovered,submissions:f.submissions,commands:f.dump().commands}));assert.equal(f.inspect(saved.operation).status,'ready');
  assert.equal(f.submissions[0].operationId,saved.operation.operationId);assert.deepEqual(f.submissions[0].request,saved.operation.request);
});

for(const outcome of ['pending','rejected','uncertain'])test(`HTTP ${outcome} command evidence cannot register an observed run`,async t=>{
  const f=await observationFixture(t,{outcome});await f.submit();assert.equal(await f.emit([f.batch()]),true);
  assert.equal(f.dump().frontend_observation_events.length,6);assert.equal(f.dump().frontend_runs.length,0);
});

test('a provider runs row alone does not confirm the offered original',async t=>{
  const f=await observationFixture(t,{outcome:'pending'});await f.submit();const operation=f.submissions[0];
  const run={kind:'provider',identity:{conversation:scope,runId:operation.request.runId,authority:f.binding.authority},reference:{binding:f.binding,ref:{kind:'run',instance:f.provider.presentation.instance,opaqueId:operation.request.runId}}};
  f.database(db=>db.prepare('INSERT INTO runs(host,conversation,id,data) VALUES(?,?,?,?)').run(scope.hostId,scope.conversationId,operation.request.runId,canonicalJson(run)));
  await f.emit([f.batch()]);assert.equal(f.dump().frontend_runs.length,0);assert.throws(()=>f.inspect(),/Unknown frontend run/);
});

test('a concluded conversation whose send registered frontend observations is never continued', async t => {
  let ended = false;
  const f = await observationFixture(t, { configure(provider) {
    provider.presentation.closure = () => ended ? { cause: 'cancelled' } : null;
    provider.presentation.continuation = () => null;
  } });
  await f.submit();
  assert.equal(JSON.parse(f.dump().commands[0].target).operation.observationProtocol, 'ag-ui-v1');
  ended = true;
  assert.equal(f.host.observationStatus(scope).kind, 'concluded');
  await assert.rejects(f.host.continuation(scope, 'start', f.registry), ContinuationRefused);
  assert.deepEqual(await f.host.continuation(scope, 'read'), { predecessor: null, carried: null, closure: 'cancelled', successor: null });
  assert.equal(f.requests.filter(request => request.path === '/create').length, 1);
});
