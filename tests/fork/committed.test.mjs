import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyFork } from '../../scripts/lib/agui-fork.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('committed fork identity, ledger, archives, evidence and fixtures verify offline', () => {
  assert.equal(verifyFork(root).packages.size, 6);
});

test('offline reports measure every current checker module and executed consumer script', () => {
  const output = execFileSync(process.execPath, [join(root, 'scripts/verify-agui-fork.mjs'), '--offline'], { cwd: root, encoding: 'utf8' });
  const report = JSON.parse(output);
  assert.equal(report.result, 'PASS');
  assert.equal(report.installed, false);
  const files = ['scripts/lib/agui-fork.mjs', 'scripts/verify-agui-fork.mjs',
    ...readdirSync(join(root, 'scripts/lib/agui-fork')).filter((file) => file.endsWith('.mjs')).map((file) => `scripts/lib/agui-fork/${file}`),
    ...['all-imports.mjs', 'codex-esm.mjs', 'codex-commonjs.cjs'].map((file) => `tests/dependencies/ag-ui/${file}`)];
  assert.deepEqual(Object.keys(report.sourceSha256).sort(), files.sort());
  for (const file of files) {
    assert.equal(report.sourceSha256[file], createHash('sha256').update(readFileSync(join(root, file))).digest('hex'), file);
  }
});
