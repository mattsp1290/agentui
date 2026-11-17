import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildCustom, repository, root } from './support.mjs';

for (const [label, activate] of [
  ['host CSP eval', "globalThis['Func'+'tion']('return 1')(); return {modules:[],dispose(){}};"],
  ['throwing activation', "throw new Error('Activation failed');"],
  ['pending activation', 'return new Promise(() => {});'],
  ['missing disposal', 'return {modules:[]};'],
]) test(`desktop qualification rejects ${label} without publication`, { timeout: 30_000 }, async t => {
  const f = repository();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.write('desktop/index.tsx', `export default {kind:'desktop',sdkVersion:'0.7.0',activate(){${activate}}};`);
  assert.throws(() => buildCustom(f));
  assert.deepEqual(await readdir(f.directory), ['source']);
});

test('desktop publication rejects staged mutation after the browser receives verified bytes', { timeout: 30_000 }, async t => {
  const f = repository();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const preserved = join(f.directory, 'previous');
  await mkdir(preserved);
  await writeFile(join(preserved, 'sentinel'), 'previous artifact');
  const preload = join(f.directory, 'mutate.mjs'), marker = join(f.directory, 'mutated');
  await writeFile(preload, `import fs from 'node:fs';
import {dirname,join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const read=fs.readFileSync;
let scheduled=false;
fs.readFileSync=function(path,...options){
  const bytes=read.call(this,path,...options);
  if(!scheduled && String(path).endsWith('/browser/artifact.json')){
    scheduled=true;
    setImmediate(()=>{
      fs.writeFileSync(join(dirname(String(path)),'customization-identity.json'),'{}\\n');
      fs.writeFileSync(${JSON.stringify(marker)},'changed after synchronous inventory read');
    });
  }
  return bytes;
};
syncBuiltinESMExports();`);
  f.write('desktop/index.tsx', `import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
export default {kind:'desktop',sdkVersion:EXTENSION_SDK_VERSION,activate(){return {modules:[],dispose(){}}}};`);
  const out = join(f.directory, 'rejected');
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'scripts/build-local-customization.mjs'),
    '--repository', f.repo, '--commit', f.commit(), '--out', out], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0, output);
  assert.equal(await readFile(marker, 'utf8'), 'changed after synchronous inventory read');
  assert.match(output, /digest mismatch|changed during qualification/u);
  assert.equal(await readFile(join(preserved, 'sentinel'), 'utf8'), 'previous artifact');
  await rm(preload);
  await rm(marker);
  assert.deepEqual((await readdir(f.directory)).sort(), ['previous', 'source']);
});
