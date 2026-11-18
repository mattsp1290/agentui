import { frontendToolsFor } from '@agentui/host/frontend-tools';
import { ContinuationRefused, imageFailure, providerUnavailableReasons } from '@agentui/host';
import type { ConversationScope } from '@agentui/contracts';
import type { HostCompatibility } from '@agentui/contracts/compatibility';
import { conversationPreview } from '@agentui/contracts/conversation';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import type { ExtensionCallRequest, ExtensionCallValue, ExtensionDescriptor, ServiceRequest, ServiceValueMap } from '@agentui/contracts/service';
import type { Installation, LocalHost, ConversationInstallation, ProviderInstallation, ProviderStatus, DiscoveredProvider, ProviderCreationOperations, UnavailableProvider } from '@agentui/host';
import type { Principal } from './principal.js';
import { ServiceError } from '@agentui/contracts/service';
import type { FeedRegistry } from './feed-registry.js';
import { searchConversations } from './conversation-search.js';
import { describeAgent, describeProviderAgent, describeUnavailableProvider } from './agents.js';
import type { InstalledAgent } from './agents.js';
import { canonicalJson } from '@agentui/contracts';

type ApiAgentSelection =
  | { readonly kind: 'native'; readonly agents: readonly InstalledAgent[]; readonly defaultInstallation: Installation }
  | { readonly kind: 'extensions' };
