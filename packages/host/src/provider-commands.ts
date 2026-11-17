import { aguiInput, assertOfferSuffix } from './agui-input.js';
import { canonicalJson, copyJson, parseRunIdentity, parsePermissionScope } from '@agentui/contracts';
import type { ClientCommand, ConversationScope, Json, RunIdentity, PermissionScope, FrontendOffer, OfferedCommand } from '@agentui/contracts';
import { identifier, record } from '@agentui/contracts/decode';
import type { ConversationRef, ConversationRefKind, ProviderConversation, ProviderInstance } from '@agentui/sdk';
import { creationBinding, providerCreation, providerIdentity } from './provider-creation.js';
import type { ProviderCreation, ProviderInstallation } from './provider-creation.js';
import type { SettlementObservation } from './settlement.js';

export interface ProviderTarget extends Pick<ProviderCreation, 'installation' | 'credential'> {
  readonly kind: 'provider';
  readonly operation: { readonly operationId: string; readonly binding: ProviderConversation<string> } & (
    { readonly kind: 'send'; readonly request: Json; readonly protocol?: 'ag-ui' }
    | { readonly kind: 'revoke-permission'; readonly permission: ConversationRef<string, 'permission'>; readonly scope: PermissionScope }
    | { readonly kind: 'cancel'; readonly run: ConversationRef<string, 'run'> }
    | { readonly kind: 'decide'; readonly run: ConversationRef<string, 'run'>;
      readonly decision: ConversationRef<string, 'decision'>; readonly choice: ConversationRef<string, 'choice'> });
}
export type ProviderAction = { readonly kind: 'send'; readonly text: string; readonly frontend?: FrontendOffer }
  | { readonly kind: 'revoke-permission'; readonly permissionId: string; readonly scope: PermissionScope }
  | { readonly kind: 'cancel'; readonly run: unknown }
  | { readonly kind: 'decide'; readonly run: unknown; readonly decision: unknown; readonly choice: unknown };
export interface ProviderRun {
  readonly kind: 'provider';
  readonly identity: RunIdentity;
  readonly reference: ConversationRef<string, 'run'>;
}
export interface ProviderEvidence {
  readonly source: 'provider-reply' | 'provider-lookup';
  readonly data: Json;
  readonly run: ProviderRun | null;
}
export type ProviderObservation = SettlementObservation<ProviderEvidence>;
export type AguiRunKey = Pick<ReturnType<typeof aguiInput>, 'threadId' | 'runId'>;
export interface ProviderCapture {
  readonly target: ProviderTarget;
  readonly agui: AguiRunKey | null;
}
export type V1Command = Extract<ClientCommand, { readonly version: 1 }>;
export type MatchedProviderCommand =
  | (ProviderCapture & { readonly command: V1Command })
  | (ProviderCapture & { readonly agui: AguiRunKey; readonly command: OfferedCommand });
