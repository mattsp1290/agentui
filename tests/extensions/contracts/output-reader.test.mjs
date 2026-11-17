import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseConversationModules } from '@agentui/sdk/react';
import { assertCompileCases } from '../../support/compile.mjs';

test('public output reader and command handles preserve canonical types and required context', () => assertCompileCases({
  config: 'apps/desktop/tsconfig.json', prefix: `
import type { OutputListing, OutputRead, OutputId } from '@agentui/sdk';
import type { SubmitResult } from '@agentui/contracts';
import type { ConversationModuleProps, ModuleAction } from '@agentui/sdk/react';
declare const props: ConversationModuleProps;
declare const id: OutputId;
export const listing: Promise<OutputListing> = props.outputs.list();
export const read: Promise<OutputRead> = props.outputs.read(id);
export const result: Promise<SubmitResult> = props.commands.send.run('hello');
export const action: ModuleAction = { id: 'send', label: 'Send', availability: p => p.commands.send.availability('hello'), run: p => p.commands.send.run('hello') };
`, cases: [
    ['', null],
    ["props.outputs.read('unbranded');", /not assignable/],
    ["props.commands.send('old callable');", /not callable/],
    ["props.commands.approve.run('pending');", /Expected 2 arguments/],
    ["props.commands.revokePermission.availability('permission');", /Expected 2 arguments/],
    ["export const missing: ConversationModuleProps = { conversation: props.conversation, activity: props.activity, commands: props.commands, permissions: props.permissions };", /'outputs' is missing/],
    ["export const missing: ModuleAction = { id: 'x', label: 'X', run: action.run };", /'availability' is missing/],
    ["export const asynchronous: ModuleAction = { ...action, async availability() { return { kind: 'available' }; } };", /not assignable/],
  ],
}));

test('action capture preserves both receivers and validates every dynamic availability result', async () => {
  const result = { kind: 'rejected', reason: 'fixture' };
  class Action {
    id = 'run'; label = 'Run'; #state = { kind: 'available' };
    availability() { return this.#state; }
    async run() { return result; }
    change(value) { this.#state = value; }
  }
  const source = new Action();
  const [module] = parseConversationModules([{ id: 'm', label: 'M', component() {}, actions: [source] }]);
  const captured = module.actions[0];
  source.availability = source.run = () => { throw new Error('Replaced'); };
  assert.deepEqual(captured.availability({}), { kind: 'available' });
  assert.equal(await captured.run({}), result);
  source.change({ kind: 'disabled', reason: 'Exact current reason' });
  assert.deepEqual(captured.availability({}), { kind: 'disabled', reason: 'Exact current reason' });
  for (const value of [null, true, {}, { kind: 'disabled' }, { kind: 'disabled', reason: '' }, { kind: 'disabled', reason: ' ' }, { kind: 'disabled', reason: 4 }, { kind: 'unknown' }, Promise.resolve({ kind: 'available' }), Promise.reject(new Error('Async availability failed')), JSON.parse('{"kind":"available","then":true}')]) {
    source.change(value);
    assert.throws(() => captured.availability({}), /synchronous command availability/);
  }
});


test('installed authored Reports fixture compiles with ordinary public SDK imports', async () => assertCompileCases({
  config: 'apps/desktop/tsconfig.json', jsx: true,
  prefix: await readFile(new URL('../../application/fixtures/output-reader.tsx', import.meta.url), 'utf8'), cases: [['', null]],
}));
