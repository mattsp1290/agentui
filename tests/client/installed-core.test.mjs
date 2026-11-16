import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('packed core installs and imports with no React present', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-core-consumer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const archives = ['contracts', 'client'].map(name => {
    const packed = JSON.parse(execFileSync('npm', ['pack', `./packages/${name}`, '--pack-destination', directory, '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
    return join(directory, packed[0].filename);
  });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', overrides: { '@ag-ui/core': `file:${join(root, 'vendor/ag-ui/ed2c1d5b63299d3f08676a1418cc2640bbe55fd1/ag-ui-core-1.0.4.tgz')}` } }));
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...archives], { cwd: directory, stdio: 'pipe' });
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createConversationStore } from '@agentui/client';
    assert.equal(typeof createConversationStore, 'function');
    await assert.rejects(import('react'), { code: 'ERR_MODULE_NOT_FOUND' });
  `], { cwd: directory, stdio: 'pipe' });
});
