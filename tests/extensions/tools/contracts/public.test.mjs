import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { assertCompileCases } from '../../../support/compile.mjs';

const root = process.cwd();
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
test('packed tools consumer resolves its dependency and types without DOM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentui-tools-consumer-'));
  try {
    const packs = JSON.parse(
      run(
        'npm',
        [
          'pack',
          './packages/sdk',
          './packages/contracts',
          './packages/protocol',
          './node_modules/@cfworker/json-schema',
          './node_modules/@ag-ui/core',
          '--json',
          '--ignore-scripts',
          '--pack-destination',
          dir,
        ],
        root,
      ),
    );
    for (const pack of packs) {
      const dest = join(dir, 'node_modules', pack.name);
      await mkdir(dest, { recursive: true });
      run('tar', ['-xzf', join(dir, pack.filename), '-C', dest, '--strip-components=1'], dir);
    }
    const names = new Set(packs.map(pack => pack.name));
    for (const pack of packs) {
      const manifest = JSON.parse(await readFile(join(dir, 'node_modules', pack.name, 'package.json'), 'utf8'));
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        assert.ok(names.has(dependency), `${pack.name} needs ${dependency}`);
      }
      if (pack.name === '@agentui/sdk') assert.equal(manifest.dependencies['@cfworker/json-schema'], '4.1.6');
    }
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ extends: join(root, 'tsconfig.base.json') }),
    );
    await assertCompileCases({
      config: join(dir, 'tsconfig.json'),
      prefix:
        "import { createFrontendToolGeneration, pinFrontendTools, retainFrontendTools, type RetainedFrontendTools, type FrontendToolRetentionOptions, type FrontendToolContribution, type FrontendToolOutcome } from '@agentui/sdk/tools';\nexport { createFrontendToolGeneration, pinFrontendTools, retainFrontendTools }; export type { RetainedFrontendTools, FrontendToolRetentionOptions, FrontendToolContribution, FrontendToolOutcome };\n",
      cases: [
        [
          "const t: FrontendToolContribution<string> = { definition: { name: 'x', description: 'x' }, decodeInput() { return 'x'; }, async execute(x) { return x; } }; void createFrontendToolGeneration; void t; declare const g: import('@agentui/sdk/tools').FrontendToolGeneration; declare const run: import('@agentui/contracts').RunIdentity; const p = pinFrontendTools({ generations: [g], platform: 'ios', run, capabilities: { tools: { clientProvided: true } } }); const o: Promise<FrontendToolOutcome> = p.invoke('a__b', {}, 'activation'); void o;",
          null,
        ],
        [
          "const t: FrontendToolContribution<string> = { definition: { name: 'x', description: 'x' }, decodeInput() { return 1; }, async execute(x) { return x; } }; void t;",
          /not assignable/u,
        ],
        [
          "function decode(value: unknown): { modules: string[] } { void value; return { modules: ['sync'] }; } void pinFrontendTools; void (null as unknown as FrontendToolContribution<string>); void (null as unknown as FrontendToolOutcome); const result = await createFrontendToolGeneration({ namespace: 'demo', generation: '1', platform: 'desktop', capture: decode, activate() { return {}; } }); void result.contributions.modules;",
          null,
        ],
        [
          "function accept(value: unknown) { void value; return { modules: ['x'] }; } void createFrontendToolGeneration({ namespace: 'demo', generation: '1', platform: 'desktop', accept, activate() { return {}; } });",
          /does not exist/u,
        ],
        [
          "const t: FrontendToolContribution<string> = { definition: { name: 1, description: 'x' }, decodeInput() { return 'x'; }, async execute(x) { return x; } }; void t;",
          /not assignable/u,
        ],
        [
          "function capture(value: unknown) { void value; return { modules: ['x'] }; } const result = await createFrontendToolGeneration({ namespace: 'demo', generation: '1', platform: 'desktop', capture, activate() { return {}; } }); result.contributions.dispose();",
          /Property 'dispose' does not exist/u,
        ],
        [
          "const result = await createFrontendToolGeneration({ namespace: 'demo', generation: '1', platform: 'desktop', async capture() { return { modules: ['async'] }; }, activate(context) { const namespace: string = context.namespace; const tools: import('@agentui/sdk/tools').FrontendToolContributions = context.frontendTools; void namespace; void tools; return {}; } }); const modules: string[] = result.contributions.modules; void modules; void pinFrontendTools; declare const tool: FrontendToolContribution<string>; declare const outcome: FrontendToolOutcome; void tool; void outcome;",
          null,
        ],
        [
          "const result = await createFrontendToolGeneration({ namespace: 'demo', generation: '1', platform: 'desktop', capture: () => undefined, activate() { return { dispose() {} }; } }); const empty: undefined = result.contributions; void empty;",
          null,
        ],
        [
          "const data = { dispose: 'ordinary data', count: 1 }; const result = await createFrontendToolGeneration({ namespace: 'demo', generation: '1', platform: 'desktop', capture: () => data, activate() { return { dispose() {} }; } }); const same: typeof data = result.contributions; const field: string = same.dispose; void field;",
          null,
        ],
        [
          "void createFrontendToolGeneration({ namespace: 'demo', generation: '1', platform: 'desktop', activate() { return {}; } });",
          /'capture' is missing/u,
        ],
        [
          "void createFrontendToolGeneration({ namespace: 'demo', generation: '1', platform: 'desktop', capture: false, activate() { return {}; } });",
          /not assignable/u,
        ],
        ["declare const options: FrontendToolRetentionOptions; declare const run: import('@agentui/contracts').RunIdentity; const retained: RetainedFrontendTools = retainFrontendTools(options); const pin: import('@agentui/sdk/tools').FrontendToolPin = retained.bind(run); void pin;", null],
        ["declare const retained: RetainedFrontendTools; retained.invoke('demo__x', {}, 'activation');", /Property 'invoke' does not exist/u],
        ["declare const retained: RetainedFrontendTools; retained.definitions.push({ name: 'x', description: '' });", /Property 'push' does not exist/u],
        ["declare const retained: RetainedFrontendTools; retained.definitions[0].name = 'changed';", /read-only property/u],
        ["declare const retained: RetainedFrontendTools; retained.bindings[0].activationId = 'changed';", /read-only property/u],
        ["declare const retained: RetainedFrontendTools; retained.bindings.push({ name: 'x', activationId: 'changed' });", /Property 'push' does not exist/u],
        ["declare const p: import('@agentui/sdk/tools').FrontendToolPin; p.definitions[0].name = 'changed';", /read-only property/u],
        ["declare const p: import('@agentui/sdk/tools').FrontendToolPin; p.invoke('demo__x', {});", /Expected 3 arguments/u],
        ['void document;', /Cannot find name 'document'/u],
        ['void process;', /Cannot find name 'process'/u],
      ],
    });
    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import assert from 'node:assert/strict';
          import { createFrontendToolGeneration, pinFrontendTools, retainFrontendTools } from '@agentui/sdk/tools';
          const { generation } = await createFrontendToolGeneration({
            namespace: 'demo', generation: '1', platform: 'ios', capture() { return undefined; },
            activate({ frontendTools: tools }) {
              tools.add({
                definition: { name: 'x', description: 'x', parameters: { type: 'object',
                  properties: { email: { type: 'string', format: 'email' } }, required: ['email'] } },
                decodeInput: value => value.email, async execute(email) { return email; },
              });
              return { dispose() {} };
            },
          });
          const retained = retainFrontendTools({ generations: [generation], platform: 'ios' });
          const retired = generation.retire();
          let pin;
          try {
            const actualRun = { conversation: { hostId: 'h', conversationId: 'c' }, runId: 'r',
              authority: { kind: 'remote-provider', binding: { namespace: 'n', installationId: 'i', opaqueSessionId: 's' } } };
            pin = retained.bind(actualRun);
            assert.equal(retained.bind(structuredClone(actualRun)), pin);
            assert.equal(pin.definitions, retained.definitions);
            assert.throws(() => pinFrontendTools({ generations: [generation], platform: 'ios',
              run: { conversation: { hostId: 'h', conversationId: 'c' }, runId: 'r',
                authority: { kind: 'remote-provider', binding: { namespace: 'n', installationId: 'i', opaqueSessionId: 's' } } },
              capabilities: { tools: { clientProvided: true } } }));
            assert.deepEqual(await pin.invoke('demo__x', { email: 'a@example.com' }, pin.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? ''), { kind: 'completed', output: 'a@example.com' });
            assert.deepEqual(await pin.invoke('demo__x', { email: 'invalid' }, pin.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? ''), { kind: 'refused', code: 'invalid-arguments' });
          } finally {
            pin?.release(); retained.release();
            await retired;
          }
        `,
      ],
      dir,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('root and react bundles exclude the validator', async () => {
  for (const entry of ['@agentui/sdk', '@agentui/sdk/react']) {
    const result = await build({
      stdin: { contents: `import * as sdk from '${entry}'; console.log(sdk);`, resolveDir: root },
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      metafile: true,
      external: ['react'],
    });
    assert.equal(
      Object.keys(result.metafile.inputs).some((path) => path.includes('@cfworker/json-schema')),
      false,
    );
  }
});

test('tools import survives a URL with a getter-only hash', () => {
  run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const NativeURL = URL;
    globalThis.URL = class extends NativeURL { get hash() { return super.hash; } };
    const { createFrontendToolGeneration } = await import('@agentui/sdk/tools');
    let failed = false;
    try { await createFrontendToolGeneration({ namespace: 'demo', generation: '1', platform: 'ios', capture() { return undefined; }, activate({ frontendTools: t }) { t.add({ definition: { name: 'x', description: 'x' }, decodeInput(x) { return x; }, async execute() { return ''; } }); return { dispose() {} }; } }); } catch (error) { failed = /standards-compliant URL/.test(error.message) && error.cause instanceof Error; }
    if (!failed) throw Error('registration should fail with a constrained URL');
  `,
    ],
    root,
  );
});


