import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('packed Crew example imports both exports with the retained SDK archive', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-crew-consumer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const archives = ['packages/contracts', 'examples/crew'].map(path => {
    const [packed] = JSON.parse(execFileSync('npm', ['pack', `./${path}`, '--pack-destination', directory, '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
    if (path === 'examples/crew') {
      const paths = packed.files.map(file => file.path);
      for (const name of ['index', 'file-intents']) {
        assert.ok(paths.includes(`dist/${name}.js`), `packed ${name} runtime`);
        assert.ok(paths.includes(`dist/${name}.d.ts`), `packed ${name} declarations`);
      }
    }
    return join(directory, packed.filename);
  });
  const sdk = join(root, 'vendor/crew-client/37c596577b4998fba67b09451ddb16ac0695c08d/birbcrew-client-0.1.0.tgz');
  const [zod] = JSON.parse(execFileSync('npm', ['pack', join(root, 'node_modules/zod'), '--pack-destination', directory, '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module',
    dependencies: { '@birbcrew/client': `file:${sdk}`, zod: `file:${join(directory, zod.filename)}` },
    overrides: { '@birbcrew/client': '$@birbcrew/client', zod: '$zod' } }));
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...archives], { cwd: directory, stdio: 'pipe' });
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { join } from 'node:path';
    import { connectCrewConversation } from '@agentui/example-crew';
    import { fileIntents } from '@agentui/example-crew/file-intents';
    import { CrewClient } from '@birbcrew/client';
    assert.equal(typeof connectCrewConversation, 'function');
    assert.equal(typeof fileIntents, 'function');
    assert.equal(typeof CrewClient, 'function');
    const consumerRequire = createRequire(join(process.cwd(), 'package.json'));
    const exampleRequire = createRequire(consumerRequire.resolve('@agentui/example-crew'));
    const crewRequire = createRequire(exampleRequire.resolve('@birbcrew/client'));
    assert.equal(exampleRequire('zod/package.json').version, '4.6.6');
    assert.equal(crewRequire('zod/package.json').version, '4.6.6');
    assert.equal(crewRequire.resolve('zod'), exampleRequire.resolve('zod'));
  `], { cwd: directory, stdio: 'pipe' });
});
