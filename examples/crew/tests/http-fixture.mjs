import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewClient } from '@birbcrew/client';
import { connectCrewConversation } from '../dist/index.js';
import { fileIntents } from '../dist/file-intents.js';

export const conversationId = '22222222-2222-4222-8222-222222222222';
export const memberId = '33333333-3333-4333-8333-333333333333';
export const scope = { hostId: 'agentui-workstation', conversationId: 'local-crew-conversation' };
export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-crew-example-'));
  const path = join(directory, 'intent.json');
  const intents = fileIntents(path);
  const calls = [], accepted = new Map();
  const state = { dropReply: false, missingStatus: false, remoteMember: memberId, initiator: undefined, entries: 0 };
  function receipt(requestId) {
    return { apiVersion: '1', conversationId, requestId, status: 'completed', result: { text: 'Recorded Crew result' },
      ...(state.initiator ? { initiator: state.initiator } : {}),
      acceptance: { boundary: 'sql_admission_and_temporal_queue' } };
  }
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      calls.push({ method: request.method, url: request.url, body });
      assert.equal(request.headers.authorization, 'Bearer local-fixture-token');
      const send = (status, value) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      const prefix = `/v1/conversations/${conversationId}`;
      if (request.method === 'GET' && request.url === prefix) {
        send(200, { cursor: 1, state: { conversationId, memberId: state.remoteMember,
          engine: 'claude', profile: 'existing-member', phase: 'idle' },
        messages: [], openTools: {}, openText: null, childText: {} });
      } else if (request.method === 'POST' && request.url === `${prefix}/requests`) {
        const saved = await intents.load();
        assert.deepEqual(saved.command, { conversationId, ...body }, 'exact intent must exist before HTTP entry');
        const prior = accepted.get(body.requestId);
        if (prior) assert.deepEqual(body, prior, 'same request UUID must retain the original body');
        else { accepted.set(body.requestId, body); state.entries++; }
        if (state.dropReply) { state.dropReply = false; response.destroy(); }
        else send(202, receipt(body.requestId));
      } else if (request.method === 'GET' && request.url.startsWith(`${prefix}/requests/`)) {
        const requestId = request.url.split('/').at(-1);
        if (state.missingStatus || !accepted.has(requestId)) send(404, { error: 'request_not_found' });
        else send(200, receipt(requestId));
      } else send(400, { error: 'unexpected_route' });
    })().catch(error => { response.destroy(error); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const client = new CrewClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'local-fixture-token' });
  const options = { client, scope, installationId: 'crew-fixture-installation', conversationId, memberId, intents };
  return { state, calls, path, intents, options, open: changes => connectCrewConversation({ ...options, ...changes }) };
}
