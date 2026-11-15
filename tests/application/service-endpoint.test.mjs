import { NO_OBSERVABILITY } from '../../apps/host/build/tsc/observability.js';
import { describeAgent } from '../../apps/host/build/tsc/agents.js';
import { recordedInstallation } from '@agentui/host/recorded';
const recordedAgentId = describeAgent(recordedInstallation, { kind: 'ready' }).id;
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EXTENSION_SDK_VERSION, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
import { SERVICE_MAX_RESPONSE_BYTES } from '@agentui/contracts/service';
import { openRecordedHost } from '@agentui/host/recorded';
import { Access } from '../../apps/host/build/tsc/access.js';
import { openAccessDatabase } from '../../apps/host/build/tsc/access-database.js';
import { createApi } from '../../apps/host/build/tsc/api.js';
import { FeedRegistry } from '../../apps/host/build/tsc/feed-registry.js';
import { serviceEndpoint } from '../../apps/host/build/tsc/service-endpoint.js';

for (const credentialClass of ['browser-development', 'native']) {
  test(`${credentialClass} framing failures stay unavailable after dispatch without reflecting diagnostics`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'agentui-endpoint-'));
    const access = new Access(openAccessDatabase(join(directory, 'host.sqlite')));
    const host = openRecordedHost({ path: join(directory, 'host.sqlite'), backendPath: join(directory, 'recorded.jsonl'), hostId: access.hostId });
    const feeds = new FeedRegistry(), paired = access.pair(access.invite(credentialClass), credentialClass);
    const compatibility = { wireVersion: 1, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: RECORDED_RUNTIME,
      desiredGitRevision: 'test', appliedArtifact: { artifactId: 'test', gitRevision: 'test' } };
    let closing = false;
    const options = { observability: NO_OBSERVABILITY, access, api: createApi({ access, host, feeds, agentSelection: { kind: 'native', defaultInstallation: recordedInstallation, agents: [{ installation: recordedInstallation, availability: { kind: 'ready' } }] }, compatibility, credentialClass, isClosing: () => closing }), isClosing: () => closing };
    const handler = serviceEndpoint(credentialClass === 'native' ? { ...options, credentialClass } : { ...options, credentialClass, files: new Map() });
    const server = createServer((request, response) => { void handler(request, response).catch(() => response.destroy()); });
    t.after(async () => {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      feeds.dispose();
      host.close();
      await host.drained;
      access.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const call = async body => {
      const response = await fetch(`${origin}${credentialClass === 'native' ? '/native/v1' : '/api/v1'}`, {
        method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json',
          ...(credentialClass === 'native' ? { Authorization: `Bearer ${paired.secret}` }
            : { Origin: origin, Cookie: `agentui_device_${access.hostId}=${paired.secret}` }) }, body: JSON.stringify(body),
      });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal(response.headers.get('set-cookie'), null);
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await call({ op: 'metadata' })).body.value.principalId, paired.principal.id);
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
