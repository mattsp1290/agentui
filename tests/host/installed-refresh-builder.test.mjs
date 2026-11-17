import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, access, readdir, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInstalledRefreshBuilder } from '../../apps/host/build/tsc/installed-refresh-builder.js';
import { qualifyServerCustomizationToolchain, buildServerCustomization } from '../../scripts/server-customization.mjs';
import { databaseFixture, request, rows } from './refresh-support.mjs';
import { setup, extension, validSource, write } from '../customization/build/server-support.mjs';
import { fixture, expected, waitFor, alive } from './installed-refresh-builder-support.mjs';

const entry = fileURLToPath(new URL('../../scripts/build-server-customization.mjs', import.meta.url));
test('canonical qualification is source independent and two source commits build through the durable owner', async t => {
  const qualified = await qualifyServerCustomizationToolchain();
  assert.equal(qualified.entry, entry);
  globalThis.AGENTUI_SERVER_CUSTOMIZATION_ABI = qualified.compatibility.abiIdentity;
  const builder = await createInstalledRefreshBuilder({entry,expected:qualified.compatibility});
  assert.equal(builder.kind,'ready');
  assert.deepEqual(builder.identity, qualified.identity);
  const f = databaseFixture(t,builder), source = await setup(t), owner = await f.open();
  const first = source.repo.reference(source.repo.commit());
  const receipt = await owner.request(request('first',first));
  assert.equal(receipt.job.build.kind,'built',JSON.stringify(receipt));
  assert.equal(receipt.job.promotion.kind,'selected');
  await appendFile(join(source.repo.directory,'index.ts'),'\n// second immutable source\n');
  const second = source.repo.reference(source.repo.commit());
  const next = await owner.request(request('second',second,1));
  assert.equal(next.job.build.kind,'built',JSON.stringify(next));
  assert.equal(next.job.promotion.kind,'selected');
  assert.notEqual(receipt.job.build.pin.artifactId,next.job.build.pin.artifactId);
  assert.notEqual(receipt.job.build.command.id,next.job.build.command.id);
  assert.equal(rows(f.database).length,2);
  assert.deepEqual((await readdir(f.artifactRoot)).filter(name=>name.startsWith('.agentui-server-')),[]);
  const closed = owner.close(); assert.equal(owner.close(),closed); await closed;
});

test('captured invocation directory preserves relative descendants and canonical staged artifact pins', async t => {
  const source = await setup(t), invocation = join(source.root, 'invocation with spaces');
  await mkdir(invocation);
  assert.notEqual(invocation, dirname(entry));
  const child = await source.repository('invocation with spaces/relative child');
  await write(child.directory, 'package.json', { type: 'module', agentui: extension('relative-child') });
  await write(child.directory, 'index.ts', validSource);
  const childCommit = child.commit();
  await write(source.repo.directory, 'package.json', { type: 'module', agentui: extension('fixture', {
    extensions: [{ repository: './relative child', commit: childCommit }],
  }) });
  const reference = source.repo.reference(source.repo.commit()), manualDirectory = join(source.root, 'manual artifact');
  const manualPin = JSON.parse(execFileSync(process.execPath, [entry, '--repository', reference.repository,
    '--commit', reference.commit, '--out', manualDirectory], { cwd: invocation, encoding: 'utf8' }));
  const manual = JSON.parse(await readFile(join(manualPin.directory, 'customization.json'), 'utf8'));
  assert.equal(manual.packages.length, 2);
  assert.equal(manual.packages.find(pkg => pkg.identity === manual.root).extensions[0].commit, childCommit);
  t.diagnostic('Canonical manual artifact ' + manualPin.artifactId + ' includes relative child ' + childCommit);
  const qualified = await qualifyServerCustomizationToolchain();
  globalThis.AGENTUI_SERVER_CUSTOMIZATION_ABI = qualified.compatibility.abiIdentity;
  const original = process.cwd();
  t.after(() => process.chdir(original));
  let pending;
  try {
    process.chdir(invocation);
    pending = createInstalledRefreshBuilder({ entry, expected: qualified.compatibility });
  } finally { process.chdir(original); }
  const builder = await pending;
  assert.equal(builder.kind, 'ready');
  t.after(() => builder.close());
  const f = databaseFixture(t, builder), owner = await f.open();
  const receipt = await owner.request(request('relative-descendant', reference));
  assert.equal(receipt.job.build.kind, 'built', JSON.stringify(receipt));
  assert.equal(receipt.job.build.pin.artifactId, manualPin.artifactId);
  const installed = JSON.parse(await readFile(join(receipt.job.build.pin.directory, 'customization.json'), 'utf8'));
  assert.deepEqual(installed, manual);
  assert.equal(receipt.job.promotion.kind, 'selected');
  assert.equal(receipt.selectionStatus.runtime.kind, 'withheld');
  assert.equal(f.replacements(), 0);
  assert.equal(f.stops(), 0);
  assert.equal(rows(f.database).length, 1);
  assert.deepEqual(await owner.inspect('relative-descendant'), receipt);
  assert.deepEqual((await readdir(f.artifactRoot)).filter(name => name.startsWith('.agentui-server-')), []);
  await owner.close();
  t.diagnostic(JSON.stringify({ proof: 'relative-descendant-parity', sourceRoot: source.root, artifactRoot: f.artifactRoot,
    invocation, currentDirectory: process.cwd(), artifactId: manualPin.artifactId, staged: true, liveReplacements: f.replacements() }));
});

