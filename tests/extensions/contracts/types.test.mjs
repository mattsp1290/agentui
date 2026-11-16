import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertCompileCases } from '../../support/compile.mjs';

const fixture = await readFile(new URL('./fixture.ts', import.meta.url), 'utf8');
const provider = await readFile(new URL('../providers/contracts/crew.ts', import.meta.url), 'utf8');

test('UI authors retain typed actions, tool decoders, platform and process boundaries', () => assertCompileCases({
  config: 'apps/desktop/tsconfig.json',
  prefix: fixture + `
import { memo } from 'react';
import { parseUiExtensionContributions, type UiExtensionCapture, type UiExtensionContext } from '@agentui/sdk/react';
export function captured(value: unknown) { const result: UiExtensionCapture = parseUiExtensionContributions(value); if (result.kind === 'ready') { void result.presentation.modules; void result.dispose(); } }
export const ui: UiExtensionContext = { namespace: 'notes', frontendTools: { add() {} } };
ui.frontendTools.add(textTool);
export const wrapped: ConversationModule = { id: 'memo', label: 'Memo', component: memo(() => null) };
export const transcript: UiExtensionContributions = { modules: [], overrides: { transcript: memo(({ activity }: ConversationModuleProps) => createElement('p', null, activity.domain.messages.length)) }, dispose() {} };
export const action: ModuleAction = { id: 'cancel', label: 'Stop', run: ({ commands }) => commands.cancel('run') };
`,
  cases: [
    ['', null],
    ["export const bad: UiExtensionCapture = { kind: 'invalid-presentation', error: new Error() };", /'dispose' is missing/u],
    ["export const bad: UiExtensionCapture = { kind: 'ready', dispose: async () => {}, presentation: { modules: [] } };", /'transcript' is missing/u],
    ["export function bad(result: UiExtensionCapture) { if (result.kind === 'invalid-lifetime') result.dispose(); }", /Property 'dispose' does not exist/u],
    ["export const bad: UiExtensionEntry<'ios'> = createNotesFixture(() => {});", /not assignable/u],
    ["export const bad: ModuleAction = { id: 'x', label: 'X', async run() {} };", /not assignable/u],
    ["ui.frontendTools.add<{ count: number }>(textTool);", /not assignable/u],
    ["export const bad: FrontendToolContribution<{ text: string }> = { ...textTool, async execute() { return 3; } };", /not assignable/u],
    ["export const bad: UiExtensionContributions = { overrides: {}, dispose() {} };", /'modules' is missing/u],
    ["export const bad: UiExtensionContributions = { modules: [], overrides: {} };", /'dispose' is missing/u],
    ["export const bad: UiExtensionContributions = { modules: [], overrides: { composer: () => null }, dispose() {} };", /does not exist/u],
    ["export const bad: UiExtensionContributions = { modules: [], overrides: { transcript: ({ wrong }: { wrong: string }) => createElement('p', null, wrong) }, dispose() {} };", /not assignable/u],
    ["ui.credentials;", /Property 'credentials' does not exist/u],
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
    context.providers.add('crew', crew, crewPresentation);
    context.providers.add<CrewModel, 'crew-personal'>('crew-again', crew, crewPresentation);
    return { async dispose() {} };
  },
} satisfies SDK.ServerExtensionEntry;
`,
  cases: [
    ['', null],
    ["export function bad(context: SDK.ServerExtensionContext) { context.providers.add<SDK.ProviderModel, string>('crew', crew, crewPresentation); }", /not assignable/u],
    ["export const bad: SDK.ServerExtensionEntry = { ...server, async activate() {} };", /not assignable/u],
    ["export function bad(context: SDK.ServerExtensionContext) { context.frontendTools; }", /Property 'frontendTools' does not exist/u],
    ['void document;', /Cannot find name 'document'/u], ['void process;', /Cannot find name 'process'/u],
  ],
}));

test('shipped Plan review template typechecks against the actual receipt and command contracts', async () => {
  const template = await readFile(new URL('../../../templates/customization/desktop/index.tsx', import.meta.url), 'utf8');
  await assertCompileCases({ config: 'apps/desktop/tsconfig.json',
    prefix: template.replace("import { reviewPrompt } from '../shared/prompts.js';", "const reviewPrompt = 'Review the plan';"), cases: [['', null]] });
});

test('transcript selection requires a ready owner with a captured component', () => assertCompileCases({
  config: 'apps/desktop/tsconfig.json',
  prefix: `
import type { TranscriptSelection } from ${JSON.stringify(fileURLToPath(new URL('../../../apps/desktop/dist/application/DesktopCustomizations.js', import.meta.url)))};
declare const generation: import('@agentui/sdk/tools').FrontendToolGeneration;
export const owner = { kind: 'ready', namespace: 'notes', lifetime: 1, generation, fail(_error: unknown) {},
  presentation: { modules: [], transcript: () => null } } as const;
export const selection: TranscriptSelection = { kind: 'override', owner };
export function component(value: TranscriptSelection) { if (value.kind === 'override') return value.owner.presentation.transcript; return null; }
`,
  cases: [
    ['', null],
    ["export const bad: TranscriptSelection = { kind: 'override', owner: { ...owner, presentation: { modules: [], transcript: undefined } } };", /not assignable/u],
    ["export const bad: TranscriptSelection = { kind: 'override', owner: { kind: 'loading', namespace: 'notes' } };", /not assignable/u],
  ],
}));
