import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, connected, draft, revealRecovery, customRuntime, wait } from './browser-support.mjs';

const entry = body => `load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.6.0', activate() { ${body} } } })`;
const outcome = kind => ({ kind: 'receipt', receipt: { scope: { hostId: 'test', conversationId: 'test' }, clientCommandId: 'test', hostOperationId: 'test', sequence: 1,
  state: ['rejected', 'not-dispatched', 'uncertain'].includes(kind) ? { kind, reason: 'Exact receipt reason' } : { kind } } });
const status = (page, label) => page.getByRole('status', { name: `${label} status`, exact: true });

test('nested action identity includes each parent and namespace, with one pending invocation and shared current props', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(page);
  const module = label => `({ id: 'same', label: '${label}', component(context) {
    window.contexts['${label}'] = context;
    return <p>{'${label} ' + context.conversation.conversationId}</p>;
  }, actions: [{ id: 'same', label: 'Run ${label}', run(context) {
    const previous = window.contexts['${label}'];
    if (context.conversation !== previous.conversation || context.activity !== previous.activity || context.commands !== previous.commands) throw new Error('Props diverged');
    window.calls['${label}'] = (window.calls['${label}'] || 0) + 1;
    return new Promise(resolve => { window.finish['${label}'] = resolve; });
  } }] })`;
  await customRuntime(page, host, entry(`window.contexts = {}; window.calls = {}; window.finish = {};
    return { modules: ['Left','Right'].map(label => ({ id: label, label, component() { return null; },
      children: [label === 'Left' ? ${module('Left child')} : ${module('Right child')}] })), dispose() {} };`), false,
  `, { manifest: { ...manifest, namespace: 'sibling' }, ${entry(`return { modules: [${module('Sibling')}], dispose() {} };`)} }`);
  const panel = page.getByRole('complementary', { name: 'Customization fixture' });
  await panel.getByRole('region', { name: 'Left', exact: true }).getByRole('region', { name: 'Left child', exact: true }).waitFor();
  await draft(page, 'Keep the nested action draft');
  await page.getByRole('button', { name: 'Run Left child', exact: true }).evaluate(button => { button.click(); button.click(); });
  assert.deepEqual(await page.evaluate(() => window.calls), { 'Left child': 1 });
  assert.equal(await page.getByRole('button', { name: 'Run Left child', exact: true }).isEnabled(), false);
  assert.equal(await status(page, 'Run Left child').textContent(), 'Submitting…');
  for (const label of ['Right child', 'Sibling']) await page.getByRole('button', { name: `Run ${label}`, exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.calls), { 'Left child': 1, 'Right child': 1, Sibling: 1 });
  await page.evaluate(result => window.finish['Right child'](result), { kind: 'rejected', reason: 'Only right rejected' });
  await status(page, 'Run Right child').filter({ hasText: 'Submission rejected. Only right rejected' }).waitFor();
  assert.equal(await status(page, 'Run Left child').textContent(), 'Submitting…');
  await page.evaluate(result => window.finish['Left child'](result), outcome('accepted'));
  await page.evaluate(result => window.finish.Sibling(result), outcome('completed'));
  await status(page, 'Run Left child').filter({ hasText: 'Submitted.' }).waitFor();
  await status(page, 'Run Sibling').filter({ hasText: 'Command completed.' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Keep the nested action draft');
  assert.deepEqual(await host.entries(), []);
});

test('module actions report admission, receipt and thrown outcomes without automatic replay', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(page);
  await customRuntime(page, host, entry(`window.calls = 0; return { modules: [{ id: 'outcomes', label: 'Outcomes', component() { return null; },
    actions: [{ id: 'run', label: 'Try action', async run() { window.calls++; if (window.throwAction) throw new Error('Exact thrown reason'); return window.result; } }] }], dispose() {} };`));
  await draft(page, 'Outcome draft');
  const variants = [
    [{ kind: 'rejected', reason: 'Exact admission reason' }, 'Submission rejected. Exact admission reason'],
    [outcome('rejected'), 'Submission rejected. Exact receipt reason'],
    [outcome('not-dispatched'), 'Not dispatched. Exact receipt reason'],
    [outcome('uncertain'), 'Submission uncertain. Exact receipt reason Use the conversation recovery controls before trying again.'],
    [outcome('pending'), 'Submission pending. Follow its progress in the conversation.'],
    [outcome('accepted'), 'Submitted. Follow the response in the conversation.'],
    [outcome('completed'), 'Command completed. Follow the response in the conversation.'],
  ];
  for (const [result, expected] of variants) {
    await page.evaluate(result => { window.result = result; }, result);
    await page.getByRole('button', { name: 'Try action', exact: true }).click();
    await wait(async () => await status(page, 'Try action').textContent() === expected, expected);
  }
  await page.evaluate(() => { window.throwAction = true; });
  await page.getByRole('button', { name: 'Try action', exact: true }).click();
  await status(page, 'Try action').filter({ hasText: 'Action failed. Exact thrown reason' }).waitFor();
  assert.equal(await page.evaluate(() => window.calls), variants.length + 1);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Outcome draft');
  assert.deepEqual(await host.entries(), []);
});

