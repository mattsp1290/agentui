import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assertCompileCases } from '../../../support/compile.mjs';

const fixtureSource = (await Promise.all(['crew.ts', 'local.ts'].map((name) => readFile(new URL(name, import.meta.url), 'utf8'))))
  .map((source, index) => index ? source.replace("import * as SDK from '@agentui/sdk';", '') : source).join('\n');

const control = `
export const successor: SDK.CreationIntent<'crew-personal'> = { ...crewCreation,
  from: { scope: { hostId: 'host', conversationId: 'earlier' }, binding: crewBinding.authority.binding } };
export const continued: SDK.ProviderConversation<'crew-personal'> = { ...crewBinding, creation: successor, carryingTurn: 'carrying-turn' };
export const view: SDK.ProviderPresentation<CrewModel, 'crew-personal'> = { ...crewPresentation,
  continuation: evidence => evidence === null ? null : { refused: 'continued-elsewhere' } };
export const carried: SDK.ContinuationCarried = { carriedTurns: 1, omittedTurns: 0, uncertainTurns: 0, carriedBytes: 10, limitBytes: 65536 };
export const refusals: readonly SDK.ContinuationRefusal[] = ['busy', 'limit', 'unavailable', 'continued-elsewhere'];
void crewBackend.create(successor);
`;

test('successor creation types keep the predecessor in the same installation and continuation results closed', () => assertCompileCases({
  prefix: fixtureSource + control,
  cases: [
    ['', null],
    ["export const invalid: SDK.CreationIntent<'crew-personal'> = { ...crewCreation, from: { scope: crewCreation.scope, binding: localBinding.authority.binding } };", /not assignable/u],
    ["export const invalid: SDK.CreationIntent<'crew-personal'> = { ...crewCreation, from: undefined };", /not assignable/u],
    ["export const invalid: SDK.CreationIntent<'crew-personal'> = { ...crewCreation, from: { scope: crewCreation.scope } };", /'binding' is missing/u],
    ["export const invalid: SDK.ProviderPresentation<CrewModel, 'crew-personal'> = { ...crewPresentation, continuation: () => ({ refused: 'later' }) };", /not assignable/u],
    ["export const invalid: SDK.ContinuationCarried = { carriedTurns: 1, omittedTurns: 0, uncertainTurns: 0, carriedBytes: 10 };", /'limitBytes' is missing/u],
    ["export const invalid: SDK.ProviderConversation<'crew-personal'> = { ...continued, carryingTurn: 7 };", /not assignable/u],
  ],
}));
