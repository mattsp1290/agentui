import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { acknowledgement, crewService } from './support/crew-service.mjs';
import { fixture, saved } from '../../../tests/application/provider-stream-fixture.mjs';
import { draft } from '../../../tests/application/browser-support.mjs';
import { until } from '../../../tests/host/fixture.mjs';

const memberId = randomUUID();
const instance = { namespace: 'crew', installationId: 'test', generation: 'one', protocolVersion: '1' };
const service = t => crewService(t, { memberId, token: 'private-crew-test', instance });
const BEFORE_CONTINUE = 'Starts a new provider conversation with the same agent. The provider sends it the newest complete turns, up to 64 KiB. '
  + 'Older turns and turns with an unknown outcome are left out. Nothing you sent is resent. Tools, approvals and pending work do not carry over.';
const NEW_CHAT_NOTE = 'Nothing from this chat is sent. Add any context yourself.';
const UNCONFIRMED = 'Continue is not confirmed. Checking again cannot start a second conversation.';

const say = (scope, text) => ({ version: 1, scope, clientCommandId: randomUUID(), body: { kind: 'send', text } });
const crewId = (f, id) => f.inspect(db => JSON.parse(db.prepare('SELECT original FROM provider_creations WHERE conversation=?').get(id).original).intent.operationId);
const closure = (f, id) => JSON.parse(saved(f, id).checkpoint.data).state.closure;
const domain = (f, id) => JSON.parse(saved(f, id).conversation.document).domain;
const handoffPosts = remote => remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/handoffs'));
const attempts = (f, id) => f.inspect(db => db.prepare(`SELECT conversation FROM provider_creations
  WHERE json_extract(original,'$.intent.from.scope.conversationId')=? ORDER BY rowid`).all(id).map(row => row.conversation));
const kib = bytes => String(Math.ceil(bytes * 10 / 1024) / 10);

/** Creates a chat, sends `text`, lets Crew finish the turn, then ends the Crew conversation in `phase`. */
async function closedChat(f, remote, id, text, phase = 'cancelled') {
  const scope = await f.create(id), crew = crewId(f, id);
  await until(() => [...remote.streams].some(stream => stream.conversationId === crew), 5000);
  assert.equal((await f.client.conversation(scope).submit(say(scope, text))).receipt.state.kind, 'accepted');
  await until(() => domain(f, id).currentRun?.kind === 'running', 5000);
  remote.reply(crew, `Reply to ${text}`);
  await until(() => domain(f, id).currentRun?.kind === 'ended', 5000);
  remote.end(crew, phase);
  await until(() => closure(f, id) !== undefined, 5000);
  return scope;
}
async function browserPage(f, browser) {
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(5000);
  await page.goto(`${f.running.origin}/browser.html`);
  return page;
}
const openChat = (page, text, scope) => page.getByRole('button', { name: `${text} · Open conversation ${scope.conversationId}`, exact: true }).click();
const notice = (page, cause = 'it was stopped') => page.getByRole('status').filter({ hasText: `This conversation ended: ${cause}.` });
const showing = (page, conversationId, timeout = 10_000) =>
  page.waitForFunction(id => document.querySelector('.scope-label')?.textContent === id, conversationId, { timeout });
const buttons = locator => locator.getByRole('button').allTextContents();
const composerFocused = page => page.waitForFunction(() => document.activeElement?.id === 'message');
const announced = (page, text) => page.waitForFunction(value => document.getElementById('continuation-status')?.textContent === value, text);

