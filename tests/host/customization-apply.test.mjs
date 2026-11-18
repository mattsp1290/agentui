import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseServiceRequest } from '@agentui/contracts/service';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { createRecordedDriver, openLocalHost } from '@agentui/host';
import { createCustomizationRelay, DELIVERY_DEADLINE_MS } from '../../apps/host/build/tsc/customization-relay.js';
import { hostActiveWork } from '../../apps/host/build/tsc/active-work.js';
import { deferred, installed, until } from './fixture.mjs';

const checkout = fileURLToPath(new URL('../../', import.meta.url));
const hostArtifactId = JSON.parse(readFileSync(join(checkout, 'apps/host/dist/artifact.json'), 'utf8')).artifactId;
const head = 'a'.repeat(40);
const key = character => character.repeat(64);
const build = (extra = {}) => ({ buildKey: key('b'), inputsKey: key('c'), commit: head, state: 'ready', startedAt: 1, finishedAt: 2,
  namespaces: ['alpha'], ignoredGrants: [], hostArtifactId, grantVariables: ['AGENTUI_EXTENSION_ALPHA_TOKEN'], ...extra });
const workerStatus = (extra = {}) => ({ connection: { location: '/srv/custom', branch: 'customization', subdirectory: '' }, head, extensions: [],
  settings: null, build: build(), presentTokens: ['AGENTUI_EXTENSION_ALPHA_TOKEN'], ...extra });
const apply = (buildKey = key('b')) => parseServiceRequest({ op: 'customization-apply', requestId: randomUUID(), buildKey });
const toggle = () => parseServiceRequest({ op: 'customization-toggle', requestId: randomUUID(), key: 'ext/a', enabled: false, expectedHead: head });
const grant = { id: 'personal', instance: { namespace: 'alpha', installationId: 'personal', generation: '1', protocolVersion: '1' },
  service: 'http://127.0.0.1:9', expectedAuthority: 'remote-provider', authentication: { kind: 'environment', variable: 'AGENTUI_EXTENSION_ALPHA_TOKEN', revision: '1' } };
const target = (buildKey, extra = {}) => ({ buildKey, inputsKey: key('c'), hostArtifactId, assets: `/builds/${buildKey}/desktop`,
  server: { directory: `/builds/${buildKey}/server`, artifactId: key('d') }, grants: [grant], ...extra });

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'agentui-apply-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function relay(t, options = {}) {
  let time = 1_000_000;
  const dataDirectory = options.dataDirectory ?? await directory(t);
  if (!options.dataDirectory) {
    // A session wrapper started this host: it wrote this start's result.
    await mkdir(join(dataDirectory, 'customization'), { recursive: true });
    await writeFile(join(dataDirectory, 'customization/launch-result.json'), JSON.stringify({ version: 1, hostPid: process.pid, attempted: null, started: null, outcome: 'defaults', failed: [], omittedGrants: [] }));
  }
  const restarts = [];
  const instance = createCustomizationRelay({ dataDirectory, now: () => time, hostArtifactId, activeWork: () => false, restart: () => restarts.push(time), ...options });
  t.after(() => instance.close());
  const workerId = randomUUID();
  return { relay: instance, dataDirectory, restarts, workerId, advance: ms => { time += ms; }, push: (status = workerStatus(), results = [], delivery) => instance.push(workerId, status, results, delivery) };
}
const launchFile = async dataDirectory => JSON.parse(await readFile(join(dataDirectory, 'customization/launch.json'), 'utf8'));

test('apply is refused as not-ready unless the worker reports a ready build of that key made by the running host build', async t => {
  const r = await relay(t);
  r.push(workerStatus({ build: null }));
  assert.deepEqual(r.relay.mutate(apply()), { kind: 'refused', cause: 'not-ready' });
  r.push(workerStatus({ build: build({ state: 'building-server', finishedAt: undefined }) }));
  assert.deepEqual(r.relay.mutate(apply()), { kind: 'refused', cause: 'not-ready' });
  r.push(workerStatus({ build: build({ hostArtifactId: key('e') }) }));
  assert.deepEqual(r.relay.mutate(apply()), { kind: 'refused', cause: 'not-ready' }, 'a build made by another host build is never started');
  r.push();
  assert.deepEqual(r.relay.mutate(apply(key('f'))), { kind: 'refused', cause: 'not-ready' });
  assert.equal(r.relay.draining(), false);
});

