import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { forkFile } from '../../scripts/lib/agui-fork/bytes.mjs';

const folder = join(tmpdir(), 'agentui-fork-paths');
for (const [label, file] of [
  ['absolute', join(tmpdir(), 'outside')], ['parent', '..'], ['escape', '../outside'],
  ['nested escape', 'a/../../outside'], ['self', '.'], ['empty', ''],
]) test(`fork paths reject ${label}`, () => assert.throws(() => forkFile(folder, file), /must stay inside the fork folder/u));

for (const file of ['..foo', 'evidence/record.gz']) {
  test(`fork paths accept contained ${file}`, () => assert.equal(forkFile(folder, file), join(folder, file)));
}
