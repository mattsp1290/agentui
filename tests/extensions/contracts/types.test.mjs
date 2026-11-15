import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assertCompileCases } from '../../support/compile.mjs';

const fixture = await readFile(new URL('./fixture.ts', import.meta.url), 'utf8');
const provider = await readFile(new URL('../providers/contracts/crew.ts', import.meta.url), 'utf8');

test('UI authors retain typed actions, tool decoders, platform and process boundaries', () => assertCompileCases({
  config: 'apps/desktop/tsconfig.json',
  prefix: fixture + `
import { memo } from 'react';
import type { UiExtensionContext } from '@agentui/sdk/react';
export const ui: UiExtensionContext = { namespace: 'notes', frontendTools: { add() {} } };
ui.frontendTools.add(textTool);
export const wrapped: ConversationModule = { id: 'memo', label: 'Memo', component: memo(() => null) };
export const action: ModuleAction = { id: 'cancel', label: 'Stop', run: ({ commands }) => commands.cancel('run') };
`,
  cases: [
    ['', null],
    ["export const bad: UiExtensionEntry<'ios'> = createNotesFixture(() => {});", /not assignable/u],
    ["export const bad: ModuleAction = { id: 'x', label: 'X', async run() {} };", /not assignable/u],
    ["ui.frontendTools.add<{ count: number }>(textTool);", /not assignable/u],
    ["export const bad: FrontendToolContribution<{ text: string }> = { ...textTool, async execute() { return 3; } };", /not assignable/u],
    ["ui.providers;", /Property 'providers' does not exist/u],
    ["export const bad: ExtensionManifest = { ...manifest, entries: [] };", /not assignable/u],
    ["export const bad: ConversationModuleProps = { conversation: { hostId: 'h', conversationId: 'c' } };", /missing the following properties/u],
    ["export const bad: ConversationModuleProps['activity'] = { domain: { messages: [], currentRun: null }, decisions: {} };", /'receipts' is missing/u],
  ],
}));

test('server-only registration accepts concrete existing providers without widening their model', () => assertCompileCases({
  prefix: provider + `
export const server = {
  kind: 'server', sdkVersion: SDK.EXTENSION_SDK_VERSION,
  async activate(context: SDK.ServerExtensionContext) {
    context.providers.add('crew', crew);
    context.providers.add<CrewModel, 'crew-personal'>('crew-again', crew);
    return { async dispose() {} };
  },
} satisfies SDK.ServerExtensionEntry;
`,
  cases: [
    ['', null],
    ["export function bad(context: SDK.ServerExtensionContext) { context.providers.add<SDK.ProviderModel, string>('crew', crew); }", /not assignable/u],
    ["export const bad: SDK.ServerExtensionEntry = { ...server, async activate() {} };", /not assignable/u],
    ["export function bad(context: SDK.ServerExtensionContext) { context.frontendTools; }", /Property 'frontendTools' does not exist/u],
    ['void document;', /Cannot find name 'document'/u], ['void process;', /Cannot find name 'process'/u],
  ],
}));
