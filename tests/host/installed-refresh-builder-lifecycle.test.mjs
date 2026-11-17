import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { cp, readFile, writeFile, realpath, mkdir, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createInstalledRefreshBuilder } from '../../apps/host/build/tsc/installed-refresh-builder.js';
import { qualifyServerCustomizationToolchain } from '../../scripts/server-customization.mjs';
import { fixture as sourceFixture, write } from '../customization/build/preparation-support.mjs';
import { extension, validSource } from '../customization/build/server-support.mjs';
import { fixture, waitFor, alive } from './installed-refresh-builder-support.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const actualEntry=join(root,'scripts/build-server-customization.mjs');
const execute=promisify(execFile);

test('probe diagnostic overflow and immediate child failure are finite unavailable capabilities',async t=>{
  const f=await fixture(t);await f.mode({kind:'probe-flood'});
  assert.equal((await f.open()).kind,'unavailable');
  await writeFile(f.entry,'process.exit(1)');
  assert.equal((await f.open()).kind,'unavailable');
});

test('automatic failed drainage poisons admission and remains observable from memoized close',async t=>{
  const f=await fixture(t),builder=await f.open();
  f.expectFailedClose(builder);
  const kill=process.kill.bind(process);
  const mock=t.mock.method(process,'kill',(pid,signal)=>signal===0&&pid<0?true:kill(pid,signal));
  assert.deepEqual(await builder.run(f.command(builder)),{kind:'failed',failure:'unavailable'});
  mock.mock.restore();
  const before=await f.pids();
  assert.deepEqual(await builder.run({...f.command(builder),id:'after-failed-drain'}),{kind:'failed',failure:'unavailable'});
  assert.deepEqual(await f.pids(),before);
  const closing=builder.close();assert.equal(builder.close(),closing);
  await assert.rejects(closing,/^Error: Refresh drainage failed$/);
});

test('abrupt daemon death drains canonical building child, qualifier, grandchild and inherited pipes',async t=>{
  const f=await sourceFixture(t),repo=await f.repository('source'),pids=join(f.root,'pids.jsonl');
  const append=(pid,group)=>`appendFileSync(${JSON.stringify(pids)},JSON.stringify({pid:${pid},group:${group}})+'\\n');`;
  const nested=`process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const source=`import {spawn} from 'node:child_process';import {appendFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e',${JSON.stringify(nested)}],{stdio:'inherit'});
    ${append('process.pid','null')}${append('child.pid','null')}
    await new Promise(()=>{setInterval(()=>{},1000)});
    ${validSource}`;
  await write(repo.directory,'package.json',{type:'module',agentui:extension('abrupt-death')});
  await write(repo.directory,'index.ts',source);
  const reference=repo.reference(repo.commit());
  const daemon=join(f.root,'daemon.mjs');
  await writeFile(daemon,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {appendFileSync} from 'node:fs';
    const spawn=cp.spawn;cp.spawn=(...args)=>{const child=spawn(...args);${append('child.pid','child.pid')}return child;};syncBuiltinESMExports();
    const {createInstalledRefreshBuilder}=await import(${JSON.stringify(pathToFileURL(join(root,'apps/host/build/tsc/installed-refresh-builder.js')).href)});
    const {qualifyServerCustomizationToolchain}=await import(${JSON.stringify(pathToFileURL(join(root,'scripts/server-customization.mjs')).href)});
    const q=await qualifyServerCustomizationToolchain();
    const builder=await createInstalledRefreshBuilder({entry:${JSON.stringify(actualEntry)},expected:q.compatibility});
    if(builder.kind!=='ready') throw new Error('not ready');
    await builder.run({id:'abrupt',requestId:'abrupt',source:${JSON.stringify(reference)},directory:${JSON.stringify(join(f.root,'artifact'))},toolchain:builder.identity});`);
  const child=spawn(process.execPath,[daemon],{stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',bytes=>{errors+=bytes;});child.stdout.resume();
  const closed=once(child,'close');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}});
  const observed=await waitFor(async()=>JSON.parse('['+(await readFile(pids,'utf8')).trim().split('\n').join(',')+']'),value=>value?.length>=4);
  child.kill('SIGKILL');await closed;
  for(const {pid} of observed) await waitFor(async()=>!alive(pid));
  for(const {group} of observed.filter(value=>value.group!==null)) await waitFor(async()=>{try{process.kill(-group,0);return false;}catch(error){return error.code==='ESRCH';}});
  assert.equal(errors.includes('PRIVATE'),false);
  console.log(JSON.stringify({proof:'abrupt-daemon-death',daemon:child.pid,observed,allGone:true}));
});

