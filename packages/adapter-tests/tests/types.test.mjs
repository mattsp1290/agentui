import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const compiler = fileURLToPath(new URL('node_modules/typescript/bin/tsc', root));
const targets = [
  ['packages/contracts', 'RunIdentity', '@agentui/contracts', ['document', 'process']],
  ['packages/sdk', 'ExtensionManifest', '@agentui/sdk', ['document', 'process']],
  ['packages/host', 'EventObserver', '@agentui/host', ['document']],
  ['apps/desktop', 'DesktopMount', '@agentui/desktop', ['process']],
  ['apps/ios', 'IosConversationView', '@agentui/ios', ['document', 'process']],
];

for (const [workspace, type, name, forbidden] of targets) {
  test(`${name} rejects foreign ambient globals`, async () => {
    await mkdir(new URL(`${workspace}/.audit/`, root), { recursive: true });
    const temporary = await mkdtemp(fileURLToPath(new URL(`${workspace}/.audit/types-`, root)));
    try {
      const config = {
        extends: fileURLToPath(new URL(`${workspace}/tsconfig.json`, root)),
        compilerOptions: { noEmit: true, rootDir: temporary },
        files: [`${temporary}/probe.ts`],
        include: [],
      };
      await writeFile(`${temporary}/tsconfig.json`, JSON.stringify(config));
      const prefix = `import type { ${type} } from '${name}';\nexport type Probe = ${type}${type === 'EventObserver' ? '<string>' : ''};\n`;
      const compile = () => spawnSync(process.execPath, [compiler, '-p', `${temporary}/tsconfig.json`, '--pretty', 'false'], { encoding: 'utf8' });
      await writeFile(`${temporary}/probe.ts`, prefix);
      const positive = compile();
      assert.equal(positive.status, 0, positive.stdout + positive.stderr);
      for (const global of forbidden) {
        await writeFile(`${temporary}/probe.ts`, prefix + `void ${global};\n`);
        const negative = compile();
        assert.notEqual(negative.status, 0);
        assert.match(negative.stdout, new RegExp(`Cannot find name '${global}'`));
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}

test('run authority has exactly one binding and requires its owner', async () => {
  await mkdir(new URL('.audit/', root), { recursive: true });
  const temporary = await mkdtemp(fileURLToPath(new URL('.audit/authority-', root)));
  try {
    await writeFile(`${temporary}/tsconfig.json`, JSON.stringify({
      extends: fileURLToPath(new URL('tsconfig.base.json', root)),
      compilerOptions: { noEmit: true },
      files: ['probe.ts'],
    }));
    const prefix = "import type { RunAuthority, RunIdentity } from '@agentui/contracts';\nconst binding = { namespace: 'example.crew', installationId: 'agent', opaqueSessionId: 'session' };\nexport type Identity = RunIdentity;\n";
    const cases = [
      ["export const valid: RunAuthority = { kind: 'remote-provider', binding };", null],
      ["void binding; export const invalid: RunAuthority = { kind: 'remote-provider' };", /Property 'binding' is missing/],
      ["export const invalid: RunAuthority = { kind: 'agentui-host', binding };", /Property 'hostId' is missing/],
      ["export const invalid: RunIdentity = { conversation: { hostId: 'host', conversationId: 'conversation' }, runId: 'run', authority: { kind: 'remote-provider', binding }, provider: binding };", /'provider' does not exist/],
    ];
    for (const [source, diagnostic] of cases) {
      await writeFile(`${temporary}/probe.ts`, prefix + source);
      const result = spawnSync(process.execPath, [compiler, '-p', `${temporary}/tsconfig.json`, '--pretty', 'false'], { encoding: 'utf8' });
      if (diagnostic === null) assert.equal(result.status, 0, result.stdout + result.stderr);
      else {
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, diagnostic);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
