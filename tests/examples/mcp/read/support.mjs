import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRecordedDriver, openLocalHost } from '@agentui/host';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { EXTENSION_SDK_VERSION, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
import { Access } from '../../../../apps/host/build/tsc/access.js';
import { openAccessDatabase } from '../../../../apps/host/build/tsc/access-database.js';
import { createApi } from '../../../../apps/host/build/tsc/api.js';
import { FeedRegistry } from '../../../../apps/host/build/tsc/feed-registry.js';
import { serviceEndpoint } from '../../../../apps/host/build/tsc/service-endpoint.js';
import { NO_OBSERVABILITY } from '../../../../apps/host/build/tsc/observability.js';
import { installed as originalInstalled, run, question } from '../../../host/fixture.mjs';

const installed = { ...originalInstalled, binding: { ...originalInstalled.binding, engine: RECORDED_RUNTIME.engine, nativeVersion: RECORDED_RUNTIME.version, nativeFormat: RECORDED_RUNTIME.format } };
export const main = fileURLToPath(new URL('../../../../examples/mcp-control/read/dist/main.js', import.meta.url));
export const compatibility = { wireVersion: 1, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: RECORDED_RUNTIME,
  desiredGitRevision: 'test', appliedArtifact: { artifactId: 'test', gitRevision: 'test' } };
export const tools = ['agentui_agents', 'agentui_conversations', 'agentui_inspect', 'agentui_receipt'];
export const empty = () => ({ events: [], runs: [], decisions: [] });
export const privateDirectory = t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-mcp-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
export async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
export function cli(args, input = '') {
  const child = spawn(process.execPath, [main, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}
export async function connect(t, path) {
  const client = new Client({ name: 'agentui-read-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [main, 'serve', path], stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', data => { stderr += data; });
  t.after(() => client.close());
  await client.connect(transport);
  return { client, get stderr() { return stderr; } };
}
export function data(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}
export function writeProfile(directory, value, name = 'profile.json') {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}
export async function fixture(t) {
  let releasePending, enteredPending, pendingSubmission;
  const pendingGate = new Promise(resolve => { releasePending = resolve; });
  const pendingEntered = new Promise(resolve => { enteredPending = resolve; });
  t.after(async () => { releasePending(); await pendingSubmission; });
  const directory = privateDirectory(t), database = join(directory, 'host.sqlite'), backendPath = join(directory, 'recorded.jsonl');
  const access = new Access(openAccessDatabase(database));
  const scope = { hostId: access.hostId, conversationId: 'conversation-a' };
  const counts = { dispatch: 0, lookup: 0 };
  const recorded = createRecordedDriver({ installation: installed, backendPath, cancel: { kind: 'supported' }, decodeEvent: transcriptProjection.decodeEvent,
    resolve: async command => command.clientCommandId === 'accepted-original' ? 'accepted' : { kind: 'completed', output: empty() } });
  const driver = { ...recorded,
    async dispatch(command, target) {
      counts.dispatch++;
      if (command.clientCommandId === 'pending-original') { enteredPending(); await pendingGate; }
      const result = await recorded.dispatch(command, target);
      return command.clientCommandId === 'uncertain-original' ? { kind: 'outcome-unknown' } : result;
    },
    async lookup(command, target) { counts.lookup++; return recorded.lookup(command, target); },
  };
  const host = openLocalHost({ path: database, projection: transcriptProjection, driver, authorize: () => true });
  const feeds = new FeedRegistry();
  const api = createApi({ access, host, feeds, installation: installed, compatibility, agents: [{ installation: installed, availability: { kind: 'ready' } },
    { installation: { ...installed, installationId: 'unavailable' }, availability: { kind: 'unavailable', reason: 'offline' } }],
    credentialClass: 'native', isClosing: () => false });
  const operations = [];
  const endpoint = serviceEndpoint({ access, api: async (principal, request) => { operations.push(request.op); return api(principal, request); },
    credentialClass: 'native', isClosing: () => false, observability: NO_OBSERVABILITY });
  const origin = await listen(t, (request, response) => { void endpoint(request, response).catch(() => response.destroy()); });
  t.after(async () => { feeds.dispose(); host.close(); await host.drained; access.close(); });
  host.createConversation(scope, installed);
  host.createConversation({ ...scope, conversationId: 'conversation-b' }, installed);
  const nativeRun = run(scope);
  nativeRun.reference.binding = installed.binding;
  host.append(scope, { events: [
    { kind: 'run-started', runId: 'run-a', previousRunId: null },
    { kind: 'command-updated', activity: { kind: 'command', activityId: 'activity-a', runId: 'run-a', revision: 1,
      command: 'echo hello', cwd: '/tmp', detailsTruncated: false, status: { kind: 'completed', exitCode: 0 }, output: 'private-output', outputTruncated: false } },
  ], runs: [nativeRun], decisions: [question()] });
  const uncertain = await host.conversation(scope).submit({ version: 1, scope, clientCommandId: 'uncertain-original', body: { kind: 'send', text: 'hello' } });
  assert.equal(uncertain.receipt.state.kind, 'uncertain');
  await host.conversation(scope).submit({ version: 1, scope, clientCommandId: 'completed-original', body: { kind: 'send', text: 'hello' } });
  await host.conversation(scope).submit({ version: 1, scope, clientCommandId: 'accepted-original', body: { kind: 'send', text: 'hello' } });
  pendingSubmission = host.conversation(scope).submit({ version: 1, scope, clientCommandId: 'pending-original', body: { kind: 'cancel', runId: 'run-a' } });
  await Promise.race([pendingEntered, pendingSubmission.then(result => { throw new Error(`Pending command did not dispatch: ${JSON.stringify(result)}`); })]);
  const durable = () => {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'service_%' ORDER BY name").all();
      return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
    } finally { db.close(); }
  };
  const invitation = () => JSON.stringify({ ok: true, value: { hostId: access.hostId, code: access.invite('native') } });
  const pair = async () => {
    const path = join(directory, 'paired.json');
    const result = await cli(['pair', origin, path], invitation());
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
    return { path, record: JSON.parse(readFileSync(path, 'utf8')) };
  };
  return { directory, access, host, counts, feeds, operations, scope, origin, durable, invitation, pair };
}
