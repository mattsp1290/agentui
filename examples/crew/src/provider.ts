import { z } from 'zod';
import { CrewClient, CrewHttpError } from '@birbcrew/client';
import { canonicalJson } from '@agentui/contracts';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { BackendProvider, ConnectedProvider, CreationIntent, ProviderCommand, ProviderCommandEffect,
  ProviderConversation, ProviderInstance, ProviderOutcome, ServerExtensionEntry, ExtensionManifest } from '@agentui/sdk';
import { bindingSchema, choiceSchema, decisionKey, presentation, reference } from './provider-model.js';
import type { CrewModel } from './provider-model.js';
import { observation } from './provider-observation.js';

export interface CrewProviderOptions {
  readonly service: string;
  readonly memberId: string;
  readonly instance: ProviderInstance<string>;
}
const uncertain = () => ({ kind: 'uncertain', reason: 'Crew outcome is unresolved. Recover the original operation.', evidence: null } as const);
const unavailable = () => ({ kind: 'unavailable', reason: 'Crew is unavailable or authorization was refused.' } as const);
function negative(error: unknown): ReturnType<typeof uncertain> | { kind: 'rejected'; reason: string; evidence: null } {
  if (error instanceof CrewHttpError && [400, 401, 403, 422].includes(error.status)) {
    return { kind: 'rejected', reason: 'Crew refused this operation.', evidence: null };
  }
  return uncertain();
}
export function crewProvider(options: CrewProviderOptions): { manifest: ExtensionManifest; entry: ServerExtensionEntry } {
  const service = new URL(options.service);
  if (!['http:', 'https:'].includes(service.protocol) || service.username || service.password || service.pathname !== '/' ||
    service.search || service.hash) throw new Error('Crew requires a service origin');
  if (options.instance.protocolVersion !== '1') throw new Error('Unsupported Crew protocol version');
  const memberId = z.uuid().parse(options.memberId), instance = Object.freeze({ ...options.instance });
  const manifest: ExtensionManifest = { namespace: instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION,
    entries: [{ kind: 'server', module: './provider.js' }] };
  const entry: ServerExtensionEntry = { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, activate(context) {
    const provider: BackendProvider<CrewModel, string> = { apiVersion: 1, async connect(request) {
      if (request.apiVersion !== 1 || canonicalJson(request.instance) !== canonicalJson(instance) || !request.credential ||
        canonicalJson(request.credential.instance) !== canonicalJson(instance)) return unavailable();
      const credential = request.credential;
      let closed = false;
      const observations = new Map<string, ReturnType<typeof observation>>();
      const use = <T>(action: (client: CrewClient, token: string) => Promise<T>): Promise<T> => {
        if (closed) return Promise.reject(new Error('Crew provider closed'));
        return context.credentials.use({ credential, service: service.origin }, token => action(new CrewClient({ baseUrl: service.origin, token }), token));
      };
      const call = <T>(action: (client: CrewClient) => Promise<ProviderOutcome<T>>, fresh: boolean): Promise<ProviderOutcome<T>> =>
        use(async client => { try { return await action(client); } catch (error) { return fresh ? negative(error) : uncertain(); } }).catch(() => uncertain());
      function creation(operation: CreationIntent<string>): ProviderConversation<string> {
        if (operation.agent.opaqueId !== memberId || operation.agent.kind !== 'agent' ||
          canonicalJson(operation.agent.instance) !== canonicalJson(instance)) throw new Error('Foreign Crew member');
        return bindingSchema.parse({ kind: 'agentui-created', creation: operation, authority: { kind: 'remote-provider',
          binding: { namespace: instance.namespace, installationId: instance.installationId, opaqueSessionId: operation.operationId } } });
      }
      function validate(binding: ProviderConversation<string>) {
        if (canonicalJson(binding) !== canonicalJson(creation(binding.creation))) throw new Error('Foreign Crew conversation');
      }
      const confirm = async (operation: CreationIntent<string>, fresh: boolean): Promise<ProviderOutcome<ProviderConversation<string>>> => {
        const binding = creation(operation);
        return call(async client => {
          const remote = fresh ? await client.openConversation({ conversationId: operation.operationId, memberId }, { signal: AbortSignal.timeout(15000) })
            : await client.conversation({ conversationId: operation.operationId }, { signal: AbortSignal.timeout(10000) });
          if (remote.memberId !== memberId || remote.conversationId !== operation.operationId) return uncertain();
          return { kind: 'confirmed', value: binding, evidence: { conversationId: remote.conversationId, memberId } };
        }, fresh);
      };
      const command = async (operation: ProviderCommand<CrewModel, string>, fresh: boolean): Promise<ProviderOutcome<ProviderCommandEffect<string>>> => {
        validate(operation.binding);
        const conversationId = operation.binding.authority.binding.opaqueSessionId;
        return call<ProviderCommandEffect<string>>(async client => {
          if (operation.kind === 'decide') {
            if (canonicalJson(operation.decision.binding) !== canonicalJson(operation.binding) ||
              canonicalJson(operation.choice.binding) !== canonicalJson(operation.binding) ||
              canonicalJson(operation.decision.ref.instance) !== canonicalJson(instance) ||
              canonicalJson(operation.choice.ref.instance) !== canonicalJson(instance)) throw new Error('Foreign Crew decision');
            const [requestId, invocationId, approvalId, version] = decisionKey.parse(JSON.parse(operation.decision.ref.opaqueId));
            const [key, choice] = z.tuple([z.string(), choiceSchema]).parse(JSON.parse(operation.choice.ref.opaqueId));
            if (key !== operation.decision.ref.opaqueId) throw new Error('Foreign Crew choice');
            if (!fresh) { await client.requestStatus({ conversationId, requestId }, { signal: AbortSignal.timeout(10000) }); return uncertain(); }
            const receipt = await client.decide({ conversationId, memberId, requestId, invocationId, approvalId, version, choice },
              { signal: AbortSignal.timeout(15000) });
            if (receipt.approvalId !== approvalId || receipt.decision !== choice) return uncertain();
            return { kind: 'confirmed', value: { kind: 'decide', state: 'accepted' }, evidence: { approvalId, choice } };
          }
          const requestId = operation.kind === 'send' ? z.uuid().parse(operation.operationId) : z.uuid().parse(operation.run.ref.opaqueId);
          if (operation.kind === 'cancel' && (canonicalJson(operation.run.binding) !== canonicalJson(operation.binding) ||
            canonicalJson(operation.run.ref.instance) !== canonicalJson(instance))) throw new Error('Foreign Crew run');
          const key = { conversationId, requestId }, timeout = { signal: AbortSignal.timeout(15000) };
          const receipt = !fresh ? await client.requestStatus(key, timeout) : operation.kind === 'send'
            ? await client.submit({ ...key, text: operation.request.text }, timeout) : await client.cancel(key, timeout);
          if (operation.kind === 'cancel') {
            if (!receipt.cancellation) return uncertain();
            return { kind: 'confirmed', value: { kind: 'cancel', state: receipt.cancellation.nativeTermination === 'confirmed' ? 'completed' : 'accepted' },
              evidence: { requestId, receiptId: receipt.cancellation.receiptId, nativeTermination: receipt.cancellation.nativeTermination } };
          }
          return { kind: 'confirmed', value: { kind: 'send', run: reference(operation.binding, 'run', requestId),
            state: ['completed', 'failed', 'cancelled'].includes(receipt.status) ? 'completed' : 'accepted' },
            evidence: { requestId, status: receipt.status } };
        }, fresh);
      };
      function source(binding: ProviderConversation<string>, after: CrewModel['cursor'] | null) {
        validate(binding);
        const id = binding.authority.binding.opaqueSessionId;
        let current = observations.get(id);
        if (!current) {
          current = observation(binding, memberId, use, service.origin, after);
          observations.set(id, current);
          const captured = current;
          void current.ended.then(() => { if (observations.get(id) === captured) observations.delete(id); });
        }
        return current;
      }
      try { await use(async client => { await client.capabilities({ signal: AbortSignal.timeout(10000) }); }); }
      catch { return unavailable(); }
      const backend: ConnectedProvider<CrewModel, string> = { instance,
        capabilities: { create: { kind: 'supported' }, send: { kind: 'supported' }, cancel: { kind: 'supported' },
          decide: { kind: 'supported' }, reconcile: { kind: 'supported' }, observe: { kind: 'supported' } },
        async discover() {
          try { return await use(async client => {
            let after: string | undefined;
            const seen = new Set<string>();
            do {
              const page = await client.listMembers(after ? { after } : {}, { signal: AbortSignal.timeout(10000) });
              const member = page.members.find(member => member.memberId === memberId);
              if (member) return { kind: 'available', agents: [{ ref: { instance, kind: 'agent', opaqueId: memberId },
                name: `Crew · ${member.engine} · ${member.profile}` }] } as const;
              if (!page.next) break;
              if (seen.has(page.next) || seen.size >= 100) throw new Error('Invalid Crew member pagination');
              seen.add(page.next); after = page.next;
            } while (after);
            return { kind: 'unauthorized', reason: 'Configured Crew member is not available to this owner.' } as const;
          }); } catch { return unavailable(); }
        },
        create: operation => confirm(operation, true), reconcileCreation: operation => confirm(operation, false),
        submit: operation => command(operation, true), reconcileCommand: operation => command(operation, false),
        async snapshot(binding) {
          try { return { kind: 'available', snapshot: await source(binding, null).ready }; }
          catch { return unavailable(); }
        },
        observe({ binding, after }, receive) {
          if (after && canonicalJson(after.binding) !== canonicalJson(binding)) throw new Error('Foreign Crew cursor');
          const active = source(binding, after?.opaque ?? null);
          active.attach(receive);
          return active;
        },
        async close() { closed = true; const active = [...observations.values()]; active.forEach(item => item.close());
          await Promise.all(active.map(item => item.ended)); observations.clear(); },
      };
      return { kind: 'connected', backend };
    } };
    context.providers.add('member', provider, presentation(instance));
    return { dispose() {} };
  } };
  return { manifest, entry };
}
