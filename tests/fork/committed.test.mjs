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
  const output = execFileSync(process.execPath, ['--import', join(root, 'tests/fork/support/import-graph.mjs'),
    join(root, 'scripts/verify-agui-fork.mjs'), '--offline'], { cwd: root, encoding: 'utf8' });
  const [report, graph] = output.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(report.result, 'PASS');
  assert.equal(report.installed, false);
  assert.equal(graph.type, 'fork-import-graph');
  assert.ok(graph.sourceFiles.includes('scripts/verify-agui-fork.mjs'), 'observer must see the driver');
  for (const file of graph.sourceFiles) assert.ok(Object.hasOwn(report.sourceSha256, file), `${file}: imported source must be measured`);
  const files = ['scripts/lib/agui-fork.mjs', 'scripts/verify-agui-fork.mjs',
    ...readdirSync(join(root, 'scripts/lib/agui-fork')).filter((file) => file.endsWith('.mjs')).map((file) => `scripts/lib/agui-fork/${file}`),
    ...['all-imports.mjs', 'codex-esm.mjs', 'codex-commonjs.cjs'].map((file) => `tests/dependencies/ag-ui/${file}`)];
  assert.deepEqual(Object.keys(report.sourceSha256).sort(), files.sort());
  for (const file of files) {
    assert.equal(report.sourceSha256[file], createHash('sha256').update(readFileSync(join(root, file))).digest('hex'), file);
  }
});
