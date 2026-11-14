import type { ConversationScope } from '@agentui/contracts';
import type { HostCompatibility } from '@agentui/contracts/compatibility';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import type { ServiceRequest, ServiceValueMap } from '@agentui/contracts/service';
import type { LocalHost } from '@agentui/host';
import { recordedInstallation } from '@agentui/host/recorded';
import type { Access, CredentialClass, Principal } from './access.js';
import { HostFailure } from './errors.js';
import type { FeedRegistry } from './feed-registry.js';

type Request = Exclude<ServiceRequest, { op: 'pair' }>;
export function createApi(options: {
  readonly access: Access; readonly host: LocalHost<TranscriptEvent, Transcript>;
  readonly compatibility: HostCompatibility; readonly feeds: FeedRegistry;
  readonly credentialClass: CredentialClass; readonly isClosing: () => boolean;
}) {
  const { access, host, feeds } = options;
  function requestScope(request: Request): ConversationScope | null {
    switch (request.op) {
      case 'submit': return request.command.scope;
      case 'create': case 'receipt': case 'reconcile': case 'watch': return request.scope;
      case 'pull': case 'close': case 'metadata': case 'catalog': return null;
    }
  }
  async function apply(principal: Principal, request: Request): Promise<ServiceValueMap[Request['op']]> {
    switch (request.op) {
      case 'metadata': return { hostId: principal.hostId, principalId: principal.id, compatibility: options.compatibility } satisfies ServiceValueMap['metadata'];
      case 'catalog': return host.listConversations(principal.hostId, request.after, request.limit) satisfies ServiceValueMap['catalog'];
      case 'create': host.createConversation(request.scope, recordedInstallation); return request.scope satisfies ServiceValueMap['create'];
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
      if (options.isClosing()) throw new HostFailure('unavailable', 'Host is shutting down');
      if (!access.authorized(principal, options.credentialClass)) throw new HostFailure('unauthorized', 'Device access was revoked');
      const scope = requestScope(request);
      if (scope !== null && scope.hostId !== principal.hostId) throw new HostFailure('forbidden', 'Conversation belongs to another host');
      const value = await apply(principal, request);
      if (!access.authorized(principal, options.credentialClass)) throw new HostFailure('unauthorized', 'Device access was revoked');
      return value;
    } catch (error) {
      if (error instanceof HostFailure) throw error;
      throw new HostFailure('unavailable', 'The host could not confirm this operation. Reconcile before retrying.');
    }
  };
}
