import type { ConversationScope } from '@agentui/contracts';
import type { HostCompatibility } from '@agentui/contracts/compatibility';
import { conversationPreview } from '@agentui/contracts/conversation';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import type { ServiceRequest, ServiceValueMap } from '@agentui/contracts/service';
import type { Installation, LocalHost } from '@agentui/host';
import { recordedInstallation } from '@agentui/host/recorded';
import type { Access, CredentialClass, Principal } from './access.js';
import { ServiceError } from '@agentui/contracts/service';
import type { FeedRegistry } from './feed-registry.js';
import { searchConversations } from './conversation-search.js';

type Request = Exclude<ServiceRequest, { op: 'pair' }>;
export function createApi(options: {
  readonly access: Access; readonly host: LocalHost<TranscriptEvent, Transcript>;
  readonly compatibility: HostCompatibility; readonly feeds: FeedRegistry;
  readonly installation?: Installation;
  readonly credentialClass: CredentialClass; readonly isClosing: () => boolean;
}) {
  const { access, host, feeds } = options;
  function requestScope(request: Request): ConversationScope | null {
    switch (request.op) {
      case 'submit': return request.command.scope;
      case 'create': case 'receipt': case 'reconcile': case 'watch': return request.scope;
      case 'pull': case 'close': case 'metadata': case 'catalog': case 'search': return null;
    }
  }
  async function apply(principal: Principal, request: Request): Promise<ServiceValueMap[Request['op']]> {
    switch (request.op) {
      case 'metadata': return { hostId: principal.hostId, principalId: principal.id, compatibility: options.compatibility } satisfies ServiceValueMap['metadata'];
      case 'catalog': return host.listConversations(principal.hostId, request.after, request.limit).map(scope => ({
        scope, preview: conversationPreview(host.inspect(scope).snapshot.document.domain),
      })) satisfies ServiceValueMap['catalog'];
      case 'search': return searchConversations(host, { hostId: principal.hostId, query: request.query, after: request.after });
      case 'create': host.createConversation(request.scope, options.installation ?? recordedInstallation); return request.scope satisfies ServiceValueMap['create'];
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