test('browser stops a Crew chat, continues it on one click, shows the boundary counts, moves the draft and loads the earlier segment', { timeout: 40_000 }, async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]);
  const scope = await f.create('chat'), crew = crewId(f, 'chat');
  await until(() => [...remote.streams].some(stream => stream.conversationId === crew), 5000);
  await f.client.conversation(scope).submit(say(scope, 'Plan the balcony garden'));
  await until(() => domain(f, 'chat').messages.length > 0 && domain(f, 'chat').currentRun?.kind === 'running', 5000);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browserPage(f, browser);
  await openChat(page, 'Plan the balcony garden', scope);
  await page.getByRole('status').filter({ hasText: 'Conversation connected' }).first().waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await until(() => remote.calls.some(call => call.path.endsWith('/cancel')), 5000);
  remote.end(crew, 'cancelled');
  const closed = notice(page);
  await closed.waitFor();
  await closed.getByText(BEFORE_CONTINUE, { exact: true }).waitFor();
  await closed.getByText(NEW_CHAT_NOTE, { exact: true }).waitFor();
  assert.deepEqual(await buttons(closed), ['Continue', 'Start a new chat']);
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(handoffPosts(remote).length, 0);
  await draft(page, 'Ask about watering next');
  const requests = [];
  page.on('request', request => { if (request.url().endsWith('/api/v1')) requests.push(request.postDataJSON()); });
  await closed.getByRole('button', { name: 'Continue', exact: true }).click();
  await until(() => attempts(f, 'chat').length === 1, 5000);
  const [after] = attempts(f, 'chat');
  await showing(page, after);
  await composerFocused(page);
  const [row] = remote.handoffs;
  assert.deepEqual([row.carriedTurns, row.omittedTurns, row.uncertainTurns], [1, 1, 0]);
  const boundary = page.getByRole('note').filter({ hasText: 'Continued in a new provider conversation' });
  const boundaryText = 'Continued in a new provider conversation because the earlier one was stopped. '
    + `Carried the newest 1 completed turn (${kib(row.transcriptBytes)} KiB of 64 KiB). 1 older turn left out. `
    + 'Tools, approvals and the agent’s memory did not carry over. The first reply acknowledges the carried turns.';
  assert.equal(await boundary.textContent(), boundaryText);
  await announced(page, boundaryText);
  await page.getByText(acknowledgement, { exact: true }).waitFor();
  assert.equal(await page.getByText('BirbCrew conversation handoff v1').count(), 0);
  await page.waitForFunction(() => document.querySelector('textarea#message')?.value === 'Ask about watering next');
  assert.equal(await page.getByText('This conversation ended').count(), 0);
  assert.equal(handoffPosts(remote).length, 1);
  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/requests')).length, 1);
  assert.deepEqual(requests.filter(body => body?.op === 'continuation' && body.action !== 'read').map(body => body.action), ['start']);
  assert.equal(domain(f, after).messages.some(message => message.role === 'user'), false);

  await page.getByRole('button', { name: 'Show earlier messages', exact: true }).click();
  const earlier = page.getByRole('region', { name: 'Earlier messages', exact: true });
  await earlier.getByText('Plan the balcony garden', { exact: true }).waitFor();
  assert.equal(await page.locator('.conversation-content').getByRole('region', { name: 'Earlier messages', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Show earlier messages', exact: true }).count(), 0);
  assert(requests.some(body => body?.op === 'watch' && body.scope.conversationId === 'chat'));

  // A live successor's own status shows; the earlier segment's kept closure never masks it.
  await page.route('**/api/v1', route => {
    const body = route.request().postDataJSON();
    if (body?.op !== 'provider-observation' || body.scope.conversationId !== after) return route.continue();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value: { kind: 'stopped', reason: 'provider-disconnected' } }) });
  });
  await page.getByRole('button', { name: 'Check for updates', exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(await page.getByText('This conversation ended').count(), 0);
  await page.unroute('**/api/v1');
  await page.reload();
  await showing(page, after);
  await page.getByRole('note').filter({ hasText: 'Continued in a new provider conversation' }).waitFor();
  assert.equal(handoffPosts(remote).length, 1);
});

