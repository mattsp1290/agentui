import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileIntents } from '@agentui/example-crew/file-intents';

test('file adapter replaces an existing broad temporary-file mode with private permissions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-intent-mode-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'intent.json');
  await writeFile(`${path}.next`, 'leftover');
  await chmod(`${path}.next`, 0o666);
  await fileIntents(path).save({ fixture: 'retained' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { fixture: 'retained' });
  const nested = join(directory, 'private', 'intent.json');
  await fileIntents(nested).save({ fixture: 'new directory' });
  assert.equal((await stat(join(directory, 'private'))).mode & 0o777, 0o700);
});
