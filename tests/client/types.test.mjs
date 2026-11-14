import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const [entry, types, declaration] of [
  ['@agentui/client', [], "import type { ClientView, StoreOptions } from '@agentui/client'; export type View = ClientView<string>; export type Options = StoreOptions<string, string>;"],
  ['@agentui/client/react', ['react'], "import { useConversation } from '@agentui/client/react'; export const hook = useConversation; import type { ConversationModule } from '@agentui/sdk/react'; export type Module = ConversationModule;"],
]) {
  test(`${entry} emitted declarations compile without platform ambient globals`, async () => {
    const directory = await mkdtemp(`${root}.client-types-`);
    try {
      await writeFile(`${directory}/tsconfig.json`, JSON.stringify({ extends: `${root}tsconfig.base.json`, compilerOptions: { types, noEmit: true, rootDir: directory }, files: ['./probe.ts'] }));
      for (const forbidden of [null, 'AbortSignal', 'AbortController', 'TextEncoder', 'setTimeout', 'document', 'process']) {
        await writeFile(`${directory}/probe.ts`, declaration + (forbidden ? `\nvoid ${forbidden};` : ''));
        const result = spawnSync(process.execPath, [`${root}node_modules/typescript/bin/tsc`, '-p', `${directory}/tsconfig.json`, '--pretty', 'false'], { encoding: 'utf8' });
        const output = `${result.stdout}${result.stderr}`;
        if (forbidden) {
          assert.notEqual(result.status, 0, output);
          assert.match(output, new RegExp(`Cannot find name '${forbidden}'`));
        } else assert.equal(result.status, 0, output);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
