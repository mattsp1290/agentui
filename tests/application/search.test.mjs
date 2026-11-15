import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
import { parseServiceResponse } from '@agentui/contracts/service';
import { openRecordedHost, recordedInstallation } from '@agentui/host/recorded';
import { Access } from '../../apps/host/build/tsc/access.js';
import { openAccessDatabase } from '../../apps/host/build/tsc/access-database.js';
import { createApi } from '../../apps/host/build/tsc/api.js';
import { FeedRegistry } from '../../apps/host/build/tsc/feed-registry.js';

test('saved history search scans past empty pages and searches only current transcript and labels', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-search-'));
  const access = new Access(openAccessDatabase(join(directory, 'host.sqlite')));
  const host = openRecordedHost({ path: join(directory, 'host.sqlite'), backendPath: join(directory, 'recorded.jsonl'), hostId: access.hostId, progressMs: 0 });
  const feeds = new FeedRegistry();
  t.after(async () => { feeds.dispose(); host.close(); await host.drained; access.close(); rmSync(directory, { recursive: true, force: true }); });
  const api = createApi({ access, host, feeds, credentialClass: 'browser-development', isClosing: () => false,
    compatibility: { wireVersion: 1, extensionSdkVersion: '0.0.0', nativeRuntime: RECORDED_RUNTIME,
      desiredGitRevision: 'test', appliedArtifact: { artifactId: 'test', gitRevision: 'test' } } });
  const principal = access.pair(access.invite('browser-development'), 'browser-development').principal;
  const scopes = Array.from({ length: 105 }, (_, index) => ({ hostId: access.hostId, conversationId: `chat-${String(index).padStart(3, '0')}` }));
  for (const scope of scopes) host.createConversation(scope, recordedInstallation);
  const append = (scope, messageId, text, revision = 1, complete = true, role = 'assistant') => host.append(scope, {
    events: [{ kind: 'message-updated', messageId, revision, role, text, complete }], runs: [], decisions: [],
  });
  const target = scopes.at(-1);
  append(target, 'first', 'Balcony garden', 1, true, 'user');
  append(target, 'answer', 'old superseded marker', 1, false);
  append(target, 'answer', `Current advice ${'herbs '.repeat(100)}WATER 💧 the mint`, 2, true);
  const search = async (query, after = null) => {
    const request = { op: 'search', query, after };
    return parseServiceResponse(request, { ok: true, value: await api(principal, request) }).value;
  };
  const first = await search('water');
  assert.deepEqual(first, { items: [], after: 'chat-099' });
  const second = await search('water', first.after);
  assert.equal(second.after, null);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].scope.conversationId, target.conversationId);
  assert.equal(second.items[0].preview, 'Balcony garden');
  assert.match(second.items[0].excerpt, /WATER 💧 the mint/);
  assert.ok(second.items[0].excerpt.length <= 160);
  assert.equal((await search('balcony', first.after)).items[0].scope.conversationId, target.conversationId);
  assert.equal((await search('new chat · chat-000')).items[0].scope.conversationId, scopes[0].conversationId);
  assert.equal((await search('superseded', first.after)).items.length, 0);
  await host.conversation(scopes[0]).submit({ version: 1, scope: scopes[0], clientCommandId: 'private-receipt-marker', body: { kind: 'send', text: 'Public message' } });
  const privateOperation = Object.values(host.inspect(scopes[0]).snapshot.document.receipts)[0].hostOperationId;
  for (const query of ['private-receipt-marker', privateOperation, 'approval-v1']) {
    assert.deepEqual((await search(query)).items, [], 'private receipt, native reference and continuation fields are excluded');
  }
  access.revoke(principal.id);
  await assert.rejects(api(principal, { op: 'search', query: 'garden', after: null }), error => error.kind === 'unauthorized');
});