export function createApi(options: {
  readonly host: LocalHost<TranscriptEvent, Transcript>;
  readonly compatibility: HostCompatibility; readonly feeds: FeedRegistry;
  readonly agentSelection: ApiAgentSelection;
  readonly providers?: ProviderCreationOperations & { catalog(): readonly ProviderStatus[]; statusOf(installation: ProviderInstallation): ProviderStatus | undefined };
  readonly isClosing: () => boolean;
  readonly extensions?: {
    describe(): readonly ExtensionDescriptor[];
    call(request: ExtensionCallRequest): Promise<ExtensionCallValue>;
  };
}) {
  const { host, feeds } = options;
  const selection = options.agentSelection;
  const configured = selection.kind === 'native' ? selection.agents : [];
  const agents = () => new Map(configured.map(entry => {
    const descriptor = describeAgent(entry.installation, entry.availability, host.imageInput(entry.installation), entry.model);
    return [canonicalJson(entry.installation), { ...descriptor, label: entry.name ? `${entry.name} · ${descriptor.label}` : descriptor.label }];
  }));
  const selectable = new Set(configured.filter(entry => entry.selectable !== false).map(entry => describeAgent(entry.installation, entry.availability, host.imageInput(entry.installation)).id));
  const nativeDefault = selection.kind === 'native' ? describeAgent(selection.defaultInstallation, { kind: 'ready' }, host.imageInput(selection.defaultInstallation)).id : null;
  if (agents().size !== configured.length || (nativeDefault !== null && !selectable.has(nativeDefault))) throw new Error('Invalid configured agents');
  function requestScope(request: ServiceRequest): ConversationScope | null {
    switch (request.op) {
      case 'submit': return request.command.scope;
      case 'output-list': case 'output-read': case 'frontend-binding': case 'image-upload': case 'image-read': case 'conversation-permissions': case 'provider-observation': case 'continuation': case 'conversation-agent': case 'create': case 'receipt': case 'reconcile': case 'abandon': case 'watch': return request.scope;
      case 'pull': case 'close': case 'metadata': case 'catalog': case 'search': case 'extension-call': return null;
    }
  }
  function providerCatalog() {
    const statuses = options.providers?.catalog() ?? [];
    const unavailable = statuses.filter((provider): provider is UnavailableProvider => provider.kind === 'unavailable');
    return { unavailable, choices: providerChoices(statuses.filter((provider): provider is DiscoveredProvider => provider.kind === 'available')) };
  }
  function providerChoices(available: readonly DiscoveredProvider[]) {
    return new Map(available.flatMap(provider => provider.agents.map(agent => {
      const installation: ProviderInstallation = { kind: 'provider', contributionId: provider.contributionId,
        instance: provider.instance, agent, presentationVersion: 1, expectedAuthority: provider.expectedAuthority };
      const descriptor = describeProviderAgent(installation, provider.capabilities.create ? { kind: 'ready' }
        : { kind: 'unavailable', reason: 'This provider does not support conversation creation.' }, host.imageInput(installation), provider.capabilities.reconcile ? [
          ...(provider.capabilities.send ? ['send' as const] : []), ...(provider.capabilities.cancel ? ['cancel' as const] : []),
          ...(provider.capabilities.decide ? ['approve' as const] : []),
        ] : [], provider.frontendOffers);
      return [descriptor.id, { installation, descriptor }] as const;
    })));
  }
  function describe(installation: ConversationInstallation, providerAgents: ReturnType<typeof providerChoices>) {
    if ('kind' in installation) {
      const choice = providerAgents.get(describeProviderAgent(installation, { kind: 'ready' }, host.imageInput(installation)).id)?.descriptor;
      if (choice) return choice;
      const status = options.providers?.statusOf(installation);
      return describeProviderAgent(installation, { kind: 'unavailable',
        reason: status?.kind === 'unavailable' ? providerUnavailableReasons[status.cause] : 'This conversation’s provider is no longer configured.' }, host.imageInput(installation));
    }
    return agents().get(canonicalJson(installation)) ?? describeAgent(installation,
      { kind: 'unavailable', reason: 'This conversation’s agent is no longer configured.' }, host.imageInput(installation));
  }
  async function apply(principal: Principal, request: ServiceRequest): Promise<ServiceValueMap[ServiceRequest['op']]> {
    const actor = { id: principal.id, platform: 'desktop' as const,
      authorized: () => !options.isClosing() };
    switch (request.op) {
      case 'output-list': return { scope: request.scope, result: await host.conversationOutputs(request.scope) } satisfies ServiceValueMap['output-list'];
      case 'output-read': {
        const result = await host.readOutput(request.scope, request.outputId);
        return { scope: request.scope, outputId: request.outputId, result: result.kind === 'available'
          ? { kind: result.kind, output: result.output, base64: Buffer.from(result.bytes).toString('base64') } : result } satisfies ServiceValueMap['output-read'];
      }
      case 'frontend-binding': return host.frontendBinding(request, actor, scope => frontendToolsFor(host).producer(scope));
      case 'image-upload': return { scope: request.scope, attachment: host.uploadImage(request.scope, principal.id, request.uploadId, request.name, Buffer.from(request.base64, 'base64')) };
      case 'image-read': {
        const image = host.readImage(request.scope, request.imageId);
        return { scope: request.scope, attachment: image.attachment, base64: Buffer.from(image.bytes).toString('base64') };
      }
      case 'metadata': {
        const { choices: providerAgents, unavailable } = providerCatalog();
        const defaultAgentId = nativeDefault ?? [...providerAgents.values()].reduce<string | null>((selected, { descriptor }) =>
          descriptor.availability.kind === 'ready' && (selected === null || descriptor.id < selected) ? descriptor.id : selected, null);
        return { hostId: principal.hostId, principalId: principal.id, compatibility: options.compatibility, agents: [...[...agents().values()].filter(agent => selectable.has(agent.id)), ...[...providerAgents.values()].map(entry => entry.descriptor), ...unavailable.map(provider => describeUnavailableProvider(provider, host.imageInput(null)))], defaultAgentId,
          extensions: options.extensions?.describe() ?? [] } satisfies ServiceValueMap['metadata'];
      }
      case 'catalog': return host.listConversations(principal.hostId, request.after, request.limit).map(scope => ({
        scope, preview: conversationPreview(host.inspect(scope).snapshot.document.domain),
      })) satisfies ServiceValueMap['catalog'];
      case 'search': return searchConversations(host, { hostId: principal.hostId, query: request.query, after: request.after });
      case 'conversation-permissions': return host.conversationPermissions(request.scope);
      case 'provider-observation': return request.action === 'retry' ? host.retryObservation(request.scope) : host.observationStatus(request.scope);
      case 'continuation': {
        if (request.action !== 'read') {
          // A provider that is not loaded cannot read the saved closure. That is transient, never a refusal.
          const original = host.creation(request.scope);
          if (!options.providers || (original?.observation?.kind === 'confirmed' && options.providers.statusOf(original.installation) === undefined)) {
            throw new ServiceError('unavailable', 'The original provider is unavailable.');
          }
        }
        try { return await host.continuation(request.scope, request.action, options.providers); }
        catch (error) {
          if (error instanceof ContinuationRefused) throw new ServiceError('invalid', 'Only a concluded provider conversation without frontend tool activity can be continued.');
          throw error;
        }
      }
      case 'conversation-agent': {
        const providerAgents = providerCatalog().choices;
        const installation = host.creation(request.scope)?.installation ?? host.installation(request.scope);
        return installation ? describe(installation, providerAgents) : null;
      }
      case 'create': {
        const providerAgents = providerCatalog().choices;
        const original = host.creation(request.scope);
        const provider = original?.installation ?? providerAgents.get(request.agentId)?.installation;
        if (provider) {
          if (describeProviderAgent(provider, { kind: 'ready' }, host.imageInput(provider)).id !== request.agentId) throw new ServiceError('invalid', 'Conversation already belongs to another agent.');
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
          if (describe(existing, providerAgents).id !== request.agentId) throw new ServiceError('invalid', 'Conversation already belongs to another agent.');
          return request.scope;
        }
        const selected = configured.find(entry => entry.selectable !== false && describe(entry.installation, providerAgents).id === request.agentId);
        if (!selected) throw new ServiceError('create-rejected', 'This conversation was not created. Choose an available agent for a new conversation.');
        const descriptor = describe(selected.installation, providerAgents);
        if (descriptor.availability.kind !== 'ready') throw new ServiceError('unavailable', descriptor.availability.reason);
        host.createConversation(request.scope, selected.installation);
        return request.scope satisfies ServiceValueMap['create'];
      }
      case 'submit': return host.conversation(request.command.scope, actor).submit(request.command) satisfies Promise<ServiceValueMap['submit']>;
      case 'receipt': return host.conversation(request.scope, actor).receipt(request.id) satisfies Promise<ServiceValueMap['receipt']>;
      case 'reconcile': return host.reconcile(request.scope, request.id, actor) satisfies Promise<ServiceValueMap['reconcile']>;
      case 'abandon': return host.abandon(request.scope, request.id, actor) satisfies Promise<ServiceValueMap['abandon']>;
      case 'watch': return { feedId: feeds.open(principal.id, host.conversation(request.scope), request) } satisfies ServiceValueMap['watch'];
      case 'pull': return feeds.pull(principal.id, request.feedId, request.ack) satisfies Promise<ServiceValueMap['pull']>;
      case 'close': feeds.close(principal.id, request.feedId); return null satisfies ServiceValueMap['close'];
      case 'extension-call': {
        if (!options.extensions) return { kind: 'failed', cause: 'unknown-extension' } satisfies ServiceValueMap['extension-call'];
        const { op: _op, ...call } = request;
        return options.extensions.call(call).catch((): ExtensionCallValue => ({ kind: 'failed', cause: 'unavailable' }));
      }
    }
  }
  return async (principal: Principal, request: ServiceRequest): Promise<ServiceValueMap[ServiceRequest['op']]> => {
    try {
      if (options.isClosing()) throw new ServiceError('unavailable', 'Host is shutting down');
      const scope = requestScope(request);
      if (scope !== null && scope.hostId !== principal.hostId) throw new ServiceError('forbidden', 'Conversation belongs to another host');
      return await apply(principal, request);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      const imageError = imageFailure(error);
      if (imageError) throw new ServiceError(imageError.code, imageError.message);
      const message = request.op === 'submit' || request.op === 'reconcile'
        ? 'The host could not confirm this operation. Reconcile before retrying.' : 'Host operation failed. Try again.';
      throw new ServiceError('unavailable', message);
    }
  };
}
