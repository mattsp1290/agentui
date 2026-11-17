import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCompileCases } from '../support/compile.mjs';
import { SqliteStore } from '../../packages/host/dist/sqlite-store.js';
import { budgets } from '../../packages/host/dist/durable-model.js';
import { command, fixture, installed, projection, scope } from './fixture.mjs';

const offer = { version: 2, scope, clientCommandId: 'offered', body: { kind: 'send', text: 'Hello', frontend: { platform: 'desktop', tools: [{ definition: { name: 'test__inspect', description: 'Inspect' }, activationId: 'original' }] } } };
for (const [label, invalid] of [
  ['native', "{ command, target, receipt, observation: null }"],
  ['null-key', "{ kind: 'provider', command, target: provider, agui: null, receipt, observation: null }"],
]) test(`private stored commands reject offered ${label} captures`, () => assertCompileCases({
  config: new URL('../../packages/host/tsconfig.json', import.meta.url).pathname,
  prefix: `import type { StoredCommand, CapturedTarget } from '${new URL('../../packages/host/dist/durable-model.js', import.meta.url).pathname}';
    import type { ProviderTarget, AguiRunKey } from '${new URL('../../packages/host/dist/provider-commands.js', import.meta.url).pathname}';
    import type { Receipt, OfferedCommand } from '@agentui/contracts';
    export declare const target: CapturedTarget;
    export declare const provider: ProviderTarget;
    export declare const receipt: Receipt;
    export declare const command: OfferedCommand;
    export declare const agui: AguiRunKey;`,
  cases: [
    ["const value: StoredCommand = { kind: 'provider', command, target: provider, agui, receipt, observation: null }; void value;", null],
    [`const value: StoredCommand = ${invalid}; void value;`, /not assignable/u],
  ],
}));

test('durable command parsing rejects restored offered native targets', t => {
  const store = new SqliteStore(fixture(t).path, projection, budgets()); t.after(() => store.close());
  store.create(scope, installed);
  assert.equal(store.admit(command('offered'), { kind: 'supported' }).kind, 'owned');
  store.db.prepare('UPDATE commands SET intent=?').run(JSON.stringify(offer));
  assert.throws(() => store.command(scope, 'offered'), /native|offered|Corrupt/u);
});

test('owner-state authority accepts identities and offered commands but rejects generic commands', () => assertCompileCases({
  config: new URL('../../packages/host/tsconfig.json', import.meta.url).pathname,
  prefix: `import type { FrontendSends, FrontendSendActor } from '${new URL('../../packages/host/dist/frontend-sends.js', import.meta.url).pathname}';
    import type { StoredCommand, OfferedStoredCommand } from '${new URL('../../packages/host/dist/durable-model.js', import.meta.url).pathname}';
    export declare const owners: FrontendSends;
    export declare const actor: FrontendSendActor;
    export declare const stored: StoredCommand;
    export declare const offered: OfferedStoredCommand;
    export const identity = { scope: { hostId: 'host', conversationId: 'conversation' }, id: 'command' };`,
  cases: [
    ["const state: 'absent' | 'available' | 'unavailable' = owners.assertAuthority({ intent: 'owner-state', target: identity, actor }); void state;", null],
    ["owners.assertAuthority({ intent: 'owner-state', target: offered, actor });", null],
    ["owners.assertAuthority({ intent: 'dispatch', stored, actor });", null],
    ["owners.assertAuthority({ intent: 'private-settler', stored, actor });", null],
    ["owners.assertAuthority({ intent: 'owner-state', target: stored, actor });", /No overload matches/u],
    ["owners.check({ ...identity, actor });", /does not exist/u],
  ],
}));