test('navigation captures new action context and ignores old completion while old commands remain guarded', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(page);
  await customRuntime(page, host, entry(`window.contexts = []; return { modules: [{ id: 'context', label: 'Context', component() { return null; },
    actions: [{ id: 'run', label: 'Context action', run(context) { window.contexts.push(context);
      if (window.sendNow) return context.commands.send('New conversation action');
      return new Promise(resolve => { window.finishOld = resolve; }); } }] }], dispose() {} };`));
  const first = await page.locator('.scope-label').textContent();
  await page.getByRole('button', { name: 'Context action', exact: true }).click();
  await status(page, 'Context action').filter({ hasText: 'Submitting…' }).waitFor();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await wait(async () => await page.locator('.scope-label').textContent() !== first, 'next action context');
  await connected(page);
  const second = await page.locator('.scope-label').textContent();
  await draft(page, 'New conversation draft');
  await page.evaluate(() => window.finishOld({ kind: 'rejected', reason: 'OLD CONVERSATION RESULT' }));
  const refused = await page.evaluate(async () => {
    try { await window.contexts[0].commands.send('Old captured action'); return ''; } catch (error) { return error.message; }
  });
  assert.match(refused, /Open the command’s conversation/);
  assert.equal(await status(page, 'Context action').textContent(), '');
  await page.evaluate(() => { window.sendNow = true; });
  await page.getByRole('button', { name: 'Context action', exact: true }).click();
  await status(page, 'Context action').filter({ hasText: /^(Submitted|Submission pending|Command completed)\./ }).waitFor();
  await page.locator('.message-user p').filter({ hasText: 'New conversation action' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.contexts.map(context => context.conversation.conversationId)), [first, second]);
  assert.equal((await host.entries()).length, 1);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'New conversation draft');
});

test('unavailable and disconnected conversations disable module actions and guard captured commands', { timeout: 45_000 }, async t => {
  for (const unavailable of [true, false]) {
    const host = await fixture(t), page = await host.page();
    await page.getByRole('button', { name: 'New recorded conversation' }).click();
    await connected(page);
    if (unavailable) await page.route('**/api/v1', async route => {
      if (route.request().postDataJSON().op !== 'conversation-agent') return route.continue();
      const response = await route.fetch(), body = await response.json();
      body.value.availability = { kind: 'unavailable', reason: 'Fixture unavailable' };
      await route.fulfill({ response, json: body });
    });
    await customRuntime(page, host, entry(`window.calls = 0; return { modules: [{ id: 'gated', label: 'Gated', component({ commands }) { window.captured = commands; return null; },
      actions: [{ id: 'run', label: 'Gated action', run({ commands }) { window.calls++; return commands.send('Gated command'); } }] }], dispose() {} };`));
    if (!unavailable) await host.stop();
    await wait(async () => !await page.getByRole('button', { name: 'Gated action', exact: true }).isEnabled(), 'gated custom action');
    await page.getByRole('button', { name: 'Gated action', exact: true }).evaluate(button => button.click());
    assert.equal(await page.evaluate(() => window.calls), 0);
    const reason = await page.evaluate(async () => { try { await window.captured.send('Bypass attempt'); return ''; } catch (error) { return error.message; } });
    assert.match(reason, unavailable ? /Fixture unavailable/ : /Connect the conversation/);
    assert.deepEqual(await host.entries(), []);
  }
});

test('a descendant render failure isolates its extension and restore disposes once without replacing the composer', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(page);
  const sibling = `, { manifest: { ...manifest, namespace: 'sibling' }, ${entry(`return { modules: [{ id: 'same', label: 'Healthy sibling', component() { return <p>Healthy sibling remains</p>; } }],
    dispose() { window.siblingDisposals = (window.siblingDisposals || 0) + 1; } };`)} }`;
  await customRuntime(page, host, entry(`return { modules: [{ id: 'same', label: 'Parent', component() { return <p>Parent</p>; },
    children: [{ id: 'same', label: 'Broken child', component() { throw new Error('Nested render failed'); } }] }],
    dispose() { window.disposals = (window.disposals || 0) + 1; } };`), false, sibling);
  await page.getByRole('alert').filter({ hasText: 'Nested render failed' }).waitFor();
  await page.getByText('Healthy sibling remains', { exact: true }).waitFor();
  await draft(page, 'Descendant failure draft');
  const editor = await page.getByRole('textbox', { name: 'Message', exact: true }).elementHandle();
  assert.equal(await page.evaluate(() => window.disposals), 1);
  await revealRecovery(page);
  await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  assert.equal(await page.evaluate(() => window.disposals), 1);
  assert.equal(await page.evaluate(() => window.siblingDisposals), 1);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).evaluate((node, old) => node === old, editor), true);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Descendant failure draft');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
});