test('two pages that both choose Continue converge on one successor with one handoff POST', { timeout: 40_000 }, async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]);
  const scope = await closedChat(f, remote, 'chat', 'Converge on one chat');
  const browser = await chromium.launch(); t.after(() => browser.close());
  const pages = [await browserPage(f, browser), await browserPage(f, browser)];
  for (const page of pages) { await openChat(page, 'Converge on one chat', scope); await notice(page).waitFor(); }
  const release = remote.holdHandoffs();
  for (const page of pages) await notice(page).getByRole('button', { name: 'Continue', exact: true }).click();
  for (const page of pages) await notice(page).getByText('Continuing…', { exact: true }).waitFor();
  for (const page of pages) await announced(page, 'Continuing…');
  await until(() => handoffPosts(remote).length === 1, 5000);
  release();
  await until(() => attempts(f, 'chat').length === 1, 5000);
  const [after] = attempts(f, 'chat');
  for (const page of pages) await showing(page, after);
  assert.equal(handoffPosts(remote).length, 1);
  assert.equal(remote.handoffs.length, 1);
});

test('a reload while the handoff POST is held shows Continuing… and never posts again', { timeout: 40_000 }, async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]);
  const scope = await closedChat(f, remote, 'chat', 'Hold the handoff');
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browserPage(f, browser);
  await openChat(page, 'Hold the handoff', scope);
  const release = remote.holdHandoffs();
  await notice(page).getByRole('button', { name: 'Continue', exact: true }).click();
  await notice(page).getByText('Continuing…', { exact: true }).waitFor();
  await until(() => handoffPosts(remote).length === 1, 5000);
  const starts = [];
  page.on('request', request => {
    const body = request.url().endsWith('/api/v1') ? request.postDataJSON() : null;
    if (body?.op === 'continuation' && body.action !== 'read') starts.push(body.action);
  });
  await page.reload();
  await notice(page).getByText('Continuing…', { exact: true }).waitFor();
  assert.equal(await notice(page).getByRole('button', { name: 'Continue', exact: true }).count(), 0);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(handoffPosts(remote).length, 1);
  release();
  await until(() => attempts(f, 'chat').length === 1, 5000);
  await showing(page, attempts(f, 'chat')[0]);
  assert.deepEqual(starts, []);
  assert.equal(handoffPosts(remote).length, 1);
});

test('each Crew refusal shows its own text and buttons; Try again and Start a new chat behave as named', { timeout: 60_000 }, async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]);
  const cases = [
    ['busy', { status: 409, code: 'busy' }, 'The provider is still finishing work here.', ['Try again']],
    ['limit', { status: 409, code: 'usage_limit' }, 'The agent is over a provider limit.', ['Try again', 'Start a new chat']],
    ['unavailable', { status: 409, code: 'handoff_too_large' }, 'The provider could not carry context.', ['Start a new chat']],
    ['elsewhere', { status: 409, code: 'handed_off' }, 'This conversation was continued outside AgentUI.', ['Start a new chat']],
  ];
  const scopes = {};
  for (const [id] of cases) scopes[id] = await closedChat(f, remote, id, `Refused as ${id}`);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browserPage(f, browser);
  for (const [id, reply, text, expected] of cases) {
    remote.replyHandoffs(reply);
    await openChat(page, `Refused as ${id}`, scopes[id]);
    await notice(page).getByRole('button', { name: 'Continue', exact: true }).click();
    await notice(page).getByText(text, { exact: true }).waitFor();
    await announced(page, text);
    assert.deepEqual(await buttons(notice(page)), expected, id);
    assert.equal(await notice(page).getByText(NEW_CHAT_NOTE, { exact: true }).count(), expected.includes('Start a new chat') ? 1 : 0, id);
  }
  assert.equal(handoffPosts(remote).length, 4);

  // Start a new chat makes an unrelated chat through the ordinary create flow and carries only the draft.
  await openChat(page, 'Refused as unavailable', scopes.unavailable);
  await notice(page).getByText('The provider could not carry context.', { exact: true }).waitFor();
  await draft(page, 'Context I add myself');
  const creations = remote.calls.filter(call => call.method === 'POST' && call.path === '/v1/conversations').length;
  const known = new Set(f.inspect(db => db.prepare('SELECT conversation FROM provider_creations').all().map(row => row.conversation)));
  await notice(page).getByRole('button', { name: 'Start a new chat', exact: true }).click();
  await until(() => f.inspect(db => db.prepare('SELECT conversation FROM provider_creations').all()).length === known.size + 1, 5000);
  const fresh = f.inspect(db => db.prepare('SELECT conversation, original FROM provider_creations').all()).find(row => !known.has(row.conversation));
  assert.equal(JSON.parse(fresh.original).intent.from, undefined);
  await showing(page, fresh.conversation);
  await composerFocused(page);
  await page.waitForFunction(() => document.querySelector('textarea#message')?.value === 'Context I add myself');
  assert.equal(await page.getByRole('note').filter({ hasText: 'Continued in a new provider conversation' }).count(), 0);
  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path === '/v1/conversations').length, creations + 1);
  assert.equal(handoffPosts(remote).length, 4);
  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/requests')).length, cases.length);

  await openChat(page, 'Refused as busy', scopes.busy);
  await notice(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await until(() => attempts(f, 'busy').length === 2, 5000);
  await showing(page, attempts(f, 'busy')[1]);
  assert.equal(handoffPosts(remote).length, 5);
});

