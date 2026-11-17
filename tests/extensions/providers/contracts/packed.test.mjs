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
    const packs = JSON.parse(run('npm', ['pack', './packages/sdk', './packages/contracts', './packages/protocol', './node_modules/@cfworker/json-schema', './node_modules/@ag-ui/core', '--json', '--ignore-scripts', '--pack-destination', temporary], root));
    const sdk = join(temporary, 'node_modules', '@agentui/sdk');
    const protocol = join(sdk, 'node_modules', '@agentui/protocol');
    const destinationFor = name => name === '@agentui/sdk' ? sdk : name === '@agentui/contracts' ? join(temporary, 'node_modules', name) : join(name === '@ag-ui/core' ? protocol : sdk, 'node_modules', name);
    for (const pack of packs) {
      const destination = destinationFor(pack.name);
      await mkdir(destination, { recursive: true });
      run('tar', ['-xzf', join(temporary, pack.filename), '-C', destination, '--strip-components=1'], temporary);
    }
    const names = new Set(packs.map(pack => pack.name));
    for (const pack of packs) {
      const manifest = JSON.parse(await readFile(join(destinationFor(pack.name), 'package.json'), 'utf8'));
      for (const dependency of Object.keys(manifest.dependencies ?? {})) assert.ok(names.has(dependency), `${pack.name} needs ${dependency}`);
    }
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await writeFile(join(temporary, 'tsconfig.json'), JSON.stringify({ extends: join(root, 'tsconfig.base.json') }));
    const sources = await Promise.all(['crew.ts', 'local.ts'].map((name) => readFile(new URL(name, import.meta.url), 'utf8')));
    const prefix = sources.map((source, index) => index ? source.replace("import * as SDK from '@agentui/sdk';", '') : source).join('\n');
    const agui = `declare const output: SDK.ConversationRef<'native-work', 'output'>;
      const outputs: SDK.ProviderOutputs<'native-work'> = {
        async list(binding) { return { kind: 'complete', outputs: [{ reference: { binding, ref: output.ref }, name: 'report.txt', mediaType: 'text/plain', byteLength: 0, sha256: 'a'.repeat(64) }] }; },
        async read(reference) { void reference; return { kind: 'available', bytes: new Uint8Array() }; }
      };
      export const outputBackend: SDK.ConnectedProvider<LocalModel, 'native-work'> = { ...localBackend, outputs };
      type Agui = { request: SDK.AguiModel['request']; cursor: SDK.Json; state: SDK.Json; event: SDK.Json };
      declare const aguiBackend: SDK.BackendProvider<Agui, 'actual'>;
      declare const aguiPresentation: SDK.ProviderPresentation<Agui, 'actual'>;
      declare const contributions: SDK.ProviderContributions;
    `;
    await assertCompileCases({ config: join(temporary, 'tsconfig.json'), prefix: prefix + agui, cases: [
      ["export const legacy: SDK.ConnectedProvider<LocalModel, 'native-work'> = localBackend;", null],
      ...['run', 'decision', 'choice', 'permission'].map(kind => ["const bad: SDK.ConversationRef<'native-work', '" + kind + "'> = output; void bad;", /not assignable/u]),
      ["const bad: SDK.ConversationRef<'foreign', 'output'> = output; void bad;", /not assignable/u],
      ["const bad: SDK.ProviderOutputListing<'native-work'> = { kind: 'missing' }; void bad;", /not assignable/u],
      ["const bad: SDK.ProviderOutputRead = { kind: 'unavailable', reason: 7 }; void bad;", /not assignable/u],
      ["const bad: SDK.OutputListing = { kind: 'missing', reason: 'output-missing' }; void bad;", /not assignable/u],
      ["const bad: SDK.OutputId = 'output-' + 'a'.repeat(64); void bad;", /not assignable/u],
      ["contributions.addAgui('actual', aguiBackend, aguiPresentation);", null],
      ["contributions.addAgui('generic', crew, crewPresentation);", /not assignable/u],
      ["export const constructed: SDK.BackendProvider<CrewModel, 'native-work'> = createCrewFixture(localInstance).crew; export const dynamic: SDK.BackendProvider<CrewModel, string> = crewForRuntimeInstallation('runtime-assigned');", null],
      ["export const secretProvider: SDK.SecretProvider = { async resolve(reference) { return reference === 'production/api-key' ? 'synthetic-key' : Promise.reject(new Error('Unavailable')); } }; export const material: Promise<string> = secretProvider.resolve('production/api-key');", null],
      ["export const invalid: SDK.SecretProvider = { async resolve() { return 7; } };", /not assignable/u],
      ["export const invalid: SDK.SecretProvider = {};", /'resolve' is missing/u],
      ["export function activate(context: SDK.ServerExtensionContext) { context.providers.add('crew', crew, crewPresentation); context.providers.add('local', local, localPresentation); const dynamic = createCrewFixture<string>({ namespace: 'dynamic', installationId: 'runtime', generation: '1', protocolVersion: '1' }); context.providers.add('dynamic', dynamic.crew, dynamic.crewPresentation); }", null],
      ["export const refs: SDK.PresentationRefs<'crew-personal'> = { run(ref) { return { conversation: ref.binding.creation.scope, authority: ref.binding.authority, runId: ref.ref.opaqueId }; } }; export const applied: ReturnType<typeof crewPresentation.apply> = crewPresentation.apply({ messages: ['previous'] }, { kind: 'message', text: 'next' }, refs);", null],
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
      const contract = await import('@agentui/contracts/output');
      assert.equal(contract.parseOutputId('output-' + 'a'.repeat(64)), 'output-' + 'a'.repeat(64));
      assert.equal(contract.OUTPUT_MAX_BYTES, 65536);
      await assert.rejects(import('@agentui/sdk/src/providers.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
      await assert.rejects(import('@agentui/sdk/providers'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    `], temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