test('IPC disconnect cleanup is installed before a dynamic builder import can hang',async t=>{
  const f=await sourceFixture(t),scripts=join(f.root,'scripts'),pids=join(f.root,'pids.json');await mkdir(scripts);
  await cp(actualEntry,join(scripts,'builder.mjs'));
  await writeFile(join(scripts,'server-customization.mjs'),`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
    writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,child.pid]));await new Promise(()=>setInterval(()=>{},1000));`);
  const child=spawn(process.execPath,[join(scripts,'builder.mjs'),'--refresh-ipc'],{detached:true,stdio:['ignore','pipe','pipe','ipc']});
  child.stdout.resume();child.stderr.resume();const closed=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){process.kill(-child.pid,'SIGKILL');await closed;}});
  const observed=await waitFor(async()=>JSON.parse(await readFile(pids,'utf8')));
  child.disconnect();await closed;
  for(const pid of observed) await waitFor(async()=>!alive(pid));
});

test('post-source canonical builder graph drift fails before artifact publication',async t=>{
  const f=await sourceFixture(t),tooling=join(f.root,'tooling');
  await cp(join(root,'scripts'),join(tooling,'scripts'),{recursive:true});
  await cp(join(root,'package-lock.json'),join(tooling,'package-lock.json'));
  await symlink(join(root,'node_modules'),join(tooling,'node_modules'),'dir');
  const q=await qualifyServerCustomizationToolchain();
  const builder=await createInstalledRefreshBuilder({entry:join(tooling,'scripts/build-server-customization.mjs'),expected:q.compatibility});
  assert.equal(builder.kind,'ready');t.after(()=>builder.close());
  const repo=await f.repository('source');
  await write(repo.directory,'package.json',{type:'module',agentui:extension('tooling-drift')});
  await write(repo.directory,'index.ts',`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(join(tooling,'scripts/server-customization-qualifier.mjs'))},'\\n');${validSource}`);
  const out=join(await realpath(f.root),'artifact');
  const result=await builder.run({id:'drift',requestId:'drift',source:repo.reference(repo.commit()),directory:out,toolchain:builder.identity});
  assert.deepEqual(result,{kind:'failed',failure:'incompatible'});
  await assert.rejects(access(out),{code:'ENOENT'});
});

test('copied bundled host starts with separately provisioned tooling and serve-only flag',async t=>{
  const f=await sourceFixture(t),installed=join(f.root,'installed');
  await cp(join(root,'apps/host/dist'),installed,{recursive:true});
  const config=join(f.root,'extensions.json');
  await writeFile(config,JSON.stringify({version:2,ownership:'durable-artifacts',extensions:[]}));
  const data=join(f.root,'data');
  const args=[join(installed,'main.js'),'serve','--data-dir',data,'--extensions',config,'--assets',join(root,'apps/desktop/web-dist-browser'),'--port','0','--refresh-builder',actualEntry];
  const child=spawn(process.execPath,args,{cwd:f.root,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',bytes=>{stdout+=bytes;});child.stderr.on('data',bytes=>{stderr+=bytes;});
  const closed=once(child,'close');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}});
  const info=await waitFor(async()=>{if(child.exitCode!==null) throw new Error(stderr);return stdout.includes('\n')?JSON.parse(stdout.trim()):null;});
  const response=await fetch(info.origin+'/api/v1',{method:'POST',headers:{'Content-Type':'application/json',Origin:info.origin},body:JSON.stringify({op:'metadata'}),signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200);await response.arrayBuffer();
  child.kill('SIGTERM');const [code]=await closed;assert.equal(code,0,stderr);assert.equal(alive(child.pid),false);
  await assert.rejects(fetch(info.origin,{signal:AbortSignal.timeout(1000)}));
  const cli=[join(installed,'main.js'),'browser-dev','--data-dir',join(f.root,'invalid'),'--refresh-builder',actualEntry];
  await assert.rejects(execute(process.execPath,cli),error=>error.stderr.includes('--refresh-builder is not valid for browser-dev'));
  await writeFile(config,JSON.stringify({version:2,ownership:'transient',extensions:[]}));
  await assert.rejects(execute(process.execPath,args,{timeout:10000}),error=>error.stderr.includes('Refresh builder requires durable extensions'));
  console.log(JSON.stringify({proof:'copied-installed-startup',pid:child.pid,origin:info.origin,tooling:actualEntry,publicRefreshCommands:false,processAndPortGone:true}));
});