test('canonical expected qualification rejects before reserving output or accessing a source', async t => {
  const f = await setup(t), expectedToolchain = await qualifyServerCustomizationToolchain();
  expectedToolchain.identity.builder.identity='0'.repeat(64);
  await assert.rejects(buildServerCustomization({reference:{repository:'/NEVER_READ_PRIVATE_SOURCE',commit:'a'.repeat(40)},out:join(f.root,'unreserved'),expectedToolchain}),error=>error.code==='toolchain-mismatch');
  await assert.rejects(access(join(f.root,'unreserved')), {code:'ENOENT'});
});

test('absent, relative, missing and incompatible startup tools remain unavailable', async t => {
  const f=await fixture(t);
  for(const path of [undefined,'relative',join(f.root,'missing')]) assert.deepEqual(await createInstalledRefreshBuilder({entry:path,expected}),{kind:'unavailable'});
  await f.mode({change:{'compatibility.sdkVersion':'wrong'}});
  assert.equal((await f.open()).kind,'unavailable');
  await assert.rejects(access(f.sourceFile),{code:'ENOENT'});
});

for (const [name, change] of Object.entries({node:{'identity.node':'/wrong/node'}, runtime:{'compatibility.nodeVersion':'0.0.0'}, modules:{'compatibility.nodeModules':'0'}, sdk:{'compatibility.sdkVersion':'wrong'}, abi:{'compatibility.abiIdentity':'c'.repeat(64)}, builder:{'identity.builder.identity':'c'.repeat(64)}, esbuild:{'identity.builder.esbuildVersion':'wrong'}, entry:{entry:'/wrong/entry'}, lock:{lockfile:'/wrong/lock'}})) {
  test(`${name} drift rejects before sending source`,async t=>{
    const f=await fixture(t), builder=await f.open(); assert.equal(builder.kind,'ready');
    await f.mode({change});
    assert.deepEqual(await builder.run(f.command(builder)),{kind:'failed',failure:'incompatible'});
    await assert.rejects(access(f.sourceFile),{code:'ENOENT'});
  });
}
for(const name of ['entry','lock']) test(`${name} byte drift rejects before source`,async t=>{
  const f=await fixture(t),builder=await f.open();
  await appendFile(name==='entry'?f.entry:join(f.root,'package-lock.json'),'\n');
  assert.deepEqual(await builder.run(f.command(builder)),{kind:'failed',failure:'incompatible'});
  await assert.rejects(access(f.sourceFile),{code:'ENOENT'});
});

test('durable command mismatch does not launch a child',async t=>{
  const f=await fixture(t),builder=await f.open(),before=await f.pids(),command=f.command(builder);
  command.toolchain.builder.identity='d'.repeat(64);
  assert.deepEqual(await builder.run(command),{kind:'failed',failure:'incompatible'});
  assert.deepEqual(await f.pids(),before);
});

