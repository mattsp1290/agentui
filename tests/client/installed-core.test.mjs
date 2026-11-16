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
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...archives], { cwd: directory, stdio: 'pipe' });
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createConversationStore } from '@agentui/client';
    assert.equal(typeof createConversationStore, 'function');
    for (const dependency of ['react', '@ag-ui/core', 'zod']) await assert.rejects(import(dependency), { code: 'ERR_MODULE_NOT_FOUND' });
  `], { cwd: directory, stdio: 'pipe' });
  writeFileSync(join(directory, 'consumer.ts'), `import { createConversationStore } from '@agentui/client'; import type { FrontendDefinition } from '@agentui/contracts'; export const factory = createConversationStore; export const tool: FrontendDefinition = { name: 'demo__echo', description: 'Echo', parameters: { type: 'object' } };`);
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: false, types: [], lib: ['ES2023'] }, files: ['consumer.ts'] }));
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(directory, 'tsconfig.json')], { cwd: directory, stdio: 'pipe' });
});