test('a host that no session wrapper started refuses apply, because nothing would start it again after exit 75', async t => {
  const dataDirectory = await directory(t);
  const r = await relay(t, { dataDirectory });
  r.push();
  assert.deepEqual(r.relay.mutate(apply()), { kind: 'refused', cause: 'unsupported' });
  assert.equal(r.relay.draining(), false);
});

test('an active-work check that throws counts as active work and leaves no gate behind', async t => {
  const r = await relay(t, { activeWork: () => { throw new Error('closing'); } });
  r.push();
  assert.deepEqual(r.relay.mutate(apply()), { kind: 'refused', cause: 'active-work' });
  assert.equal(r.relay.draining(), false);
});

test('apply is refused with missing-token when a grant variable is neither reported by the worker nor consumed by this host', async t => {
  const r = await relay(t);
  r.push(workerStatus({ presentTokens: [] }));
  assert.deepEqual(r.relay.mutate(apply()), { kind: 'refused', cause: 'missing-token' });
  assert.deepEqual(r.relay.status().missingTokens, ['AGENTUI_EXTENSION_ALPHA_TOKEN'], 'names only');
  const consumed = await relay(t, { consumedTokens: ['AGENTUI_EXTENSION_ALPHA_TOKEN'] });
  consumed.push(workerStatus({ presentTokens: [] }));
  assert.deepEqual(consumed.relay.status().missingTokens, []);
  assert.deepEqual(consumed.relay.mutate(apply()), { kind: 'accepted' });
});

test('active work refuses the apply and lowers the draining gate again', async t => {
  let busy = true;
  const r = await relay(t, { activeWork: () => busy });
  r.push();
  assert.deepEqual(r.relay.mutate(apply()), { kind: 'refused', cause: 'active-work' });
  assert.equal(r.relay.draining(), false);
  assert.deepEqual(r.relay.mutate(toggle()), { kind: 'accepted' }, 'the gate is clear');
  busy = false;
});

test('an accepted apply drains: mutations are refused, and a worker that goes silent releases the gate as delivery-failed', async t => {
  const r = await relay(t);
  r.push();
  const request = apply();
  assert.deepEqual(r.relay.mutate(request), { kind: 'accepted' });
  assert.equal(r.relay.draining(), true);
  assert.deepEqual(r.relay.mutate(toggle()), { kind: 'refused', cause: 'draining' });
  const { requests } = await r.relay.pull(r.workerId, 0);
  assert.deepEqual(requests, [{ op: 'apply', requestId: request.requestId, buildKey: key('b') }]);
  r.advance(31_000);
  const status = r.relay.status();
  assert.equal(status.support, 'worker-offline');
  assert.deepEqual(status.results, [{ requestId: request.requestId, outcome: 'delivery-failed' }]);
  assert.equal(r.relay.draining(), false);
});

test('the draining gate has a deadline even while the worker stays online', async t => {
  const r = await relay(t);
  r.push();
  const request = apply();
  r.relay.mutate(request);
  for (let elapsed = 0; elapsed < DELIVERY_DEADLINE_MS - 10_000; elapsed += 10_000) { r.advance(10_000); r.push(); }
  assert.equal(r.relay.draining(), true, 'an upload may take longer than the 180-second mutation limit');
  r.advance(10_000);
  r.push();
  assert.equal(r.relay.draining(), false);
  assert.deepEqual(r.relay.status().results, [{ requestId: request.requestId, outcome: 'delivery-failed' }]);
  assert.deepEqual(r.relay.mutate(toggle()), { kind: 'accepted' });
});

test('delivery-failed from the worker clears the gate; an ok without a matching delivery fails delivery too', async t => {
  const r = await relay(t);
  r.push();
  const first = apply();
  r.relay.mutate(first);
  r.push(workerStatus(), [{ requestId: first.requestId, outcome: 'delivery-failed' }]);
  assert.equal(r.relay.draining(), false);
  const second = apply();
  assert.deepEqual(r.relay.mutate(second), { kind: 'accepted' });
  r.push(workerStatus(), [{ requestId: second.requestId, outcome: 'ok' }]);
  assert.equal(r.relay.draining(), false);
  assert.deepEqual(r.relay.status().results.at(-1), { requestId: second.requestId, outcome: 'delivery-failed' });
  assert.deepEqual(r.restarts, []);
});