test('explicit transport environment preserves fake Git credentials and drops provider and loader sentinels',async t=>{
  const f=await fixture(t);
  const preserved={GH_TOKEN:'FAKE_GIT_SENTINEL',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'credential.helper',GIT_CONFIG_VALUE_0:'FAKE_HELPER_SENTINEL',SSH_AUTH_SOCK:'/fake/ssh',HTTPS_PROXY:'http://fake.invalid',SSL_CERT_FILE:'/fake/cert'};
  const excluded={AGENTUI_SETUP_CAPABILITY:'FAKE_SETUP',OPENAI_API_KEY:'FAKE_PROVIDER',OPENCODE_GO_API_KEY:'FAKE_PROVIDER',OTEL_EXPORTER_OTLP_HEADERS:'FAKE_TELEMETRY',NODE_OPTIONS:'--require=/NEVER_LOAD_SENTINEL',NODE_PATH:'/fake/node',npm_config_userconfig:'/fake/npm'};
  for(const [key,value] of Object.entries({...preserved,...excluded})) {
    const original=process.env[key]; process.env[key]=value;
    t.after(()=>{if(original===undefined) delete process.env[key];else process.env[key]=original;});
  }
  const builder=await f.open();assert.equal(builder.kind,'ready');
  const env=JSON.parse(await readFile(f.envFile,'utf8'));
  for(const [key,value] of Object.entries(preserved)) assert.equal(env[key],value);
  for(const key of Object.keys(excluded)) assert.equal(env[key],undefined);
});

for(const kind of ['flood','ipc-flood','pipes','exit','grandchildren']) test(`${kind} drains all observed descendants and inherited pipes`,async t=>{
  const f=await fixture(t),builder=await f.open();await f.mode({kind});
  const result=await builder.run(f.command(builder));
  assert.equal(result.kind,'failed');
  assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'),false);
  for(const {pid} of await f.pids()) assert.equal(alive(pid),false,`PID ${pid} disappeared`);
});

for(const kind of ['ignore','late']) test(`${kind} cannot outlive duplicate close or return late results`,async t=>{
  const f=await fixture(t),builder=await f.open();await f.mode({kind});
  const pending=builder.run(f.command(builder));
  await waitFor(()=>access(f.sourceFile).then(()=>true));
  const closing=builder.close();assert.equal(builder.close(),closing);
  await closing;assert.deepEqual(await pending,{kind:'failed',failure:'unavailable'});
  for(const {pid} of await f.pids()) assert.equal(alive(pid),false);
});

for(const kind of ['probe-timeout','timeout']) test(`${kind} obeys its finite deadline`,async t=>{
  const f=await fixture(t);
  const original=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(handler,ms,...args)=>original(handler,ms===30000||ms===900000?250:ms,...args));
  if(kind==='probe-timeout') {await f.mode({kind});assert.equal((await f.open()).kind,'unavailable');}
  else {const builder=await f.open();await f.mode({kind});assert.deepEqual(await builder.run(f.command(builder)),{kind:'failed',failure:'resource-limit'});}
});

test('attempt scratch cleanup preserves a sibling and rejects existing ownership',async t=>{
  const f=await fixture(t),builder=await f.open();
  const sibling=join(f.root,'.agentui-server-sibling'); await mkdir(sibling);await writeFile(join(sibling,'keep'),'unchanged');
  await mkdir(join(f.root,'.agentui-server-attempt'));
  assert.deepEqual(await builder.run(f.command(builder)),{kind:'failed',failure:'publication'});
  assert.equal(await readFile(join(sibling,'keep'),'utf8'),'unchanged');
  await access(join(f.root,'.agentui-server-attempt'));
});

for(const name of ['entry','lock']) test(`missing ${name} after qualification rejects before source`,async t=>{
  const f=await fixture(t),builder=await f.open();
  await rm(name==='entry'?f.entry:join(f.root,'package-lock.json'));
  assert.deepEqual(await builder.run(f.command(builder)),{kind:'failed',failure:'incompatible'});
  await assert.rejects(access(f.sourceFile),{code:'ENOENT'});
});

test('swapping the qualified lock path refuses source work',async t=>{
  const f=await fixture(t),builder=await f.open(),lock=join(f.root,'package-lock.json');
  await writeFile(join(f.root,'other-lock.json'),'{}');await rm(lock);await symlink(join(f.root,'other-lock.json'),lock);
  assert.deepEqual(await builder.run(f.command(builder)),{kind:'failed',failure:'incompatible'});
  await assert.rejects(access(f.sourceFile),{code:'ENOENT'});
});
