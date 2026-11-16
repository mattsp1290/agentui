import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { parseServiceRequest, parseServiceResponse } from '@agentui/contracts/service';
import { canRetryObservation } from '@agentui/contracts';
import { providerService, fixture, saved, send } from './provider-stream-fixture.mjs';
import { until } from '../host/fixture.mjs';

function disconnectable(extension) {
  const observe = extension.backend.observe, feeds = new Map();
  extension.backend.observe = (input, receive) => {
    const feed = observe(input, receive);
    feeds.set(input.binding.creation.scope.conversationId, feed);
    return feed;
  };
  return feeds;
}
const status = (f, scope, action = 'read') => f.client.providerObservation({ scope, action });
const stopped = { kind: 'stopped', reason: 'provider-disconnected' };
const document = (f, id = 'chat') => JSON.parse(saved(f, id).conversation.document);

async function waitStopped(f, scope, reason = 'provider-disconnected') {
  let observed = await status(f, scope);
  for (let attempt = 0; observed.kind !== 'stopped' && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5)); observed = await status(f, scope);
  }
  assert.deepEqual(observed, { kind: 'stopped', reason });
}

test('observation operation rejects replacement identity, unknown actions and unsafe result strings', () => {
  const scope = { hostId: 'host', conversationId: 'chat' }, request = { op: 'provider-observation', scope, action: 'retry' };
  assert.deepEqual(parseServiceRequest(request), request);
  for (const extra of [{ binding: {} }, { credential: 'secret' }, { action: 'restart' }, { scope: { ...scope, generation: 'new' } }]) {
    assert.throws(() => parseServiceRequest({ ...request, ...extra }));
  }
  for (const value of [{ kind: 'stopped', reason: 'secret error' }, { kind: 'observing', reason: 'secret' }, { kind: 'stopped' }]) {
    assert.throws(() => parseServiceResponse(request, { ok: true, value }));
  }
  assert.equal(canRetryObservation(stopped), true);
  assert.equal(canRetryObservation({ kind: 'stopped', reason: 'cleanup-failed' }), false);
});