test('react-tools opts into validator runtime while its declarations need no platform globals', async () => {
  const result = await build({
    stdin: { contents: "import { createUiExtensionGeneration } from '@agentui/sdk/react-tools'; console.log(createUiExtensionGeneration);", resolveDir: root },
    bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, external: ['react'],
  });
  assert.equal(Object.keys(result.metafile.inputs).some(path => path.includes('@cfworker/json-schema')), true);
  await assertCompileCases({ config: join(root, 'packages/sdk/tsconfig.react.json'),
    prefix: "import { createUiExtensionGeneration } from '@agentui/sdk/react-tools';\n",
    cases: [
      ["const active = await createUiExtensionGeneration({ namespace: 'demo', generation: 'one', platform: 'desktop', activate() { return { modules: [], dispose() {} }; } }); void active.generation.retire; void active.presentation.modules;", null],
      ["const active = await createUiExtensionGeneration({ namespace: 'demo', generation: 'one', platform: 'desktop', activate() { return { modules: [], dispose() {} }; } }); active.presentation.dispose();", /Property 'dispose' does not exist/u],
      ["void createUiExtensionGeneration; void document;", /Cannot find name 'document'/u],
      ["void createUiExtensionGeneration; void process;", /Cannot find name 'process'/u],
    ],
  });
});
