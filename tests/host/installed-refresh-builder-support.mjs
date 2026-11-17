import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createInstalledRefreshBuilder } from '../../apps/host/build/tsc/installed-refresh-builder.js';

export const expected = { sdkVersion: 'test', nodeVersion: process.versions.node, nodeModules: process.versions.modules, abiIdentity: 'a'.repeat(64) };
export async function waitFor(read, predicate = Boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (predicate(value)) return value;
    await delay(20);
  }
  throw new Error('Fixture deadline exceeded');
}
export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
export async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentui-installed-builder-')));
  await mkdir(join(root, 'scripts'));
  const entry = join(root, 'scripts', 'builder.mjs');
  const modeFile = join(root, 'mode.json');
  await writeFile(join(root, 'package-lock.json'), '{}');
  const pidFile = join(root, 'pids.jsonl'), sourceFile = join(root, 'source-received'), envFile = join(root, 'environment.json');
  const fixtureProgram = `
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const mode = JSON.parse(readFileSync(${JSON.stringify(modeFile)}, 'utf8'));
const pidFile = ${JSON.stringify(pidFile)};
appendFileSync(pidFile, JSON.stringify({pid: process.pid, group: process.pid}) + '\\n');
writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const qualification = { protocol: 'agentui-refresh-builder-v1', entry: ${JSON.stringify(entry)}, lockfile: ${JSON.stringify(join(root, 'package-lock.json'))},
 identity: {kind:'ready', node: process.execPath, entrySha256: hash(${JSON.stringify(entry)}), lockSha256: hash(${JSON.stringify(join(root, 'package-lock.json'))}), builder:{identity:'b'.repeat(64),esbuildVersion:'test'}}, compatibility: ${JSON.stringify(expected)} };
for (const [path, value] of Object.entries(mode.change ?? {})) { const parts=path.split('.'); let target=qualification; for(const part of parts.slice(0,-1)) target=target[part]; target[parts.at(-1)] = value; }
if(mode.kind === 'ignore') process.on('SIGTERM', () => {});
if(mode.kind === 'probe-flood') process.stderr.write('F'.repeat(70000));
if(mode.kind !== 'probe-timeout') process.send({kind:'qualified', qualification});
process.on('message', message => {
 writeFileSync(${JSON.stringify(sourceFile)}, JSON.stringify(message));
 if(mode.kind === 'flood') { process.stdout.write('PRIVATE_SENTINEL'.repeat(5000)); return; }
 if(mode.kind === 'ipc-flood') { process.send({kind:'failed',failure:'X'.repeat(70000)}); return; }
 if(['pipes','ignore','grandchildren','exit'].includes(mode.kind)) {
   const nested = mode.kind === 'grandchildren' ? \`const p=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});appendFileSync(\${JSON.stringify(pidFile)},JSON.stringify({pid:p.pid,group:\${process.pid}})+'\\\\n');\` : '';
   const code = \`const {appendFileSync}=require('node:fs'); const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});\${nested}setInterval(()=>{},1000);\`;
   const child = spawn(process.execPath,['-e',code],{stdio:'inherit'});
   appendFileSync(pidFile,JSON.stringify({pid:child.pid,group:process.pid})+'\\n');
   if(mode.kind !== 'ignore') setTimeout(()=>process.exit(1),100);
   return;
 }
 if(mode.kind === 'timeout') return;
 if(mode.kind === 'late') { process.on('SIGTERM',()=>{process.send({kind:'built',artifactId:'a'.repeat(64),qualification});}); return; }
 process.send({kind:'failed',failure:'source'});
});
`;
  await writeFile(entry, fixtureProgram);
  const mode = value => writeFile(modeFile, JSON.stringify(value));
  await mode({kind:'normal'});
  const builders = [], expectedFailedClose = new Set();
  const open = async () => { const builder = await createInstalledRefreshBuilder({entry, expected}); builders.push(builder); return builder; };
  const pids = async () => (await readFile(pidFile,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  t.after(async () => {
    for (const builder of builders) if (builder.kind === 'ready') {
      if (expectedFailedClose.has(builder)) await assert.rejects(builder.close(),/^Error: Refresh drainage failed$/);
      else await builder.close();
    }
    for (const {pid} of await pids().catch(()=>[])) assert.equal(alive(pid),false,`PID ${pid} must disappear`);
    await rm(root, {recursive:true,force:true});
  });
  const command = builder => ({id:'attempt',requestId:'request',source:{repository:'/NEVER_READ_PRIVATE_SOURCE',commit:'a'.repeat(40)},directory:join(root,'attempt'),toolchain:structuredClone(builder.identity)});
  return {root,entry,modeFile,sourceFile,envFile,mode,open,pids,command,expectFailedClose: builder => expectedFailedClose.add(builder)};
}
