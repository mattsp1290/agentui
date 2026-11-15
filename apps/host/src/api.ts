import type { ConversationScope } from '@agentui/contracts';
import type { HostCompatibility } from '@agentui/contracts/compatibility';
import { conversationPreview } from '@agentui/contracts/conversation';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import type { ServiceRequest, ServiceValueMap } from '@agentui/contracts/service';
import type { Installation, LocalHost, ConversationInstallation, ProviderInstallation, DiscoveredProvider, createProviderRegistry } from '@agentui/host';
import { recordedInstallation } from '@agentui/host/recorded';
import type { Access, CredentialClass, Principal } from './access.js';
import { ServiceError } from '@agentui/contracts/service';
import type { FeedRegistry } from './feed-registry.js';
import { searchConversations } from './conversation-search.js';
import { describeAgent, describeProviderAgent } from './agents.js';
import type { InstalledAgent } from './agents.js';
import { canonicalJson } from '@agentui/contracts';

type Request = Exclude<ServiceRequest, { op: 'pair' }>;
export function createApi(options: {
  readonly access: Access; readonly host: LocalHost<TranscriptEvent, Transcript>;
  readonly compatibility: HostCompatibility; readonly feeds: FeedRegistry;
  readonly installation?: Installation;
  readonly agents?: readonly InstalledAgent[];
  readonly providers?: ReturnType<typeof createProviderRegistry>;
  readonly providerCatalog?: readonly DiscoveredProvider[];
  readonly credentialClass: CredentialClass; readonly isClosing: () => boolean;
}) {
  const { access, host, feeds } = options;
  const defaultInstallation = options.installation ?? recordedInstallation;
  const configured: readonly InstalledAgent[] = options.agents ?? [{ installation: defaultInstallation, availability: { kind: 'ready' } }];
  const agents = new Map(configured.map(entry => {
    const descriptor = describeAgent(entry.installation, entry.availability);
    return [canonicalJson(entry.installation), { ...descriptor, label: entry.name ? `${entry.name} · ${descriptor.label}` : descriptor.label }];
  }));
  const defaultAgentId = describeAgent(defaultInstallation, { kind: 'ready' }).id;
  if (agents.size !== configured.length || ![...agents.values()].some(agent => agent.id === defaultAgentId)) throw new Error('Invalid configured agents');
  const providerAgents = new Map((options.providerCatalog ?? []).flatMap(provider => provider.agents.map(agent => {
    const installation: ProviderInstallation = { kind: 'provider', contributionId: provider.contributionId,
      instance: provider.instance, agent, presentationVersion: 1, expectedAuthority: provider.expectedAuthority };
    const descriptor = describeProviderAgent(installation, provider.capabilities.create ? { kind: 'ready' }
      : { kind: 'unavailable', reason: 'This provider does not support conversation creation.' }, provider.capabilities.reconcile ? [
        ...(provider.capabilities.send ? ['send' as const] : []), ...(provider.capabilities.cancel ? ['cancel' as const] : []),
        ...(provider.capabilities.decide ? ['approve' as const] : []),
      ] : []);
    return [descriptor.id, { installation, descriptor }] as const;
  })));
  const describe = (installation: ConversationInstallation) => 'kind' in installation
    ? providerAgents.get(describeProviderAgent(installation, { kind: 'ready' }).id)?.descriptor ?? describeProviderAgent(installation,
      { kind: 'unavailable', reason: 'This conversation’s provider is no longer configured.' })
    : agents.get(canonicalJson(installation)) ?? describeAgent(installation,
    { kind: 'unavailable', reason: 'This conversation’s agent is no longer configured.' });
  function requestScope(request: Request): ConversationScope | null {
    switch (request.op) {
      case 'submit': return request.command.scope;
      case 'conversation-agent': case 'create': case 'receipt': case 'reconcile': case 'watch': return request.scope;
      case 'pull': case 'close': case 'metadata': case 'catalog': case 'search': return null;
    }
  }
  async function apply(principal: Principal, request: Request): Promise<ServiceValueMap[Request['op']]> {
    switch (request.op) {
      case 'metadata': return { hostId: principal.hostId, principalId: principal.id, compatibility: options.compatibility, agents: [...agents.values(), ...[...providerAgents.values()].map(entry => entry.descriptor)], defaultAgentId } satisfies ServiceValueMap['metadata'];
      case 'catalog': return host.listConversations(principal.hostId, request.after, request.limit).map(scope => ({
        scope, preview: conversationPreview(host.inspect(scope).snapshot.document.domain),
      })) satisfies ServiceValueMap['catalog'];
      case 'search': return searchConversations(host, { hostId: principal.hostId, query: request.query, after: request.after });
      case 'conversation-agent': {
        const installation = host.creation(request.scope)?.installation ?? host.installation(request.scope);
        return installation ? describe(installation) : null;
      }
      case 'create': {
        const original = host.creation(request.scope);
        const provider = original?.installation ?? providerAgents.get(request.agentId)?.installation;
        if (provider) {
          if (describeProviderAgent(provider, { kind: 'ready' }).id !== request.agentId) throw new ServiceError('invalid', 'Conversation already belongs to another agent.');
          if (original?.observation?.kind === 'confirmed') return request.scope;
          if (original?.observation?.kind === 'rejected' || original?.observation?.kind === 'not-dispatched') {
            throw new ServiceError('create-rejected', 'The provider did not create this conversation. You can start a new conversation.');
          }
          if (!options.providers) throw new ServiceError('unavailable', 'The original provider is unavailable. Recover this creation when it returns.');
          const result = await host.createProviderConversation(request.scope, provider, options.providers);
          if (result.kind === 'confirmed') return request.scope;
          if (result.kind === 'rejected' || result.kind === 'not-dispatched') throw new ServiceError('create-rejected', 'The provider did not create this conversation. You can start a new conversation.');
          throw new ServiceError('unavailable', 'Creation is not confirmed. Recovery will check the original request.');
        }
        const existing = host.installation(request.scope);
        if (existing) {
          if ('kind' in existing) throw new ServiceError('unavailable', 'The original provider creation record is unavailable.');
          if (describe(existing).id !== request.agentId) throw new ServiceError('invalid', 'Conversation already belongs to another agent.');
          return request.scope;
        }
        const selected = configured.find(entry => describe(entry.installation).id === request.agentId);
        if (!selected) throw new ServiceError('create-rejected', 'This conversation was not created. Choose an available agent for a new conversation.');
        const descriptor = describe(selected.installation);
        if (descriptor.availability.kind !== 'ready') throw new ServiceError('unavailable', descriptor.availability.reason);
        host.createConversation(request.scope, selected.installation);
        return request.scope satisfies ServiceValueMap['create'];
      }
      case 'submit': return host.conversation(request.command.scope).submit(request.command) satisfies Promise<ServiceValueMap['submit']>;
      case 'receipt': return host.conversation(request.scope).receipt(request.id) satisfies Promise<ServiceValueMap['receipt']>;
      case 'reconcile': return host.reconcile(request.scope, request.id) satisfies Promise<ServiceValueMap['reconcile']>;
      case 'watch': return { feedId: feeds.open(principal.id, host.conversation(request.scope), request) } satisfies ServiceValueMap['watch'];
      case 'pull': return feeds.pull(principal.id, request.feedId, request.ack) satisfies Promise<ServiceValueMap['pull']>;
      case 'close': feeds.close(principal.id, request.feedId); return null satisfies ServiceValueMap['close'];
    }
  }
  return async (principal: Principal, request: Request): Promise<ServiceValueMap[Request['op']]> => {
    try {
      if (options.isClosing()) throw new ServiceError('unavailable', 'Host is shutting down');
      if (!access.authorized(principal, options.credentialClass)) throw new ServiceError('unauthorized', 'Device access was revoked');
      const scope = requestScope(request);
      if (scope !== null && scope.hostId !== principal.hostId) throw new ServiceError('forbidden', 'Conversation belongs to another host');
      const value = await apply(principal, request);
      if (!access.authorized(principal, options.credentialClass)) throw new ServiceError('unauthorized', 'Device access was revoked');
      return value;
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      const message = request.op === 'submit' || request.op === 'reconcile'
        ? 'The host could not confirm this operation. Reconcile before retrying.' : 'Host operation failed. Try again.';
      throw new ServiceError('unavailable', message);
    }
  };
}