test('paused provider keeps its healthy journal and later receipt while other chats update; explicit retry only reads the original binding', { timeout: 20_000 }, async t => {
  const remote = await providerService(t), a = remote.extension(), feeds = disconnectable(a);
  const f = await fixture(t, [a]), scope = await f.create(), other = await f.create('other');
  await until(() => a.calls.ready === 2);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  remote.command(async operation => { entered.resolve(); await release.promise; return { kind: 'confirmed', value: {
    kind: 'send', state: 'accepted', run: remote.ref(operation.binding, 'run', 'same-run') }, evidence: null }; });
  const items = [], watch = f.client.conversation(scope).watch({ after: null, projectionVersion: 2 }, async item => { items.push(item); });
  t.after(() => watch.close());
  let journalEnded = false; void watch.ended.then(() => { journalEnded = true; });
  await until(() => items.length === 1);
  const submitting = f.client.conversation(scope).submit(send(scope)); await entered.promise;
  const binding = remote.conversations.get('chat').snapshot.binding;
  remote.emit(remote.makeEvent(binding, 'Partial answer', 1)); await until(() => document(f).domain.messages.at(-1)?.text === 'Partial answer');
  feeds.get('chat').close(); await waitStopped(f, scope);
  const before = saved(f), requests = remote.requests.length;
  for (let i = 0; i < 4; i++) assert.deepEqual(await status(f, scope), stopped);
  assert.equal(remote.requests.length, requests); assert.deepEqual(saved(f), before); assert.equal(a.calls.connected.length, 1);
  release.resolve(); assert.equal((await submitting).receipt.state.kind, 'accepted');
  await until(() => items.some(item => item.kind === 'events' && item.events.some(envelope => envelope.event.kind === 'receipt' && envelope.event.receipt.state.kind === 'accepted')));
  assert.equal(journalEnded, false); assert.deepEqual(document(f).domain, JSON.parse(before.conversation.document).domain);
  const otherBinding = remote.conversations.get('other').snapshot.binding;
  remote.emit(remote.makeEvent(otherBinding, 'Other chat is live', 1)); await until(() => document(f, 'other').domain.messages.at(-1)?.text === 'Other chat is live');
  assert.deepEqual(await status(f, other), { kind: 'observing' });
  const commandRows = saved(f).commands, run = document(f).domain.currentRun, startingRequests = remote.requests.length;
  remote.emit(remote.makeEvent(binding, 'Fresh snapshot answer', 2));
  const originalCredential = structuredClone(a.calls.connected[0].credential);
  const gate = Promise.withResolvers(), snapshotEntered = Promise.withResolvers(), snapshot = a.backend.snapshot;
  a.backend.snapshot = async selected => { snapshotEntered.resolve(); await gate.promise; return snapshot(selected); };
  const retry = status(f, scope, 'retry'); await snapshotEntered.promise;
  const joined = status(f, scope, 'retry'); assert.deepEqual(await status(f, scope), { kind: 'recovering' });
  gate.resolve(); assert.deepEqual(await retry, { kind: 'observing' }); assert.deepEqual(await joined, { kind: 'observing' });
  await until(() => a.calls.ready === 3);
  assert.equal(a.calls.observe.length, 3); assert.equal(a.calls.connected.length, 1); assert.deepEqual(a.calls.connected[0].credential, originalCredential);
  assert.deepEqual(a.calls.observe.at(-1), { binding, after: remote.conversations.get('chat').snapshot.cursor });
  assert.deepEqual(remote.requests.slice(startingRequests).map(value => value.path), ['/snapshot', '/observe']);
  assert.deepEqual(saved(f).commands, commandRows); assert.deepEqual(document(f).domain.currentRun, run);
  assert.equal(document(f).domain.messages.at(-1).text, 'Fresh snapshot answer');
  const liveRequests = remote.requests.length; await status(f, scope, 'retry'); assert.equal(remote.requests.length, liveRequests);
  remote.emit(remote.makeEvent(binding, 'Updates resumed', 3)); await until(() => document(f).domain.messages.at(-1).text === 'Updates resumed');
  assert.equal(journalEnded, false);
  await assert.rejects(status(f, { ...scope, hostId: 'foreign' }), error => error.kind === 'forbidden');
});

test('Stop reaches the provider while an explicit retry snapshot is still pending', { timeout: 15_000 }, async t => {
  const remote = await providerService(t, { native: true }), a = remote.extension({ controls: true });
  const f = await fixture(t, [a]), scope = await f.create();
  await until(() => a.calls.ready === 1);
  const binding = remote.conversations.get('chat').snapshot.binding;
  remote.emit(remote.makeEvent(binding, 'Still running', 1));
  await until(() => document(f).domain.currentRun?.kind === 'running');
  a.calls.disconnect(); await waitStopped(f, scope);
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(), snapshot = a.backend.snapshot;
  a.backend.snapshot = async selected => { entered.resolve(); await gate.promise; return snapshot(selected); };
  const retry = status(f, scope, 'retry');
  await entered.promise;
  try {
    remote.command(operation => {
      assert.equal(operation.kind, 'cancel'); assert.deepEqual(operation.binding, binding);
      return { kind: 'confirmed', value: { kind: 'cancel', state: 'accepted' }, evidence: null };
    });
    const command = { version: 1, scope, clientCommandId: 'stop-during-retry',
      body: { kind: 'cancel', runId: document(f).domain.currentRun.runId } };
    const submitting = f.client.conversation(scope).submit(command);
    await until(() => remote.requests.some(request => request.path === '/submit' && request.input.kind === 'cancel'));
    const accepted = await submitting;
    assert.equal(accepted.receipt.state.kind, 'accepted');
    assert.deepEqual(await f.client.conversation(scope).submit(command), accepted);
    assert.deepEqual(await status(f, scope), { kind: 'recovering' });
    assert.equal(a.calls.observe.length, 1);
    assert.equal(remote.requests.filter(request => request.path === '/snapshot').length, 1);
    assert.equal(remote.requests.filter(request => request.path === '/submit').length, 1);
  } finally { gate.resolve(); await retry; }
  await until(() => a.calls.ready === 2);
  assert.equal(remote.requests.filter(request => request.path === '/snapshot').length, 2);
});

