import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forwardRef, lazy, memo } from 'react';
import { parseUiExtensionContributions } from '@agentui/sdk/react';
import { assertCompileCases } from '../../support/compile.mjs';

test('activity captures both known getters once and preserves component identity', async () => {
  for (const component of [() => null, memo(() => null), forwardRef(() => null), lazy(async () => ({ default: () => null }))]) {
    let transcriptReads = 0, activityReads = 0, disposals = 0;
    class Overrides {
      get transcript() { transcriptReads++; return component; }
      get activity() { activityReads++; return component; }
    }
    const result = parseUiExtensionContributions({ modules: [], overrides: new Overrides(), dispose() { disposals++; } });
    assert.equal(result.kind, 'ready');
    assert.equal(result.presentation.activity, component);
    assert.equal(result.presentation.transcript, component);
    assert.equal(activityReads, 1); assert.equal(transcriptReads, 1);
    await result.dispose(); await result.dispose();
    assert.equal(disposals, 1);
  }
});

test('activity rejects unknown keys before reading known or unknown getters and retains disposal', async () => {
  for (const key of ['composer', Symbol('unknown')]) {
    let reads = 0, disposals = 0;
    const overrides = Object.create({ get [key]() { reads++; throw new Error('Unknown getter read'); } });
    Object.defineProperties(overrides, {
      transcript: { get() { reads++; return () => null; } },
      activity: { get() { reads++; return () => null; } },
    });
    const result = parseUiExtensionContributions({ modules: [], overrides, dispose() { disposals++; } });
    assert.equal(result.kind, 'invalid-presentation');
    assert.match(result.error.message, /Unknown override slot/);
    assert.equal(reads, 0);
    await result.dispose(); assert.equal(disposals, 1);
  }
  for (const activity of [null, 'div', {}, 4]) {
    const result = parseUiExtensionContributions({ modules: [], overrides: { activity }, dispose() {} });
    assert.equal(result.kind, 'invalid-presentation');
  }
  let reads = 0, disposals = 0;
  const result = parseUiExtensionContributions({ modules: [], overrides: { get activity() { reads++; throw new Error('Activity capture failed'); } }, dispose() { disposals++; } });
  assert.equal(result.kind, 'invalid-presentation');
  assert.equal(reads, 1);
  await result.dispose(); assert.equal(disposals, 1);
});

test('activity authors get readonly updates and the existing module context', () => assertCompileCases({
  config: 'apps/desktop/tsconfig.json',
  prefix: `
import { createElement, memo } from 'react';
import type { ConversationActivityProps, ConversationModuleProps, UiExtensionContributions } from '@agentui/sdk/react';
export const activity = ({ updates, activity, commands }: ConversationActivityProps) => createElement('button', { onClick: () => commands.cancel.run('run') }, updates, activity.domain.activities?.length ?? 0);
export const contribution: UiExtensionContributions = { modules: [], overrides: { activity: memo(activity) }, dispose() {} };
export const ignoresUpdates: UiExtensionContributions = { modules: [], overrides: { activity: (_props: ConversationModuleProps) => null }, dispose() {} };
`,
  cases: [
    ['', null],
    ["export function bad(props: ConversationActivityProps) { props.updates = 'paused'; }", /read-only/u],
    ["export const bad: ConversationActivityProps['updates'] = 'working';", /not assignable/u],
    ["export const bad: UiExtensionContributions = { modules: [], overrides: { activity: (_props: { wrong: string }) => null }, dispose() {} };", /not assignable/u],
  ],
}));
