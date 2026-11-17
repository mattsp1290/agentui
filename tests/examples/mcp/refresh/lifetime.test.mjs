import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { recordResource } from './support.mjs';

const guard = fileURLToPath(new URL('../../../../examples/mcp-control/refresh/dist/cli-lifetime.js', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const absent = pid => { try { process.kill(pid, 0); return false; } catch (e) { if (e.code === 'ESRCH') return true; throw e; } };
for (const mode of ['success', 'deadline', 'startup-failure', 'removal-failure', 'owner-kill']) {
  test(`synthetic lifetime handoff ${mode}`, { timeout: 8000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-lifetime-')), source = join(directory, 'source.json');
    await recordResource({ type: 'directory', path: directory });
    t.after(() => rm(directory, { recursive: true, force: true }));
    if (mode === 'removal-failure') await mkdir(source); else await writeFile(source, '{}');
    const env = { AGENTUI_REFRESH_WAIT_MS: mode === 'startup-failure' ? 'invalid' : '700', AGENTUI_REFRESH_SOURCE: source };
    if (mode === 'owner-kill') {
      const owner = spawn(process.execPath, ['--input-type=module', '-e', `import {spawn} from 'node:child_process'; const c=spawn(process.execPath,['--import',${JSON.stringify(guard)},'-e','setInterval(()=>{},1000)'],{env:${JSON.stringify(env)},stdio:['pipe','ignore','ignore']}); console.log(c.pid); setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
      const [bytes] = await once(owner.stdout, 'data'), pid = Number(bytes.toString().trim());
      await recordResource({ type: 'lifetime-owner', pid: owner.pid, childPid: pid, source });
      const closed = once(owner, 'close'); owner.kill('SIGKILL'); await closed;
      for (let i = 0; i < 100 && (!absent(pid) || existsSync(source)); i++) await sleep(20);
      assert.ok(absent(pid), `child ${pid} absent after owner death`);
      assert.ok(!existsSync(directory), 'child removed exact source and empty directory');
      return;
    }
    const child = spawn(process.execPath, ['--import', guard, '-e', mode === 'deadline' ? 'setInterval(()=>{},1000)' : ''], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    await recordResource({ type: 'lifetime-child', pid: child.pid, source });
    const [code] = await once(child, 'close');
    assert.equal(code, mode === 'success' ? 0 : mode === 'removal-failure' ? 75 : 72);
    assert.ok(absent(child.pid));
    assert.equal(existsSync(source), mode === 'removal-failure');
    assert.equal(existsSync(directory), mode === 'removal-failure');
  });
}
