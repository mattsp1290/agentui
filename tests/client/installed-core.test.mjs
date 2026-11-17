import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('packed core installs and imports with no React present', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-core-consumer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const cache = join(directory, 'npm-cache');
  const installedHash = JSON.parse(readFileSync(join(root, 'node_modules/fast-sha256/package.json'), 'utf8'));
  assert.equal(installedHash.name, 'fast-sha256');
  assert.equal(installedHash.version, '1.3.0');
  const archives = [
    ['./packages/contracts', '@agentui/contracts', '0.0.0'],
    ['./packages/client', '@agentui/client', '0.0.0'],
    ['./node_modules/fast-sha256', installedHash.name, installedHash.version],
  ].map(([source, name, version]) => {
    const packed = JSON.parse(execFileSync('npm', ['pack', source, '--pack-destination', directory, '--json', '--ignore-scripts', '--offline', '--cache', cache], { cwd: root, encoding: 'utf8' }));
    assert.equal(packed.length, 1);
    assert.equal(packed[0].name, name);
    assert.equal(packed[0].version, version);
    return join(directory, packed[0].filename);
  });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, ...archives], { cwd: directory, stdio: 'pipe' });
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createConversationStore } from '@agentui/client';
    import { createBrowserConnection, ServiceProtocolError } from '@agentui/client/service';
    import { parseOutputId } from '@agentui/contracts';
    assert.equal(typeof createConversationStore, 'function');
    const scope = { hostId: 'host', conversationId: 'conversation' };
    const outputId = parseOutputId('output-' + 'a'.repeat(64));
    const output = { outputId, name: 'report.txt', mediaType: 'text/plain', byteLength: 1,
      sha256: '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd', lifetime: 'provider-retained' };
    const client = createBrowserConnection({ fetch: async () => Response.json({ ok: true,
      value: { scope, outputId, result: { kind: 'available', output, base64: 'QQ==' } } }) });
    const result = await client.readOutput(scope, outputId);
    assert.equal(result.kind, 'available');
    assert.deepEqual(result.bytes, Uint8Array.of(65));
    output.sha256 = '0'.repeat(64);
    await assert.rejects(client.readOutput(scope, outputId), ServiceProtocolError);
    for (const dependency of ['react', '@ag-ui/core', 'zod', '@agentui/host']) await assert.rejects(import(dependency), { code: 'ERR_MODULE_NOT_FOUND' });
  `], { cwd: directory, stdio: 'pipe' });
  writeFileSync(join(directory, 'consumer.ts'), `import { createConversationStore } from '@agentui/client'; import type { FrontendDefinition } from '@agentui/contracts'; export const factory = createConversationStore; export const tool: FrontendDefinition = { name: 'demo__echo', description: 'Echo', parameters: { type: 'object' } };`);
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: false, types: [], lib: ['ES2023'] }, files: ['consumer.ts'] }));
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(directory, 'tsconfig.json')], { cwd: directory, stdio: 'pipe' });
});
