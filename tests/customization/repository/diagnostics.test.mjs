import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCustomizationSnapshot } from '@agentui/host/customization';
import { fixture, shared, reference, write } from '../sources/source-support.mjs';

const safe = (code, message) => error => {
  assert.equal(error.code, code);
  assert.equal(error.message, message);
  assert.equal('stderr' in error || 'stdout' in error || 'cause' in error, false);
  assert.equal(error.message.includes('SECRET'), false);
  return true;
};

test('snapshot and graph retrieve local paths with spaces and retain pinned external provenance', async t => {
  const f = await fixture(t), child = await f.repository('child with spaces'), root = await f.repository('root with spaces');
  await shared(child);
  const childCommit = child.commit();
  await shared(root, '', { agentui: { extensions: [reference(child, childCommit)] } });
  const commit = root.commit();
  for (const repository of [root.directory, pathToFileURL(root.directory).href]) {
    const snapshot = await readCustomizationSnapshot({ repository, commit, scratchParent: f.scratchParent });
    assert.equal(snapshot.customization.extensions[0].repository, child.directory);
    await snapshot.dispose();
    const graph = await f.read({ repository, commit });
    assert.equal(graph.root.extensions[0].commit, childCommit);
    assert.equal(await readFile(join(graph.root.extensions[0].directory, 'source.ts'), 'utf8'), 'export const value = 1;\n');
    await graph.dispose();
  }
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('committed malformed external references have a fixed package diagnostic while caller errors stay input errors', async t => {
  const f = await fixture(t), repo = await f.repository('malformed');
  const expected = safe('invalid-package', 'Invalid committed external customization reference.');
  for (const external of [
    { repository: '/repo', commit: 'HEAD' },
    { repository: 'https://user:SECRET@example.invalid/repo', commit: 'a'.repeat(40) },
    { repository: 'https://example.invalid/repo with space', commit: 'a'.repeat(40) },
    { repository: 'git@example.invalid:repo with space', commit: 'a'.repeat(40) },
    { repository: '/repo', commit: 'a'.repeat(40), subdirectory: '../escape' },
    { repository: '/repo', commit: 'a'.repeat(40), unexpected: 'SECRET' },
  ]) {
    await shared(repo, '', { agentui: { extensions: [external] } });
    const ref = reference(repo, repo.commit());
    await assert.rejects(readCustomizationSnapshot({ ...ref, scratchParent: f.scratchParent }), expected);
    await assert.rejects(f.read(ref), expected);
  }
  for (const repository of ['https://example.invalid/repo with space', 'git@example.invalid:repo with space', '/repo\tname', '/repo\\name']) {
    await assert.rejects(f.read({ repository, commit: 'a'.repeat(40) }), { code: 'invalid-input' });
  }
  await assert.rejects(f.read(reference(repo, 'HEAD')), { code: 'invalid-input' });
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('actual Git stdout overflow uses a fixed resource diagnostic at a bounded test buffer', async t => {
  const f = await fixture(t), repo = await f.repository('overflow');
  await write(repo.directory, 'blob', 'SECRET BLOB\n'.repeat(100));
  const ref = reference(repo, repo.commit());
  const program = `import childProcess from 'node:child_process'; import {promisify} from 'node:util'; import {syncBuiltinESMExports} from 'node:module';
    const original=childProcess.execFile, execute=original[promisify.custom]; let observed;
    const wrapped=(...args)=>original(...args);
    wrapped[promisify.custom]=async(file,args,options)=>{
      try {return await execute(file,args,args.includes('cat-file')?{...options,maxBuffer:32}:options);}
      catch(error){observed=error.code;throw error;}
    };
    childProcess.execFile=wrapped;syncBuiltinESMExports();
    const {readCustomizationSnapshot}=await import('@agentui/host/customization');
    try {await readCustomizationSnapshot(${JSON.stringify({ ...ref, scratchParent: f.scratchParent })});process.exit(1);}
    catch(error){process.stdout.write(JSON.stringify({observed,code:error.code,message:error.message,leak:'stderr'in error||'stdout'in error||'cause'in error}));}`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' }));
  assert.deepEqual(result, { observed: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', code: 'resource-limit', message: 'Customization preparation resource limit exceeded.', leak: false });
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('Git fixtures ignore inherited repository selectors, signing and hook configuration', async t => {
  const f = await fixture(t), poisoned = join(f.root, 'poisoned-config');
  await writeFile(poisoned, '[commit]\n gpgsign = true\n[gpg]\n program = /missing/signer\n[core]\n hooksPath = /missing/hooks\n');
  const env = { ...process.env, GIT_DIR: '/missing/repo', GIT_WORK_TREE: '/missing/work', GIT_INDEX_FILE: '/missing/index',
    GIT_CONFIG_GLOBAL: poisoned, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true' };
  execFileSync(process.execPath, ['--input-type=module', '-e', `import {fixture} from ${JSON.stringify(new URL('../sources/source-support.mjs', import.meta.url).href)};
    const cleanup=[];try {const f=await fixture({after(fn){cleanup.push(fn)}});const repo=await f.repository('isolated');repo.commit();}
    finally {for(const fn of cleanup.reverse())await fn();}`], { env, stdio: 'pipe' });
  execFileSync(process.execPath, ['--test', '--test-name-pattern', '^empty commit and minimal package', new URL('./snapshot.test.mjs', import.meta.url).pathname], { env, stdio: 'pipe' });
});

test('failed snapshot and graph operations retain their safe error when real cleanup is denied', { skip: process.getuid?.() === 0 || process.platform === 'win32' }, async t => {
  for (const mode of ['snapshot', 'graph', 'retrieval', 'dispose']) {
    const f = await fixture(t), repo = await f.repository(`cleanup-${mode}`);
    await write(repo.directory, 'package.json', mode === 'dispose' ? {} : '{invalid SECRET package');
    const commit = repo.commit(), helper = join(f.root, 'ssh-helper');
    await writeFile(helper, `#!/bin/sh\nchmod 500 "$AGENTUI_TEST_SCRATCH"\n${mode === 'retrieval' ? "echo 'SECRET transport diagnostic' >&2; exit 1" : 'exec git-upload-pack "$AGENTUI_TEST_REPOSITORY"'}\n`, { mode: 0o700 });
    const keys = ['GIT_SSH_COMMAND', 'AGENTUI_TEST_SCRATCH', 'AGENTUI_TEST_REPOSITORY'];
    const previous = keys.map(key => process.env[key]);
    try {
      Object.assign(process.env, { GIT_SSH_COMMAND: helper, AGENTUI_TEST_SCRATCH: f.scratchParent, AGENTUI_TEST_REPOSITORY: repo.directory });
      const input = { repository: 'ssh://git@example.invalid/cleanup', commit, scratchParent: f.scratchParent };
      if (mode === 'graph') await assert.rejects(f.read(input), { code: 'invalid-package' });
      else if (mode === 'dispose') {
        const result = await readCustomizationSnapshot(input);
        await assert.rejects(result.dispose(), error => ['EACCES', 'EPERM'].includes(error.code));
        await chmod(f.scratchParent, 0o700);
        await result.dispose();
      } else await assert.rejects(readCustomizationSnapshot(input), safe(mode === 'retrieval' ? 'retrieval-failed' : 'invalid-package',
        mode === 'retrieval' ? 'Git could not retrieve the snapshot. Check repository access and the requested commit.' : 'Expected valid committed package.json and package-lock.json JSON.'));
    } finally {
      await chmod(f.scratchParent, 0o700);
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    }
  }
});