test('on delivered the host records next in launch.json, keeps draining and asks for the restart', async t => {
  const r = await relay(t);
  r.push();
  const request = apply();
  r.relay.mutate(request);
  const delivery = { requestId: request.requestId, buildKey: key('b'), assets: '/builds/b/desktop', server: { directory: '/builds/b/server', artifactId: key('d') }, grants: [grant] };
  const reply = r.push(workerStatus(), [{ requestId: request.requestId, outcome: 'ok' }], delivery);
  assert.deepEqual(reply, { ok: true, launch: { current: null, next: key('b') } });
  const launch = await launchFile(r.dataDirectory);
  assert.deepEqual(launch, { version: 1, current: null, next: { buildKey: key('b'), inputsKey: key('c'), hostArtifactId, assets: '/builds/b/desktop',
    server: { directory: '/builds/b/server', artifactId: key('d') }, grants: [grant] } });
  assert.doesNotMatch(JSON.stringify(launch), /secret|token-value/u);
  assert.deepEqual(r.relay.status().results, [{ requestId: request.requestId, outcome: 'ok' }]);
  assert.equal(r.relay.draining(), true, 'no new work is admitted before the exit');
  await until(() => r.restarts.length === 1, 2_000);
});

test('at startup the host promotes a started next and clears a target that failed to start', async t => {
  const dataDirectory = await directory(t);
  await mkdir(join(dataDirectory, 'customization'), { recursive: true });
  const write = (name, value) => writeFile(join(dataDirectory, 'customization', name), JSON.stringify(value));
  await write('launch.json', { version: 1, current: target(key('1')), next: target(key('2')) });
  await write('launch-result.json', { version: 1, hostPid: 4242, attempted: key('2'), started: key('2'), outcome: 'ok', failed: [], omittedGrants: ['AGENTUI_EXTENSION_BETA_TOKEN'] });
  const other = await relay(t, { dataDirectory, pid: 1 });
  assert.equal(other.relay.status().running.buildKey, null, 'a result written for another host process is not this start');
  const promoted = await relay(t, { dataDirectory, pid: 4242 });
  assert.deepEqual(promoted.relay.status().running, { buildKey: key('2'), omittedGrants: ['AGENTUI_EXTENSION_BETA_TOKEN'], stale: false });
  assert.deepEqual([(await launchFile(dataDirectory)).current.buildKey, (await launchFile(dataDirectory)).next], [key('2'), null]);

  await write('launch.json', { version: 1, current: target(key('1')), next: target(key('2')) });
  await write('launch-result.json', { version: 1, hostPid: 4343, attempted: key('2'), started: key('1'), outcome: 'start-failed', failed: [key('2')], omittedGrants: [] });
  const fallback = await relay(t, { dataDirectory, pid: 4343 });
  assert.equal(fallback.relay.status().running.buildKey, key('1'));
  assert.deepEqual([(await launchFile(dataDirectory)).current.buildKey, (await launchFile(dataDirectory)).next], [key('1'), null]);

  await write('launch.json', { version: 1, current: target(key('1')), next: null });
  await write('launch-result.json', { version: 1, hostPid: 4444, attempted: key('1'), started: null, outcome: 'start-failed', failed: [key('1')], omittedGrants: [] });
  const defaults = await relay(t, { dataDirectory, pid: 4444 });
  assert.equal(defaults.relay.status().running.buildKey, null);
  assert.deepEqual((await launchFile(dataDirectory)).current, null, 'the next session does not try the failed target again');

  await write('launch-result.json', { version: 1, hostPid: 4545, attempted: null, started: null, outcome: 'stale', failed: [], omittedGrants: [] });
  assert.equal((await relay(t, { dataDirectory, pid: 4545 })).relay.status().running.stale, true);
});

