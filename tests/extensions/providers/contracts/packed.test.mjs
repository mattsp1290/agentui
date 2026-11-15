import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertCompileCases } from '../../../support/compile.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, `${result.error?.message ?? ''}${result.stdout}${result.stderr}`);
  return result.stdout;
}

test('packed SDK supports isolated platform-neutral provider authors through public exports', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'agentui-provider-consumer-'));
  try {
    const packs = JSON.parse(run('npm', ['pack', './packages/sdk', './packages/contracts', '--json', '--ignore-scripts', '--pack-destination', temporary], root));
    for (const pack of packs) {
      const destination = join(temporary, 'node_modules', pack.name);
      await mkdir(destination, { recursive: true });
      run('tar', ['-xzf', join(temporary, pack.filename), '-C', destination, '--strip-components=1'], temporary);
    }
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await writeFile(join(temporary, 'tsconfig.json'), JSON.stringify({ extends: join(root, 'tsconfig.base.json') }));
    const sources = await Promise.all(['crew.ts', 'local.ts'].map((name) => readFile(new URL(name, import.meta.url), 'utf8')));
    const prefix = sources.map((source, index) => index ? source.replace("import * as SDK from '@agentui/sdk';", '') : source).join('\n');
    await assertCompileCases({ config: join(temporary, 'tsconfig.json'), prefix, cases: [
      ["export const constructed: SDK.BackendProvider<CrewModel, 'native-work'> = createCrewFixture(localInstance).crew; export const dynamic: SDK.BackendProvider<CrewModel, string> = crewForRuntimeInstallation('runtime-assigned');", null],
      ["export function activate(context: SDK.ServerExtensionContext) { context.providers.add('crew', crew, crewPresentation); context.providers.add('local', local, localPresentation); const dynamic = createCrewFixture<string>({ namespace: 'dynamic', installationId: 'runtime', generation: '1', protocolVersion: '1' }); context.providers.add('dynamic', dynamic.crew, dynamic.crewPresentation); }", null],
      ["export const refs: SDK.PresentationRefs<'crew-personal'> = { run(ref) { return { conversation: ref.binding.creation.scope, authority: ref.binding.authority, runId: ref.ref.opaqueId }; } }; export const applied = crewPresentation.apply({ messages: ['previous'] }, { kind: 'message', text: 'next' }, refs);", null],
      ["export const invalid: SDK.ProviderPresentation<CrewModel | LocalModel, 'crew-personal'> = crewPresentation;", /not assignable/u],
      ["export const invalid: SDK.ProviderPresentation<CrewModel, string> = crewPresentation;", /not assignable/u],
      ["export const invalid: SDK.ProviderPresentation<Omit<CrewModel, 'cursor'> & { cursor: SDK.Json }, 'crew-personal'> = crewPresentation;", /not assignable/u],
      ["export function bad(context: SDK.ServerExtensionContext) { context.providers.add('mixed', crew, localPresentation); }", /not assignable/u],
      ["crewPresentation.apply({ messages: [] }, { append: 'wrong model' }, { run(ref) { return { conversation: ref.binding.creation.scope, authority: ref.binding.authority, runId: ref.ref.opaqueId }; } });", /'append' does not exist/u],
      ['void process;', /Cannot find name 'process'/u],
      ['void document;', /Cannot find name 'document'/u],
      ["export type { ProviderModel } from '@agentui/sdk/providers';", /Cannot find module/u],
    ] });
    run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { backendProviderContractVersion } from '@agentui/sdk';
      assert.equal(backendProviderContractVersion, 1);
      await assert.rejects(import('@agentui/sdk/src/providers.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
      await assert.rejects(import('@agentui/sdk/providers'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    `], temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
