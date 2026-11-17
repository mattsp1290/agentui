import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviderRegistry, openLocalHost } from '@agentui/host';
import { loadServerExtension } from '@agentui/host/extensions';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ConversationScope, OutputId } from '@agentui/contracts';

export async function openReportExample(options: { hostPath: string; scope: ConversationScope }) {
  const loaded = await loadServerExtension({ directory: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    manifest: { namespace: 'reports', trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './dist/server.js' }] } });
  const registry = createProviderRegistry([{ ...loaded, authority: {
    credentials: { async use() { throw new Error('Reports do not use credentials'); } },
    issue() { return { credential: null, expectedAuthority: 'remote-provider', assertAuthorized() {} }; },
    async close() {},
  } }]);
  try {
    await registry.activate();
    const selected = (await registry.discover()).find(status => status.kind === 'available');
    const agent = selected?.agents[0];
    if (!selected || !agent) throw new Error('Report provider unavailable');
    const host = openLocalHost({ path: options.hostPath, projection: transcriptProjection, driver: [], providers: registry,
      authorize: scope => scope.hostId === options.scope.hostId && scope.conversationId === options.scope.conversationId });
    try {
      const created = await host.createProviderConversation(options.scope, { kind: 'provider', contributionId: selected.contributionId, instance: selected.instance, agent, presentationVersion: 1, expectedAuthority: selected.expectedAuthority }, registry);
      if (created.kind !== 'confirmed') throw new Error('Report creation unavailable');
      return { host,
        async send(text: string, clientCommandId: string) {
          return host.conversation(options.scope).submit({ version: 1, scope: options.scope, clientCommandId, body: { kind: 'send', text } });
        },
        async outputs() { return host.conversationOutputs(options.scope); },
        async read(outputId: OutputId) { return host.readOutput(options.scope, outputId); },
        async close() { host.close(); await host.drained; await registry.close(); },
      };
    } catch (error) { host.close(); await host.drained; throw error; }
  } catch (error) { await registry.close(); throw error; }
}
