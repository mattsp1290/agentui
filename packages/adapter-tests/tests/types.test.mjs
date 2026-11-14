import { test } from 'node:test';
import { assertCompileCases } from './support/compile.mjs';
const targets = [
  ['packages/contracts', 'RunIdentity', '@agentui/contracts', ['document', 'process']],
  ['packages/sdk', 'ExtensionManifest', '@agentui/sdk', ['document', 'process']],
  ['packages/sdk', 'ConversationModule', '@agentui/sdk/react', ['document', 'process'], 'tsconfig.react.json'],
  ['packages/theme', 'Theme', '@agentui/theme', ['document', 'process']],
  ['packages/theme', 'ThemeProviderProps', '@agentui/theme/react', ['document', 'process'], 'tsconfig.react.json'],
  ['packages/ui-primitives', 'ButtonProps', '@agentui/ui-primitives/desktop', ['process']],
  ['packages/ui-primitives', 'ButtonProps', '@agentui/ui-primitives/native', ['document', 'process'], 'tsconfig.native.json'],
  ['packages/host', 'EventObserver', '@agentui/host', ['document']],
  ['apps/desktop', 'DesktopMount', '@agentui/desktop', ['process']],
  ['apps/ios', 'IosConversationView', '@agentui/ios', ['document', 'process']],
];

for (const [workspace, type, name, forbidden, configFile = 'tsconfig.json'] of targets) {
  test(`${name} rejects foreign ambient globals`, () => assertCompileCases({
    config: `${workspace}/${configFile}`,
    prefix: `import type { ${type} } from '${name}';\nexport type Probe = ${type}${type === 'EventObserver' ? '<string>' : ''};\n`,
    cases: [['', null], ...forbidden.map((global) => [`void ${global};\n`, new RegExp(`Cannot find name '${global}'`)])],
  }));
}

test('run authority has exactly one binding and requires its owner', async () => {
  await assertCompileCases({
    prefix: "import type { RunAuthority, RunIdentity } from '@agentui/contracts';\nconst binding = { namespace: 'example.crew', installationId: 'agent', opaqueSessionId: 'session' };\nexport type Identity = RunIdentity;\n",
    cases: [
      ["export const valid: RunAuthority = { kind: 'remote-provider', binding };", null],
      ["void binding; export const invalid: RunAuthority = { kind: 'remote-provider' };", /Property 'binding' is missing/],
      ["export const invalid: RunAuthority = { kind: 'agentui-host', binding };", /Property 'hostId' is missing/],
      ["export const invalid: RunIdentity = { conversation: { hostId: 'host', conversationId: 'conversation' }, runId: 'run', authority: { kind: 'remote-provider', binding }, provider: binding };", /'provider' does not exist/],
    ],
  });
});