test('an uncertain handoff is only looked up by Check again and a reload; Try again posts a new attempt that settles on the first', { timeout: 40_000 }, async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]);
  const scope = await closedChat(f, remote, 'chat', 'Lose the handoff reply');
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browserPage(f, browser);
  await openChat(page, 'Lose the handoff reply', scope);
  remote.replyHandoffs('lost');
  await notice(page).getByRole('button', { name: 'Continue', exact: true }).click();
  await notice(page).getByText(UNCONFIRMED, { exact: true }).waitFor();
  assert.deepEqual(await buttons(notice(page)), ['Check again', 'Try again']);
  remote.failHandoffLookups(1);
  await notice(page).getByRole('button', { name: 'Check again', exact: true }).click();
  await until(() => remote.calls.some(call => call.method === 'GET' && call.path.endsWith('/handoff')), 5000);
  await notice(page).getByRole('button', { name: 'Check again', exact: true }).and(page.locator(':enabled')).waitFor();
  await notice(page).getByText(UNCONFIRMED, { exact: true }).waitFor();
  await page.reload();
  await openChat(page, 'Lose the handoff reply', scope);
  await notice(page).getByText(UNCONFIRMED, { exact: true }).waitFor();
  assert.equal(handoffPosts(remote).length, 1);
  remote.failHandoffLookups(1);
  await notice(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await until(() => attempts(f, 'chat').length === 2, 5000);
  const [first] = attempts(f, 'chat');
  await showing(page, first);
  const posts = handoffPosts(remote).map(call => call.input.requestId);
  assert.equal(posts.length, 2);
  assert.equal(new Set(posts).size, 2);
  assert.deepEqual(posts, attempts(f, 'chat').map(id => crewId(f, id)));
});

test('search finds text from an earlier segment and opens the newest segment of its chain', { timeout: 40_000 }, async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]);
  const scope = await closedChat(f, remote, 'chat', 'Trellis for the tomatoes');
  const started = await f.client.continuation({ scope, action: 'start' });
  assert.equal(started.successor.kind, 'confirmed');
  const after = started.successor.scope;
  assert.deepEqual((await f.client.catalog()).map(entry => entry.scope), [after]);
  assert.deepEqual((await f.client.search('trellis')).items.map(entry => entry.scope), [scope]);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browserPage(f, browser);
  await page.getByRole('combobox', { name: 'Search chats', exact: true }).fill('trellis');
  await page.getByRole('option', { name: /Trellis for the tomatoes/ }).click();
  await showing(page, after.conversationId);
  await page.getByRole('note').filter({ hasText: 'Continued in a new provider conversation because the earlier one was stopped.' }).waitFor();
  assert.equal(handoffPosts(remote).length, 1);
});
