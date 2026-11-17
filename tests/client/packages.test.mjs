import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createConversationStore } from '@agentui/client';
import { useConversation } from '@agentui/client/react';

test('public client exports have no host or native runtime dependency', async () => {
  assert.equal(typeof createConversationStore, 'function');
  assert.equal(typeof useConversation, 'function');
  await assert.rejects(import('@agentui/client/src/store.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  const pkg = JSON.parse(await readFile(new URL('../../packages/client/package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.dependencies, { '@agentui/contracts': '0.0.0', 'fast-sha256': '1.3.0' });
  assert.deepEqual(pkg.peerDependencies, { react: '^19.3.0' });
  assert.deepEqual(pkg.peerDependenciesMeta, { react: { optional: true } });
});
