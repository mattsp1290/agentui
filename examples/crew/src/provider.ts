import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { CrewClient, CrewHttpError, CrewProtocolError, CrewUnknownOutcomeError, type Capabilities, type HandoffRecord } from '@birbcrew/client';
import { standingGrantsCapabilityV1Schema } from '@birbcrew/client/contract';
import { canonicalJson } from '@agentui/contracts';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { BackendProvider, ConnectedProvider, ContinuationRefusal, CreationIntent, ProviderCommand, ProviderCommandEffect,
  ProviderConversation, ProviderInstance, ProviderOutcome, ProviderPermissions, ServerExtensionEntry, ExtensionManifest } from '@agentui/sdk';
import { bindingSchema, choiceSchema, decisionKey, presentation, reference, runOutcome } from './provider-model.js';
import type { CrewModel } from './provider-model.js';
import { observation } from './provider-observation.js';

export interface CrewProviderOptions {
  readonly service: string;
  readonly memberId: string;
  readonly instance: ProviderInstance<string>;
}
const uncertain = () => ({ kind: 'uncertain', reason: 'Crew outcome is unresolved. Recover the original operation.', evidence: null } as const);
const unavailable = () => ({ kind: 'unavailable', reason: 'Crew is unavailable.' } as const);
type CrewError = 'credential' | 'forbidden' | 'invalid-request' | 'unsupported' | 'transient';
function classify(error: unknown): CrewError {
  if (error instanceof CrewProtocolError) return 'unsupported';
  if (!(error instanceof CrewHttpError)) return 'transient';
  switch (error.status) {
    case 401: return 'credential';
    case 403: return 'forbidden';
    case 400: case 422: return 'invalid-request';
    case 408: case 429: return 'transient';
  }
  return error.status >= 400 && error.status < 500 ? 'unsupported' : 'transient';
}
type Failure = { readonly kind: 'unavailable' | 'authentication-failed' | 'unauthorized' | 'version-unsupported'; readonly reason: string };
function failure(error: unknown): Failure {
  switch (classify(error)) {
    case 'credential': return { kind: 'authentication-failed', reason: 'Crew rejected the credential.' };
    case 'forbidden': return { kind: 'unauthorized', reason: 'Crew refused access for this credential.' };
    case 'invalid-request': case 'unsupported': return { kind: 'version-unsupported', reason: 'Crew does not support this request.' };
    case 'transient': return { kind: 'unavailable', reason: 'Crew is offline or unreachable.' };
  }
}
const handoffRefusals = ['handed_off', 'handoff_pending'];
function negative(error: unknown, submit: boolean): ReturnType<typeof uncertain> | { kind: 'rejected'; reason: string; evidence: null } {
  const kind = classify(error);
  return kind === 'credential' || kind === 'forbidden' || kind === 'invalid-request' ||
    (submit && error instanceof CrewHttpError && error.status === 409 && handoffRefusals.includes(error.code))
    ? { kind: 'rejected', reason: 'Crew refused this operation.', evidence: null } : uncertain();
}
const continuationRefusals = new Map<string, ContinuationRefusal>([['busy', 'busy'], ['usage_limit', 'limit'], ['memory_limit', 'limit'],
  ['instructions_limit', 'limit'], ['handed_off', 'continued-elsewhere'], ['handoff_empty', 'unavailable'], ['handoff_too_large', 'unavailable'],
  ['history_unavailable', 'unavailable'], ['trusted_conversation', 'unavailable'], ['conflict', 'unavailable']]);
const refused = (refusal: ContinuationRefusal, code: string) =>
  ({ kind: 'rejected', reason: 'Crew refused the continuation.', evidence: { refused: refusal, code } } as const);
// Only these refusals write nothing on Crew; any other answer may follow its commit.
function handoffRefusal(error: unknown): ReturnType<typeof refused> | null {
  if (!(error instanceof CrewHttpError)) return null;
  const refusal = error.status === 409 ? continuationRefusals.get(error.code) : [400, 401, 403, 404].includes(error.status) ? 'unavailable' : undefined;
  return refusal ? refused(refusal, error.code) : null;
}
// Crew re-drives an unadmitted first request when the same handoff is posted again after one of these answers.
const redrivable = (error: unknown) => error instanceof CrewUnknownOutcomeError && error.cause instanceof CrewHttpError &&
  ((error.cause.status === 503 && error.cause.code === 'retry_same_request') || (error.cause.status === 409 && error.cause.code === 'update_rejected'));