export function parseProviderCapture(value: unknown, scope: ConversationScope): ProviderCapture {
  const input = record(value, ['kind', 'installation', 'credential', 'operation']);
  const operation = record(input.operation);
  record(operation, ['kind', 'operationId', 'binding', ...(operation.kind === 'revoke-permission' ? ['permission', 'scope'] : operation.kind === 'send' ? ['request', ...(Object.hasOwn(operation, 'protocol') ? ['protocol'] : [])] : operation.kind === 'cancel' ? ['run'] : ['run', 'decision', 'choice'])]);
  const binding = record(operation.binding, ['kind', 'creation', 'authority']);
  const original = providerCreation({ installation: input.installation, credential: input.credential, intent: binding.creation }, scope);
  const operationId = identifier(operation.operationId);
  if (input.kind !== 'provider' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) throw new Error('Invalid provider command');
  const base = { operationId, binding: creationBinding(binding, original.intent, original.installation) };
  const reference = <K extends ConversationRefKind>(value: unknown, kind: K) => providerReference(value, base.binding, original.installation, kind);
  let captured: ProviderTarget['operation'];
  let agui: AguiRunKey | null = null;
  if (operation.kind === 'send') {
    const request = copyJson(operation.request);
    if (Object.hasOwn(operation, 'protocol')) {
      if (operation.protocol !== 'ag-ui') throw new Error('Invalid provider protocol');
      const { threadId, runId } = aguiInput(request);
      agui = { threadId, runId };
      captured = { ...base, kind: 'send', request, protocol: 'ag-ui' };
    } else captured = { ...base, kind: 'send', request };
  } else if (operation.kind === 'revoke-permission') captured = { ...base, kind: 'revoke-permission', permission: reference(operation.permission, 'permission'), scope: parsePermissionScope(operation.scope) };
  else if (operation.kind === 'cancel') captured = { ...base, kind: 'cancel', run: reference(operation.run, 'run') };
  else if (operation.kind === 'decide') captured = { ...base, kind: 'decide', run: reference(operation.run, 'run'),
    decision: reference(operation.decision, 'decision'), choice: reference(operation.choice, 'choice') };
  else throw new Error('Invalid provider command');
  return { target: { kind: 'provider', installation: original.installation, credential: original.credential, operation: captured }, agui };
}
export function matchProviderCommand(capture: ProviderCapture, command: ClientCommand): MatchedProviderCommand {
  const operation = capture.target.operation, body = command.body;
  if (command.version === 2) {
    if (operation.kind !== 'send' || capture.agui === null) throw new Error('Invalid offered command target');
    assertOfferSuffix(operation.request, command.body.frontend);
    return { target: capture.target, agui: capture.agui, command };
  }
  if ((body.kind === 'revoke-permission' && operation.kind === 'revoke-permission' && body.permissionId === operation.permission.ref.opaqueId && body.scope === operation.scope) ||
    (body.kind === 'send' && operation.kind === 'send') ||
    (body.kind === 'cancel' && operation.kind === 'cancel' && body.runId === operation.run.ref.opaqueId) ||
    (body.kind === 'approve' && operation.kind === 'decide' && body.pendingId === operation.decision.ref.opaqueId && body.choiceId === operation.choice.ref.opaqueId)) return { ...capture, command };
  throw new Error('Invalid provider command association');
}
export function providerReference<I extends string, K extends ConversationRefKind>(value: unknown,
  original: ProviderConversation<I>, selected: ProviderInstallation, kind: K, instance: ProviderInstance<I> = original.creation.agent.instance): ConversationRef<I, K> {
  const input = record(value, ['binding', 'ref']), ref = record(input.ref, ['kind', 'instance', 'opaqueId']);
  const binding = creationBinding(input.binding, original.creation, selected);
  if (canonicalJson(binding) !== canonicalJson(original) || ref.kind !== kind ||
    canonicalJson(providerIdentity(ref.instance)) !== canonicalJson(selected.instance) || canonicalJson(instance) !== canonicalJson(selected.instance)) throw new Error('Foreign provider reference');
  return { binding, ref: { kind, instance, opaqueId: identifier(ref.opaqueId) } };
}
export function providerRun(value: unknown, binding: ProviderConversation<string>, selected: ProviderInstallation): ProviderRun {
  const reference = providerReference(value, binding, selected, 'run');
  return { kind: 'provider', identity: parseRunIdentity({ conversation: binding.creation.scope,
    runId: reference.ref.opaqueId, authority: binding.authority }), reference };
}
export function providerObservation(value: unknown, capture: ProviderCapture): ProviderObservation {
  const { target, agui } = capture;
  const input = record(value);
  if (input.kind === 'outcome-unknown') { record(input, ['kind']); return { kind: 'outcome-unknown' }; }
  if (input.kind === 'not-dispatched') { record(input, ['kind', 'reason']); return { kind: 'not-dispatched', reason: identifier(input.reason) }; }
  record(input, input.kind === 'conclusive' ? ['kind', 'evidence', 'result'] : ['kind', 'evidence']);
  const evidence = record(input.evidence, ['correlation', 'operation', 'source']);
  const source = record(evidence.source, ['source', 'data', 'run']);
  if (evidence.correlation !== canonicalJson(target) || (source.source !== 'provider-reply' && source.source !== 'provider-lookup')) throw new Error('Foreign provider evidence');
  const data = copyJson(source.data);
  if (Buffer.byteLength(canonicalJson(data)) > 64_000) throw new Error('Provider evidence exceeds limit');
  let run: ProviderRun | null = null;
  if (source.run !== null) {
    if (target.operation.kind !== 'send') throw new Error('Unexpected provider run output');
    const stored = record(source.run, ['kind', 'identity', 'reference']);
    run = providerRun(stored.reference, target.operation.binding, target.installation);
    if ((agui !== null && run.identity.runId !== agui.runId) || canonicalJson(stored) !== canonicalJson(run)) throw new Error('Foreign provider run identity');
  }
  const parsed = { correlation: canonicalJson(target), operation: run ? { namespace: target.installation.instance.namespace, id: canonicalJson(run.reference) } : null,
    source: { source: source.source, data, run } } satisfies Extract<ProviderObservation, { kind: 'pending' }>['evidence'];
  if (canonicalJson(evidence.operation) !== canonicalJson(parsed.operation)) throw new Error('Foreign provider operation');
  if (input.kind === 'pending' && run === null) return { kind: 'pending', evidence: parsed };
  const confirmed = target.operation.kind !== 'send' || run !== null;
  if (input.kind === 'accepted' && confirmed) return { kind: 'accepted', evidence: parsed };
  if (input.kind !== 'conclusive') throw new Error('Invalid provider observation');
  const result = record(input.result);
  if (result.kind === 'receipt-completed' && confirmed) { record(result, ['kind']); return { kind: 'conclusive', evidence: parsed, result: { kind: 'receipt-completed' } }; }
  if (result.kind === 'rejected') { record(result, ['kind', 'reason']); return { kind: 'conclusive', evidence: parsed, result: { kind: 'rejected', reason: identifier(result.reason) } }; }
  throw new Error('Invalid provider result');
}
export function providerOutcome(value: unknown, capture: ProviderCapture, fresh: boolean): ProviderObservation {
  const { target } = capture;
  const input = record(copyJson(value));
  const source: ProviderEvidence['source'] = fresh ? 'provider-reply' : 'provider-lookup';
  let run: ProviderRun | null = null;
  let kind: 'pending' | 'accepted' | 'conclusive';
  let result: { kind: 'receipt-completed' } | { kind: 'rejected'; reason: string } | undefined;
  if (input.kind === 'confirmed') {
    record(input, ['kind', 'value', 'evidence']);
    const effect = record(input.value, target.operation.kind === 'send' ? ['kind', 'run', 'state'] : ['kind', 'state']);
    if (effect.kind !== target.operation.kind || (effect.state !== 'accepted' && effect.state !== 'completed')) throw new Error('Invalid provider effect');
    if (target.operation.kind === 'revoke-permission' && effect.state !== 'completed') throw new Error('Invalid permission effect');
    if (target.operation.kind === 'send') run = providerRun(effect.run, target.operation.binding, target.installation);
    kind = effect.state === 'accepted' ? 'accepted' : 'conclusive';
    if (kind === 'conclusive') result = { kind: 'receipt-completed' };
  } else if (input.kind === 'pending') { record(input, ['kind', 'evidence']); kind = 'pending'; }
  else if (input.kind === 'rejected') {
    record(input, ['kind', 'reason', 'evidence']); identifier(input.reason);
    kind = 'conclusive'; result = { kind: 'rejected', reason: 'provider-rejected' };
  } else {
    record(input, input.kind === 'uncertain' ? ['kind', 'reason', 'evidence'] : ['kind', 'reason']);
    identifier(input.reason);
    const refused = ['not-dispatched', 'unsupported', 'unavailable', 'authentication-failed', 'unauthorized', 'version-unsupported'].includes(String(input.kind));
    return refused && fresh ? { kind: 'not-dispatched', reason: `provider-${String(input.kind)}` } : { kind: 'outcome-unknown' };
  }
  return providerObservation({ kind, ...(result ? { result } : {}), evidence: {
    correlation: canonicalJson(target), operation: run ? { namespace: target.installation.instance.namespace, id: canonicalJson(run.reference) } : null,
    source: { source, data: input.evidence, run },
  } }, capture);
}

export function retainProviderRun(incoming: ProviderObservation, previous: ProviderObservation | null): ProviderObservation {
  if (incoming.kind !== 'conclusive' || incoming.result.kind !== 'rejected' || incoming.evidence.source.run !== null ||
    (previous?.kind !== 'accepted' && previous?.kind !== 'conclusive')) return incoming;
  return { ...incoming, evidence: { ...incoming.evidence, operation: previous.evidence.operation,
    source: { ...incoming.evidence.source, run: previous.evidence.source.run } } };
}
