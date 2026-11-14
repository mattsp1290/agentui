import { test } from 'node:test';
import { assertCompileCases } from './support/compile.mjs';
const targets = [
  { workspace: 'packages/contracts', type: 'RunIdentity', module: '@agentui/contracts', forbidden: ['document', 'process'] },
  { workspace: 'packages/protocol', type: 'Event', module: '@agentui/protocol', forbidden: ['document', 'process'] },
  { workspace: 'packages/sdk', type: 'ExtensionManifest', module: '@agentui/sdk', forbidden: ['document', 'process'] },
  { workspace: 'packages/sdk', type: 'ConversationModule', module: '@agentui/sdk/react', forbidden: ['document', 'process'], config: 'tsconfig.react.json' },
  { workspace: 'packages/theme', type: 'Theme', module: '@agentui/theme', forbidden: ['document', 'process'] },
  { workspace: 'packages/theme', type: 'ThemeProviderProps', module: '@agentui/theme/react', forbidden: ['document', 'process'], config: 'tsconfig.react.json' },
  { workspace: 'packages/ui-primitives', type: 'ButtonProps', module: '@agentui/ui-primitives/desktop', forbidden: ['process'] },
  { workspace: 'packages/ui-primitives', type: 'ButtonProps', module: '@agentui/ui-primitives/native', forbidden: ['document', 'process'], config: 'tsconfig.native.json' },
  { workspace: 'packages/host', type: 'EventObserver', probe: 'EventObserver<string>', module: '@agentui/host', forbidden: ['document'] },
  { workspace: 'apps/desktop', type: 'DesktopMount', module: '@agentui/desktop', forbidden: ['process'] },
  { workspace: 'apps/ios', type: 'IosConversationView', module: '@agentui/ios', forbidden: ['document', 'process'] },
];

for (const { workspace, type, module, forbidden, probe = type, config = 'tsconfig.json' } of targets) {
  test(`${module} rejects foreign ambient globals`, () => assertCompileCases({
    config: `${workspace}/${config}`,
    prefix: `import type { ${type} } from '${module}';\nexport type Probe = ${probe};\n`,
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
