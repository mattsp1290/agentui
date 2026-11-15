import { canonicalJson, copyJson, parseRunIdentity } from '@agentui/contracts';
import type { ConversationScope, Json, RunIdentity } from '@agentui/contracts';
import { identifier, record } from '@agentui/contracts/decode';
import type { ConversationRef, ProviderConversation } from '@agentui/sdk';
import { creationBinding, providerCreation, providerIdentity } from './provider-creation.js';
import type { ProviderCreation } from './provider-creation.js';
import type { SettlementObservation } from './settlement.js';

export interface ProviderTarget extends Pick<ProviderCreation, 'installation' | 'credential'> {
  readonly kind: 'provider';
  readonly operation: { readonly kind: 'send'; readonly operationId: string;
    readonly binding: ProviderConversation<string>; readonly request: Json };
}
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
export function providerTarget(value: unknown, scope: ConversationScope): ProviderTarget {
  const input = record(value, ['kind', 'installation', 'credential', 'operation']);
  const operation = record(input.operation, ['kind', 'operationId', 'binding', 'request']);
  const binding = record(operation.binding, ['kind', 'creation', 'authority']);
  const original = providerCreation({ installation: input.installation, credential: input.credential, intent: binding.creation }, scope);
  const operationId = identifier(operation.operationId);
  if (input.kind !== 'provider' || operation.kind !== 'send' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) throw new Error('Invalid provider command');
  return { kind: 'provider', installation: original.installation, credential: original.credential,
    operation: { kind: 'send', operationId, binding: creationBinding(binding, original.intent, original.installation), request: copyJson(operation.request) } };
}
export function providerRun(value: unknown, target: ProviderTarget): ProviderRun {
  const input = record(value, ['binding', 'ref']), ref = record(input.ref, ['kind', 'instance', 'opaqueId']);
  const binding = creationBinding(input.binding, target.operation.binding.creation, target.installation);
  if (canonicalJson(binding) !== canonicalJson(target.operation.binding) || ref.kind !== 'run' ||
    canonicalJson(providerIdentity(ref.instance)) !== canonicalJson(target.installation.instance)) throw new Error('Foreign provider run');
  const opaqueId = identifier(ref.opaqueId);
  return { kind: 'provider', identity: parseRunIdentity({ conversation: binding.creation.scope, runId: opaqueId, authority: binding.authority }),
    reference: { binding, ref: { kind: 'run', instance: target.installation.instance, opaqueId } } };
}
export function providerObservation(value: unknown, target: ProviderTarget): ProviderObservation {
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
    const stored = record(source.run, ['kind', 'identity', 'reference']);
    run = providerRun(stored.reference, target);
    if (canonicalJson(stored) !== canonicalJson(run)) throw new Error('Foreign provider run identity');
  }
  const parsed = { correlation: canonicalJson(target), operation: run ? { namespace: target.installation.instance.namespace, id: canonicalJson(run.reference) } : null,
    source: { source: source.source, data, run } } satisfies Extract<ProviderObservation, { kind: 'pending' }>['evidence'];
  if (canonicalJson(evidence.operation) !== canonicalJson(parsed.operation)) throw new Error('Foreign provider operation');
  if (input.kind === 'pending' && run === null) return { kind: 'pending', evidence: parsed };
  if (input.kind === 'accepted' && run !== null) return { kind: 'accepted', evidence: parsed };
  if (input.kind !== 'conclusive') throw new Error('Invalid provider observation');
  const result = record(input.result);
  if (result.kind === 'receipt-completed' && run !== null) { record(result, ['kind']); return { kind: 'conclusive', evidence: parsed, result: { kind: 'receipt-completed' } }; }
  if (result.kind === 'rejected') { record(result, ['kind', 'reason']); return { kind: 'conclusive', evidence: parsed, result: { kind: 'rejected', reason: identifier(result.reason) } }; }
  throw new Error('Invalid provider result');
}
export function providerOutcome(value: unknown, target: ProviderTarget, fresh: boolean): ProviderObservation {
  const input = record(copyJson(value));
  const source: ProviderEvidence['source'] = fresh ? 'provider-reply' : 'provider-lookup';
  let run: ProviderRun | null = null;
  let kind: 'pending' | 'accepted' | 'conclusive';
  let result: { kind: 'receipt-completed' } | { kind: 'rejected'; reason: string } | undefined;
  if (input.kind === 'confirmed') {
    record(input, ['kind', 'value', 'evidence']);
    const effect = record(input.value, ['kind', 'run', 'state']);
    if (effect.kind !== 'send' || (effect.state !== 'accepted' && effect.state !== 'completed')) throw new Error('Invalid send effect');
    run = providerRun(effect.run, target);
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
  } }, target);
}

export function retainProviderRun(incoming: ProviderObservation, previous: ProviderObservation | null): ProviderObservation {
  if (incoming.kind !== 'conclusive' || incoming.result.kind !== 'rejected' || incoming.evidence.source.run !== null ||
    (previous?.kind !== 'accepted' && previous?.kind !== 'conclusive')) return incoming;
  return { ...incoming, evidence: { ...incoming.evidence, operation: previous.evidence.operation,
    source: { ...incoming.evidence.source, run: previous.evidence.source.run } } };
}