test('active work includes a turn that keeps running after its dispatch returned, and a dispatch in flight', async t => {
  const dir = await directory(t);
  const gate = deferred();
  let hold = false;
  const runId = 'run-1';
  const driver = createRecordedDriver({ installation: installed, backendPath: join(dir, 'recorded.jsonl'), decodeEvent: transcriptProjection.decodeEvent,
    resolve: async () => {
      if (hold) await gate.promise;
      return { kind: 'completed', output: { events: [{ kind: 'run-started', runId, previousRunId: null }], runs: [], decisions: [] } };
    } });
  const host = openLocalHost({ path: join(dir, 'host.sqlite'), projection: transcriptProjection, driver, authorize: () => true });
  t.after(() => host.close());
  const scope = { hostId: 'host-a', conversationId: 'conversation-a' };
  host.createConversation(scope, installed);
  assert.equal(hostActiveWork(host, 'host-a'), false);
  const receipt = await host.conversation(scope).submit({ version: 1, scope, clientCommandId: 'c1', body: { kind: 'send', text: 'hello' } });
  assert.equal(receipt.kind, 'receipt');
  assert.equal(host.busy(), false, 'the dispatch call returned');
  assert.equal(hostActiveWork(host, 'host-a'), true, 'the run started and has not ended');
  host.append(scope, { events: [{ kind: 'run-ended', runId, outcome: 'completed' }], runs: [], decisions: [] });
  assert.equal(hostActiveWork(host, 'host-a'), false);
  hold = true;
  const second = host.conversation(scope).submit({ version: 1, scope, clientCommandId: 'c2', body: { kind: 'send', text: 'again' } });
  await until(() => host.busy());
  assert.equal(hostActiveWork(host, 'host-a'), true, 'a dispatch in flight');
  gate.resolve();
  await second;
  assert.equal(hostActiveWork(host, 'host-a', { status: () => ({ kind: 'active', generation: 1, pending: 1 }) }), true, 'pending provider work');
});

test('a real host process refuses new turns while draining, then writes launch.json and exits 75 once the build is delivered', { timeout: 60_000 }, async t => {
  const dataDirectory = await directory(t);
  const child = spawn(process.execPath, [join(checkout, 'apps/host/dist/main.js'), 'browser-dev', '--data-dir', dataDirectory, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  let output = '';
  const origin = await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { output += data; const line = output.split('\n').find(item => item.includes('"origin"')); if (line) resolve(JSON.parse(line).origin); });
    child.once('exit', () => reject(new Error('host exited before ready')));
  });
  const call = (body, path = '/api/v1') => fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body) }).then(response => response.json());
  const metadata = (await call({ op: 'metadata' })).value;
  const scope = { hostId: metadata.hostId, conversationId: randomUUID() };
  assert.equal((await call({ op: 'create', scope, agentId: metadata.defaultAgentId })).ok, true);
  const workerId = randomUUID();
  assert.equal((await call({ op: 'customization-worker-push', workerId, status: workerStatus(), results: [] }, '/api/v1/worker')).ok, true);
  assert.deepEqual((await call({ op: 'customization-apply', requestId: randomUUID(), buildKey: key('b') })).value, { kind: 'refused', cause: 'unsupported' }, 'no wrapper started it');
  // What the session wrapper writes once this host printed its ready line.
  await writeFile(join(dataDirectory, 'customization/launch-result.json'), JSON.stringify({ version: 1, hostPid: child.pid, attempted: null, started: null, outcome: 'defaults', failed: [], omittedGrants: [] }));
  const requestId = randomUUID();
  assert.deepEqual((await call({ op: 'customization-apply', requestId, buildKey: key('b') })).value, { kind: 'accepted' });
  const submitted = await call({ op: 'submit', command: { version: 1, scope, clientCommandId: randomUUID(), body: { kind: 'send', text: 'after the gate' } } });
  assert.equal(submitted.ok, false);
  assert.equal(submitted.error.kind, 'unavailable');
  assert.equal((await call({ op: 'create', scope: { hostId: metadata.hostId, conversationId: randomUUID() }, agentId: metadata.defaultAgentId })).ok, false);
  const pulled = await call({ op: 'customization-worker-pull', workerId, waitSeconds: 1 }, '/api/v1/worker');
  assert.equal(pulled.value.requests[0].op, 'apply');
  const delivery = { requestId, buildKey: key('b'), assets: '/builds/b/desktop', server: null, grants: [] };
  const pushed = await call({ op: 'customization-worker-push', workerId, status: workerStatus(), results: [{ requestId, outcome: 'ok' }], delivery }, '/api/v1/worker');
  assert.deepEqual(pushed.value, { ok: true, launch: { current: null, next: key('b') } });
  assert.equal(await exited, 75);
  const launch = await launchFile(dataDirectory);
  assert.equal(launch.next.buildKey, key('b'));
  assert.equal(launch.next.hostArtifactId, hostArtifactId);
});
