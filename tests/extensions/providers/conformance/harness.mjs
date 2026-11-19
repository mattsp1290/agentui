import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConversationStore } from '@agentui/client';
import { createBrowserConnection } from '@agentui/client/service';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { startBrowserHost } from '../../../host/extensions/fixtures.mjs';

export async function until(predicate, message = 'Condition timed out', ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/**
 * The real browser host, run in process through the same `startBrowserHost` entry `extensions/crew/run.mjs` uses, with
 * transient provider extensions. Clients reach it through the same `createBrowserConnection` and
 * `createConversationStore` the desktop application builds in `apps/desktop/src/application`.
 */
export async function host(t, extensions, { observability, headers = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-provider-conformance-'));
  let running, port, closed = false;
  const stores = new Set();
  const client = createBrowserConnection({ fetch: (url, init) => fetch(`${running.origin}${url}`,
    { ...init, headers: { ...init.headers, ...headers, Connection: 'close', Origin: running.origin } }) });
  const start = async values => {
    running = await startBrowserHost({ agentStartup: { kind: 'recorded' }, directory, port: port ?? 0, observability,
      assetsDirectory: fileURLToPath(new URL('../../../../apps/desktop/web-dist-browser/', import.meta.url)),
      extensions: { kind: 'transient', entries: values.map(item => item.value) } });
    port = Number(new URL(running.origin).port);
    closed = false;
  };
  const release = async () => { await Promise.all([...stores].map(store => store.dispose())); stores.clear(); };
  const close = async () => { await release(); if (!closed) { closed = true; await running.close(); } };
  await start(extensions);
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    client, close, get running() { return running; },
    async agent(namespace) {
      return (await client.metadata()).agents.find(agent => agent.kind === 'provider' && agent.namespace === namespace);
    },
    async create(namespace, id = randomUUID()) {
      const scope = { hostId: running.hostId, conversationId: id };
      await client.create(scope, (await this.agent(namespace)).id);
      return scope;
    },
    async store(scope) {
      let saved = null;
      const store = createConversationStore({ scope, port: client.conversation(scope), projection: transcriptProjection,
        createCommandId: randomUUID, drafts: { load: async () => saved, save: async value => { saved = structuredClone(value); },
          loadImage: async () => null } });
      stores.add(store);
      await store.ready;
      await store.connect();
      return store;
    },
    async restart(values) { await release(); await running.close(); await start(values); },
    replace(values) { return running.replaceProviderExtensions(values.map(item => item.value)); },
  };
}

export const view = store => store.getSnapshot().document;
export const assistantTexts = store => view(store).domain.messages.filter(message => message.role === 'assistant').map(message => message.text);
export const runOf = store => view(store).domain.currentRun;
export const pending = store => Object.values(view(store).decisions);
