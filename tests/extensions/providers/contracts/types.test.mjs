import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assertCompileCases } from '../../../support/compile.mjs';

export const fixtureSource = (await Promise.all(['crew.ts', 'local.ts'].map((name) => readFile(new URL(name, import.meta.url), 'utf8'))))
  .map((source, index) => index ? source.replace("import * as SDK from '@agentui/sdk';", '') : source).join('\n');

const control = `
export const pendingCreation: SDK.ProviderOutcome<SDK.ProviderConversation<'crew-personal'>> = { kind: 'pending', evidence: null };
export const failures: readonly SDK.ProviderFailure[] = [
  { kind: 'unavailable', reason: 'offline' }, { kind: 'authentication-failed', reason: 'expired' },
  { kind: 'unauthorized', reason: 'revoked' }, { kind: 'version-unsupported', reason: 'changed' },
];
export const observations: readonly SDK.ProviderOutcome<SDK.ProviderConversation<'crew-personal'>>[] = [
  pendingCreation, ...failures, { kind: 'confirmed', value: crewBinding, evidence: null },
  { kind: 'not-dispatched', reason: 'disabled' }, { kind: 'rejected', reason: 'denied', evidence: null },
  { kind: 'uncertain', reason: 'lost', evidence: null }, { kind: 'unsupported', reason: 'no creation' },
];
export async function useProviders() {
  for (const result of [
    await crew.connect({ apiVersion: 1, instance: crewInstance, credential: crewCredential }),
    await local.connect({ apiVersion: 1, instance: localInstance, credential: null }),
  ]) if (result.kind === 'connected') await result.backend.discover();
  await crewBackend.create(crewCreation);
  await localBackend.create(localCreation);
  await crewBackend.submit(crewSend);
  await localBackend.submit(localSend);
  await crewBackend.submit({ kind: 'cancel', operationId: 'cancel', binding: crewBinding, run: crewRun });
  await localBackend.submit({ kind: 'decide', operationId: 'decide', binding: localBinding, decision: localDecision, choice: localChoice });
  await crewBackend.reconcile(crewCreation);
  await crewBackend.reconcile(crewSend);
  await localBackend.reconcile(localCreation);
  await localBackend.reconcile(localSend);
  await crewBackend.snapshot(crewBinding);
  const feed = localBackend.observe({ binding: localBinding, after: localCursor }, async item => { void item; });
  feed.close();
  await feed.ended;
  await crewBackend.close();
}
`;

test('public providers construct and reject crossed scopes, incompatible payloads and widening', () => assertCompileCases({
  prefix: fixtureSource + control,
  cases: [
    ['', null],
    ['void crewBackend.create({ ...crewCreation, agent: localAgent });', /not assignable/u],
    ['void crewBackend.snapshot(localBinding);', /not assignable/u],
    ["void crewBackend.submit({ kind: 'cancel', operationId: 'x', binding: crewBinding, run: localRun });", /not assignable/u],
    ["void crewBackend.submit({ kind: 'decide', operationId: 'x', binding: crewBinding, decision: localDecision, choice: crewChoice });", /not assignable/u],
    ["void crewBackend.submit({ kind: 'decide', operationId: 'x', binding: crewBinding, decision: crewDecision, choice: localChoice });", /not assignable/u],
    ['void crewBackend.observe({ binding: crewBinding, after: localCursor }, async () => {});', /not assignable/u],
    ['void crew.connect({ apiVersion: 1, instance: crewInstance, credential: localCredential });', /not assignable/u],
    ['void crew.connect({ instance: crewInstance, credential: crewCredential });', /'apiVersion' is missing/u],
    ['void crew.connect({ apiVersion: 2, instance: crewInstance, credential: crewCredential });', /not assignable to type '1'/u],
    ['void crewBackend.submit(localSend);', /not assignable/u],
    ["void crewBackend.submit({ ...crewSend, request: { input: [] } });", /'input' does not exist/u],
    ['void crewBackend.observe({ binding: crewBinding, after: 7 }, async () => {});', /not assignable/u],
    ["void crewBackend.snapshot({ kind: 'session', opaqueId: 'same-session', instance: crewInstance });", /not assignable/u],
    ['void crewBackend.snapshot(crewAgent);', /missing the following properties.*creation, authority/u],
    ["export const invalid: SDK.ProviderConversation<'crew-personal'> = { kind: 'agentui-created', authority: crewBinding.authority };", /'creation' is missing/u],
    ["export const invalid: SDK.ProviderCursor<LocalModel, 'crew-personal'> = crewCursor;", /not assignable/u],
    ["export const invalid: SDK.ProviderCursor<CrewModel | LocalModel, 'crew-personal'> = crewCursor;", /not assignable/u],
    ["export const invalid: SDK.ProviderInstance<'crew-personal' | 'native-work'> = crewInstance;", /not assignable/u],
    ["export const invalid: SDK.BackendProvider<CrewModel | LocalModel, 'crew-personal'> = crew;", /not assignable/u],
    ["export const invalid: SDK.ConnectedProvider<CrewModel, 'crew-personal' | 'native-work'> = crewBackend;", /not assignable/u],
    ["export const invalid: SDK.ProviderCommand<CrewModel | LocalModel, 'crew-personal'> = crewSend;", /not assignable/u],
    ["export type Invalid = SDK.BackendProvider<{ request: () => void; cursor: string; state: null; event: null }, 'x'>;", /does not satisfy the constraint 'ProviderModel'/u],
    ["export const invalid: SDK.ProviderOutcome<SDK.ProviderConversation<'crew-personal'>> = { kind: 'confirmed', evidence: null };", /'value' is missing/u],
    ["void pendingCreation.value;", /Property 'value' does not exist/u],
    ["export const invalid: SDK.CredentialHandle<'crew-personal'> = { kind: 'credential-handle', instance: crewInstance, opaqueHandle: 'x' };", /'hostId' is missing/u],
    ["export const invalid: SDK.ProviderInstance<'crew-personal'> = { namespace: 'x', installationId: 'crew-personal', generation: '1' };", /'protocolVersion' is missing/u],
    ["export const invalid: SDK.CredentialHandle<string> = crewCredential;", /not assignable/u],
    ['void document;', /Cannot find name 'document'/u],
    ['void process;', /Cannot find name 'process'/u],
    ["export type { ProviderModel } from '@agentui/sdk/src/providers.js';", /Cannot find module/u],
  ],
}));
