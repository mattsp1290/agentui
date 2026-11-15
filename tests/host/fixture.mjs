import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalHost, createRecordedDriver } from '@agentui/host';

export const scope = { hostId: 'host-a', conversationId: 'conversation-a' };
export const other = { hostId: 'host-a', conversationId: 'conversation-b' };
export const installed = { installationId: 'recorded-installation', binding: {
  engine: 'recorded-not-a-native-provider', nativeVersion: '1', account: 'fixture',
  authorizedScope: 'fixture-only', nativeFormat: 'recorded-v1',
} };
export const projection = {
  version: 1,
  initial: () => [],
  decodeState(value) {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Invalid notes');
    return value;
  },
  decodeEvent(value) {
    if (!value || value.kind !== 'note-added' || typeof value.text !== 'string') throw new Error('Invalid note event');
    return { kind: 'note-added', text: value.text };
  },
  apply(state, event) {
    if (event.text === 'projector-failure') throw new Error('Projector failed');
    return [...state, event.text];
  },
};
export const empty = () => ({ events: [], runs: [], decisions: [] });
export const note = text => ({ ...empty(), events: [{ kind: 'note-added', text }] });
export const completed = output => ({ kind: 'completed', output });
export const command = (id, body = { kind: 'send', text: 'hello' }, conversation = scope) =>
  ({ version: 1, scope: conversation, clientCommandId: id, body });
export function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentui-host-'));
  const path = join(dir, 'host.sqlite'), backendPath = join(dir, 'recorded.jsonl');
  const driver = createRecordedDriver({ installation: installed, backendPath, decodeEvent: projection.decodeEvent, resolve: async cmd => completed(note(cmd.body.kind)), ...overrides });
  const hosts = [];
  const open = options => {
    const host = openLocalHost({ path, projection, driver, authorize: () => true, ...options });
    hosts.push(host);
    return host;
  };
  t.after(() => { for (const host of hosts) host.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path, backendPath, driver, open };
}
export function run(conversation = scope, runId = 'run-a') {
  return { identity: { conversation, runId, authority: { kind: 'agentui-host', hostId: conversation.hostId,
    binding: { namespace: 'recorded', installationId: installed.installationId, opaqueSessionId: 'private-session-secret' } } },
  reference: { kind: 'session', formatVersion: 1, binding: installed.binding, opaque: 'private-session-secret' } };
}
export function question(pendingId = 'question-a') {
  return { visible: { pendingId, runId: 'run-a', choices: ['yes', 'no'], prompt: 'Continue?' }, continuation: { secret: 'private-continuation' } };
}
export async function snapshot(port, projectionVersion = 1) {
  let resolve;
  const got = new Promise(done => { resolve = done; });
  const feed = port.watch({ after: null, projectionVersion }, async item => { resolve(item.snapshot); });
  const result = await got;
  feed.close();
  await feed.ended;
  return result;
}
export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
export async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