for (const [ending, reason, retryable] of [
  ['unsupported', 'unsupported', false], ['version-unsupported', 'unsupported', false],
  ['authentication-failed', 'original-credentials-unavailable', false], ['unauthorized', 'original-credentials-unavailable', false],
  ['closed', 'provider-disconnected', true], ['disconnected', 'provider-disconnected', true], ['unavailable', 'provider-disconnected', true],
]) test(`provider feed ending ${ending} retains its safe reason and retry policy`, async t => {
  const remote = await providerService(t), a = remote.extension();
  let observations = 0;
  a.backend.observe = () => {
    observations++;
    return { close() {}, ended: Promise.resolve({ kind: ending, cursor: null, reason: 'SECRET_RAW_PROVIDER_ERROR' }) };
  };
  const f = await fixture(t, [a]), scope = await f.create();
  await waitStopped(f, scope, reason);
  const result = await status(f, scope), before = saved(f), requests = remote.requests.length;
  assert.equal(canRetryObservation(result), retryable);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  if (!retryable) assert.deepEqual(await status(f, scope, 'retry'), result);
  assert.equal(observations, 1); assert.equal(remote.requests.length, requests);
  assert.deepEqual(saved(f), before);
});

for (const [failure, reason] of [
  ['unsupported', 'unsupported'], ['version-unsupported', 'unsupported'],
  ['authentication-failed', 'original-credentials-unavailable'], ['unauthorized', 'original-credentials-unavailable'],
  ['unavailable', 'snapshot-unavailable'], ['throws', 'snapshot-unavailable'], ['invalid', 'invalid-projection'],
]) {
  test(`manual retry reports ${failure} safely and preserves every saved row`, async t => {
    const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]), scope = await f.create();
    await until(() => a.calls.ready === 1); a.calls.disconnect(); await waitStopped(f, scope);
    const before = saved(f);
    a.backend.snapshot = async () => {
      if (failure === 'throws') throw new Error('SECRET_RAW_PROVIDER_ERROR');
      if (failure === 'invalid') return { kind: 'available', snapshot: { secret: 'SECRET_RAW_PROVIDER_ERROR' } };
      return { kind: failure, reason: 'SECRET_RAW_PROVIDER_ERROR' };
    };
    const result = await status(f, scope, 'retry');
    assert.deepEqual(result, { kind: 'stopped', reason }); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    assert.equal(canRetryObservation(result), !['unsupported', 'original-credentials-unavailable'].includes(reason));
    assert.deepEqual(saved(f), before); assert.equal(a.calls.observe.length, 1);
    assert.deepEqual(await status(f, scope), result);
  });
}

test('fresh retry validates the old checkpoint before requesting a replacement snapshot', async t => {
  const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]), scope = await f.create();
  await until(() => a.calls.ready === 1); a.calls.disconnect(); await waitStopped(f, scope);
  a.presentation.decodeState = value => ({ ...value, injected: null });
  const before = saved(f), requests = remote.requests.length;
  assert.deepEqual(await status(f, scope, 'retry'), { kind: 'stopped', reason: 'invalid-projection' });
  assert.equal(remote.requests.length, requests); assert.deepEqual(saved(f), before);
});

for (const [change, reason] of [[{ generation: 'replacement' }, 'original-provider-unavailable'], [{ revision: 'replacement' }, 'original-credentials-unavailable']]) {
  test(`${reason} requires the original configuration and does not retarget on retry`, async t => {
    const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]), scope = await f.create();
    await until(() => a.calls.ready === 1);
    const before = saved(f), b = remote.extension(change); await f.restart([b]);
    assert.deepEqual(await status(f, scope), { kind: 'stopped', reason });
    const requests = remote.requests.length;
    assert.deepEqual(await status(f, scope, 'retry'), { kind: 'stopped', reason });
    assert.equal(remote.requests.length, requests); assert.deepEqual(saved(f), before);
  });
}

