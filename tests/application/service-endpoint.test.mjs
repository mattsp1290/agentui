import { NO_OBSERVABILITY } from '../../apps/host/build/tsc/observability.js';
import { describeAgent } from '../../apps/host/build/tsc/agents.js';
import { recordedInstallation } from '@agentui/host/recorded';
const recordedAgentId = describeAgent(recordedInstallation, { kind: 'ready' }, { kind: 'unsupported', reason: 'Recorded text-only fixture.' }).id;
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EXTENSION_SDK_VERSION, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
import { SERVICE_MAX_RESPONSE_BYTES } from '@agentui/contracts/service';
import { openRecordedHost } from '@agentui/host/recorded';
import { openAccessDatabase } from '../../apps/host/build/tsc/access-database.js';
import { createApi } from '../../apps/host/build/tsc/api.js';
import { FeedRegistry } from '../../apps/host/build/tsc/feed-registry.js';
import { serviceEndpoint } from '../../apps/host/build/tsc/service-endpoint.js';

for (const client of ['browser-development', 'native']) {
  test(`${client} framing failures stay unavailable after dispatch without reflecting diagnostics`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'agentui-endpoint-'));
    const access = openAccessDatabase(join(directory, 'host.sqlite'));
    const host = openRecordedHost({ path: join(directory, 'host.sqlite'), backendPath: join(directory, 'recorded.jsonl'), hostId: access.hostId });
    const feeds = new FeedRegistry();
    const compatibility = { wireVersion: 1, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: RECORDED_RUNTIME,
      desiredGitRevision: 'test', appliedArtifact: { artifactId: 'test', gitRevision: 'test' } };
    let closing = false;
    const options = { observability: NO_OBSERVABILITY, hostId: access.hostId, api: createApi({ host, feeds, agentSelection: { kind: 'native', defaultInstallation: recordedInstallation, agents: [{ installation: recordedInstallation, availability: { kind: 'ready' } }] }, compatibility, isClosing: () => closing,
      extensions: { describe: () => [{ namespace: 'fixture', state: 'active', operations: ['echo'], installations: [{ installationId: 'personal', status: 'available' }] }],
        call: async request => request.operation === 'echo' ? { kind: 'ok', output: request.input } : Promise.reject(new Error('private backend diagnostic')) } }), isClosing: () => closing };
    const handler = serviceEndpoint(client === 'native' ? { ...options, client } : { ...options, client, files: new Map() });
    const server = createServer((request, response) => { void handler(request, response).catch(() => response.destroy()); });
    t.after(async () => {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      feeds.dispose();
      host.close();
      await host.drained;
      access.database.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const call = async body => {
      const response = await fetch(`${origin}${client === 'native' ? '/native/v1' : '/api/v1'}`, {
        method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json',
          ...(client === 'native' ? {} : { Origin: origin }) }, body: JSON.stringify(body),
      });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal(response.headers.get('set-cookie'), null);
      return { status: response.status, body: await response.json() };
    };
    const metadata = await call({ op: 'metadata' });
    assert.equal(metadata.body.value.principalId, 'trusted-owner');
    assert.deepEqual(metadata.body.value.extensions, [{ namespace: 'fixture', state: 'active', operations: ['echo'], installations: [{ installationId: 'personal', status: 'available' }] }]);
    assert.equal(JSON.stringify(metadata.body.value.extensions).includes('http'), false);
    const extensionCall = { op: 'extension-call', namespace: 'fixture', installationId: 'personal', input: { value: 1 } };
    assert.deepEqual(await call({ ...extensionCall, operation: 'echo' }), { status: 200, body: { ok: true, value: { kind: 'ok', output: { value: 1 } } } });
    assert.deepEqual(await call({ ...extensionCall, operation: 'other' }), { status: 200, body: { ok: true, value: { kind: 'failed', cause: 'unavailable' } } });
    assert.equal((await call({ ...extensionCall, operation: 'echo', url: 'http://elsewhere' })).status, 400);
    assert.deepEqual(await call({ op: 'search', query: 'missing', after: null }), {
      status: 200, body: { ok: true, value: { items: [], after: null } },
    });
    const diagnostic = 'private backend diagnostic';
    compatibility.desiredGitRevision = diagnostic.padEnd(SERVICE_MAX_RESPONSE_BYTES, 'x');
    assert.deepEqual(await call({ op: 'metadata' }), {
      status: 503, body: { ok: false, error: { kind: 'unavailable', message: 'Host request did not complete' } },
    });
    assert.deepEqual(await call({ op: 'metadata', extra: diagnostic }), {
      status: 400, body: { ok: false, error: { kind: 'invalid', message: 'Invalid host request' } },
    });
    assert.equal((await call({ op: 'create', agentId: recordedAgentId, scope: { hostId: 'another-host', conversationId: 'forbidden' } })).status, 403);
    closing = true;
    assert.deepEqual(await call({ op: 'metadata' }), {
      status: 503, body: { ok: false, error: { kind: 'unavailable', message: 'Host is shutting down' } },
    });
  });
}