type Posted = { readonly record: HandoffRecord } | { readonly error: unknown };
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
      if (request.apiVersion !== 1) return { kind: 'version-unsupported', reason: 'Unsupported provider contract.' };
      if (!request.credential || canonicalJson(request.instance) !== canonicalJson(instance) ||
        canonicalJson(request.credential.instance) !== canonicalJson(instance)) throw new Error('Crew installation is misconfigured');
      const credential = request.credential;
      let capabilities: Capabilities;
      let closed = false;
      const observations = new Map<string, ReturnType<typeof observation>>();
      const use = <T>(action: (client: CrewClient, token: string) => Promise<T>): Promise<T> => {
        if (closed) return Promise.reject(new Error('Crew provider closed'));
        return context.credentials.use({ credential, service: service.origin }, token => action(new CrewClient({ baseUrl: service.origin, token }), token));
      };
      const call = <T>(action: (client: CrewClient) => Promise<ProviderOutcome<T>>, fresh: boolean, submit = false): Promise<ProviderOutcome<T>> =>
        use(async client => { try { return await action(client); } catch (error) { return fresh ? negative(error, submit) : uncertain(); } }).catch(() => uncertain());
      function member(operation: CreationIntent<string>) {
        if (operation.agent.opaqueId !== memberId || operation.agent.kind !== 'agent' ||
          canonicalJson(operation.agent.instance) !== canonicalJson(instance)) throw new Error('Foreign Crew member');
      }
      function predecessor(from: NonNullable<CreationIntent<string>['from']>): string {
        if (from.binding.namespace !== instance.namespace || from.binding.installationId !== instance.installationId) throw new Error('Foreign Crew predecessor');
        return from.binding.opaqueSessionId;
      }
      // A successor's session is the target Crew drew, so only confirm() can supply it; everything else derives from the intent.
      function creation(operation: CreationIntent<string>, target = operation.operationId): ProviderConversation<string> {
        member(operation);
        if (operation.from) {
          const source = predecessor(operation.from);
          if (target === operation.operationId || target === source) throw new Error('Foreign Crew predecessor');
        }
        return bindingSchema.parse({ kind: 'agentui-created', creation: operation, authority: { kind: 'remote-provider',
          binding: { namespace: instance.namespace, installationId: instance.installationId, opaqueSessionId: target } } });
      }
      function validate(binding: ProviderConversation<string>) {
        const target = binding.creation.from && binding.authority.binding.opaqueSessionId;
        if (canonicalJson(binding) !== canonicalJson(creation(binding.creation, target))) throw new Error('Foreign Crew conversation');
      }
      function settle(operation: CreationIntent<string>, source: string, record: HandoffRecord | null): ProviderOutcome<ProviderConversation<string>> {
        if (!record || record.source.conversationId !== source) return uncertain();
        if (record.requestId !== operation.operationId) return refused('continued-elsewhere', 'handed_off');
        if (record.target.memberId !== memberId) return uncertain();
        const evidence = { handoffId: record.handoffId, firstRequestId: record.firstRequestId, carriedTurns: record.carriedTurns,
          omittedTurns: record.omittedTurns, uncertainTurns: record.uncertainTurns, transcriptBytes: record.transcriptBytes };
        return record.firstRequestAdmitted ? { kind: 'confirmed', value: creation(operation, record.target.conversationId), evidence }
          : { kind: 'pending', evidence };
      }
      // One credential use per POST, so a closed authority or a withdrawn credential refuses the next POST and ends the repeat.
      const post = (operation: CreationIntent<string>, source: string): Promise<Posted> => use<Posted>(async client => {
        try {
          return { record: await client.createHandoff({ conversationId: source, requestId: operation.operationId, memberId },
            { signal: AbortSignal.timeout(15000) }) };
        } catch (error) { return { error }; }
      });
      // Only the first create() posts. Lookups and every later call read the source's outgoing handoff.
      const handoff = async (operation: CreationIntent<string>, source: string, fresh: boolean): Promise<ProviderOutcome<ProviderConversation<string>>> => {
        if (!fresh) {
          return use(async client => settle(operation, source,
            (await client.handoff({ conversationId: source }, { signal: AbortSignal.timeout(10000) })).outgoing)).catch(() => uncertain());
        }
        let committed: HandoffRecord | undefined, unresolved = false;
        try {
          for (let attempt = 1; ; attempt++) {
            const posted = await post(operation, source);
            if ('record' in posted) {
              committed = posted.record;
              if (committed.firstRequestAdmitted) break;
            } else if (redrivable(posted.error)) unresolved = true;
            else if (committed) break;
            // After an unknown outcome only a 409 proves the earlier POST wrote nothing: Crew raises those after its requestId lookup.
            else return (!unresolved || (posted.error instanceof CrewHttpError && posted.error.status === 409) ? handoffRefusal(posted.error) : null) ?? uncertain();
            if (attempt === 3) break;
            await delay(5000);
          }
          return committed ? settle(operation, source, committed) : uncertain();
        } catch { return uncertain(); }
      };
      const confirm = async (operation: CreationIntent<string>, fresh: boolean): Promise<ProviderOutcome<ProviderConversation<string>>> => {
        if (operation.from) {
          member(operation);
          return handoff(operation, predecessor(operation.from), fresh);
        }
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
            return { kind: 'confirmed', value: { kind: 'decide', state: 'completed' }, evidence: { approvalId, choice } };
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
            state: runOutcome(receipt) ? 'completed' : 'accepted' },
            evidence: { requestId, status: receipt.status, ...(receipt.cancellation && { cancellation: receipt.cancellation }) } };
        }, fresh, operation.kind === 'send');
      };
      function source(binding: ProviderConversation<string>, after: CrewModel['cursor'] | null) {
        validate(binding);
        const id = binding.authority.binding.opaqueSessionId;
        let current = observations.get(id);
        if (!current) {
          current = observation(binding, memberId, use, service.origin, after,
            capabilities.approvalDetails?.version === 1 && capabilities.approvalDetails.tools.includes('record_work_item'), supportsStanding);
          observations.set(id, current);
          const captured = current;
          void current.ended.then(() => { if (observations.get(id) === captured) observations.delete(id); });
        }
        return current;
      }
      const probe = await use(async client => {
        try { return { kind: 'available', capabilities: await client.capabilities({ signal: AbortSignal.timeout(10000) }) } as const; }
        catch (error) { return failure(error); }
      });
      if (probe.kind !== 'available') return probe;
      capabilities = probe.capabilities;
      const standing = standingGrantsCapabilityV1Schema.safeParse(capabilities.standingGrants);
      const supportsStanding = standing.success && standing.data.choices.includes('allow_conversation') &&
        standing.data.tools.includes('record_work_item') && standing.data.initiatorKinds.includes('owner');
      const grants = async (client: CrewClient, binding: ProviderConversation<string>) => {
        validate(binding);
        const list = await client.listGrants({ memberId }, { signal: AbortSignal.timeout(10000) });
        return list.active.filter(grant => grant.toolName === 'record_work_item' && grant.policyVersion === 1 &&
          (grant.scope === 'member' || grant.conversationId === binding.authority.binding.opaqueSessionId));
      };
      const permissions: ProviderPermissions<string> = {
        async read(binding) {
          try { return await use(async client => ({ kind: 'available', permissions: (await grants(client, binding)).map(grant => ({
            ref: reference(binding, 'permission', grant.grantId), scope: grant.scope === 'member' ? 'agent' : 'conversation',
            actionLabel: 'Record work items', detail: grant.scope === 'member'
              ? 'This Crew member can record owner-initiated work items in all conversations.'
              : 'This Crew member can record owner-initiated work items in this conversation.',
          })) })); } catch { return unavailable(); }
        },
        async revoke(operation) {
          validate(operation.binding);
          if (canonicalJson(operation.permission.binding) !== canonicalJson(operation.binding) ||
            canonicalJson(operation.permission.ref.instance) !== canonicalJson(instance) || operation.permission.ref.kind !== 'permission') {
            return { kind: 'rejected', reason: 'Foreign Crew permission.', evidence: null };
          }
          return call(async client => {
            const grantId = z.uuid().parse(operation.permission.ref.opaqueId);
            const grant = (await grants(client, operation.binding)).find(row => row.grantId === grantId);
            if (!grant || operation.scope !== (grant.scope === 'member' ? 'agent' : 'conversation')) {
              return { kind: 'rejected', reason: 'Refresh permissions and confirm the active permission’s scope.', evidence: null };
            }
            const { grant: revoked } = await client.revokeGrant({ memberId, grantId }, { signal: AbortSignal.timeout(15000) });
            if (revoked.grantId !== grantId || revoked.memberId !== memberId || revoked.scope !== grant.scope ||
              revoked.conversationId !== grant.conversationId || revoked.status !== 'revoked') return uncertain();
            return { kind: 'confirmed', value: { kind: 'revoke-permission', state: 'completed' }, evidence: { grantId } };
          }, true);
        },
        async reconcileRevoke(operation) {
          validate(operation.binding);
          return uncertain();
        },
      };
      const backend: ConnectedProvider<CrewModel, string> = { instance, ...(supportsStanding && { permissions }),
        capabilities: { create: { kind: 'supported' }, send: { kind: 'supported' }, cancel: { kind: 'supported' },
          decide: { kind: 'supported' }, reconcile: { kind: 'supported' }, observe: { kind: 'supported' } },
        async discover() {
          const found = await use(async client => {
            try {
              let after: string | undefined;
              const seen = new Set<string>();
              do {
                const page = await client.listMembers(after ? { after } : {}, { signal: AbortSignal.timeout(10000) });
                const member = page.members.find(member => member.memberId === memberId);
                if (member) return { kind: 'available', agents: [{ ref: { instance, kind: 'agent', opaqueId: memberId },
                  name: `Crew · ${member.engine} · ${member.profile}` }] } as const;
                if (!page.next) return null;
                if (seen.has(page.next) || seen.size >= 100) return { kind: 'version-unsupported', reason: 'Crew returned invalid member pagination.' } as const;
                seen.add(page.next); after = page.next;
              } while (after);
              return null;
            } catch (error) { return failure(error); }
          });
          if (!found) throw new Error('Configured Crew member is not available');
          return found;
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