test('browser preserves draft, Stop authority and raw running state while Check for updates restores same-chat updates', { timeout: 30_000 }, async t => {
  const remote = await providerService(t, { native: true }), a = remote.extension({ controls: true }), feeds = disconnectable(a);
  const f = await fixture(t, [a]); await f.create(); await f.create('other');
  await until(() => a.calls.ready === 2);
  const binding = remote.conversations.get('chat').snapshot.binding;
  remote.emit(remote.makeEvent(binding, 'Readable partial reply', 1)); await until(() => document(f).domain.messages.length === 2);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext(), [name, value] = f.cookie.split('=');
  await context.addCookies([{ name, value, url: f.running.origin }]);
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  await page.goto(`${f.running.origin}/browser.html`);
  await page.getByRole('button', { name: /Open conversation chat$/ }).click();
  await page.getByText('Readable partial reply', { exact: true }).waitFor();
  const draft = page.getByRole('textbox', { name: 'Message', exact: true }); await draft.fill('Keep this unsent draft');
  const before = saved(f), run = document(f).domain.currentRun;
  feeds.get('chat').close();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).isEnabled(), true);
  assert.equal(await draft.inputValue(), 'Keep this unsent draft');
  assert.equal(await page.locator('.progress-label').textContent(), 'Updates paused');
  assert.deepEqual(saved(f), before);
  await page.screenshot({ path: '.audit/mvp/observation-status-paused-browser.png', fullPage: true });
  await page.getByRole('button', { name: /Open conversation other$/ }).click();
  remote.emit(remote.makeEvent(remote.conversations.get('other').snapshot.binding, 'Other chat remains usable', 1));
  await page.getByText('Other chat remains usable', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Check for updates', exact: true }).count(), 0);
  await page.getByRole('button', { name: /Open conversation chat$/ }).click();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).waitFor();
  assert.equal(await draft.inputValue(), 'Keep this unsent draft');
  const requestStart = remote.requests.length;
  remote.emit(remote.makeEvent(binding, 'Fresh visible snapshot', 2));
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await page.getByText('Fresh visible snapshot', { exact: true }).waitFor();
  assert.equal(await draft.inputValue(), 'Keep this unsent draft'); assert.deepEqual(document(f).domain.currentRun, run);
  await until(() => a.calls.ready === 3);
  remote.emit(remote.makeEvent(binding, 'Visible updates resumed', 3)); await page.getByText('Visible updates resumed', { exact: true }).waitFor();
  assert.deepEqual(remote.requests.slice(requestStart).map(value => value.path), ['/snapshot', '/observe']);
  assert.equal(await page.getByRole('button', { name: 'Check for updates', exact: true }).count(), 0);
  await page.screenshot({ path: '.audit/mvp/observation-status-browser.png', fullPage: true });
  remote.emit(remote.makeEvent(binding, 'Known complete', 4, true)); await page.getByText('Known complete', { exact: true }).waitFor();
  const completed = document(f).domain.currentRun; feeds.get('chat').close();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('.observation-notice').textContent(), /may still be running|run state is unknown/);
  assert.deepEqual(document(f).domain.currentRun, completed);
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
});


test('native and missing-binding status reads have no provider side effects', async t => {
  const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]);
  const native = f.scope('native'), missing = f.scope('missing');
  await f.client.create(native, (await f.client.metadata()).defaultAgentId);
  const before = remote.requests.length;
  for (const action of ['read', 'retry']) {
    assert.deepEqual(await status(f, native, action), { kind: 'not-applicable' });
    assert.deepEqual(await status(f, missing, action), { kind: 'stopped', reason: 'original-binding-unavailable' });
  }
  assert.equal(remote.requests.length, before); assert.equal(a.calls.observe.length, 0);
});
