import { canonicalJson, parseDecision, parseRunIdentity, sameScope } from '@agentui/contracts';
import type { ConversationScope, Json, Projection } from '@agentui/contracts';
import { createDispatchOperation, parseSessionReference } from '@mattsp1290/switchboard';
import type { DispatchEvidence, DispatchIdentity, DispatchObservation } from '@mattsp1290/switchboard';
import type { CapturedTarget, HostOutput, Installation, NativeRun, ObservedResult } from './durable-model.js';

export function cloneJson(value: unknown): Json { return JSON.parse(canonicalJson(value)); }
export function assertDispatchIdentity(identity: DispatchIdentity): void {
  // Switchboard exposes no binding parser; recovery construction validates without dispatching.
  createDispatchOperation({ mode: 'recovery', identity });
}
export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid integer');
  return value;
}
export function positiveInteger(value: unknown): number {
  const parsed = integer(value);
  if (parsed === 0) throw new Error('Expected positive integer');
  return parsed;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected array');
  return value;
}
export function installation(value: unknown): Installation {
  const input = object(value), binding = object(input.binding);
  const parsed = { installationId: nonempty(input.installationId), binding: {
    engine: nonempty(binding.engine), nativeVersion: nonempty(binding.nativeVersion),
    account: nonempty(binding.account), authorizedScope: nonempty(binding.authorizedScope),
    nativeFormat: nonempty(binding.nativeFormat),
  } };
  try {
    assertDispatchIdentity({ hostOperationId: 'binding-probe', target: { kind: 'new-session', binding: parsed.binding } });
  } catch { throw new Error('Invalid installation binding'); }
  return parsed;
}
export function nativeRun(value: unknown, expected: Installation, scope: ConversationScope): NativeRun {
  const input = object(value), identity = parseRunIdentity(input.identity);
  const { authority, conversation } = identity;
  if (!sameScope(conversation, scope) || authority.kind !== 'agentui-host' ||
    authority.binding.installationId !== expected.installationId) throw new Error('Foreign run authority');
  const reference = parseSessionReference({ value: input.reference, expected: expected.binding });
  if (reference.kind !== 'ok') throw new Error('Invalid native reference');
  if (authority.binding.opaqueSessionId !== reference.value.opaque) throw new Error('Session identity mismatch');
  return { identity, reference: reference.value };
}
export function output<E>(value: unknown, projection: Pick<Projection<E, unknown>, 'decodeEvent'>, installed: Installation,
  scope: ConversationScope): HostOutput<E> {
  const input = object(value);
  return { events: array(input.events).map(event => projection.decodeEvent(event)),
    ...(input.expiredDecisions === undefined ? {} : { expiredDecisions: array(input.expiredDecisions).map(nonempty) }),
    runs: array(input.runs).map(run => nativeRun(run, installed, scope)),
    decisions: array(input.decisions).map(value => {
      const input = object(value);
      const continuation: Json = cloneJson(input.continuation);
      return { visible: parseDecision(input.visible), continuation };
    }) };
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}
export function nonempty(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Expected nonempty string');
  return value;
}

export function parseEvidence(value: unknown, identity: DispatchIdentity): DispatchEvidence {
  const evidence = object(value), extension = object(evidence.observation);
  if (canonicalJson(evidence.identity) !== canonicalJson(identity)) throw new Error('Evidence identity mismatch');
  if (evidence.source !== 'native-acknowledgement' && evidence.source !== 'authoritative-native-lookup') throw new Error('Invalid evidence source');
  const native = evidence.nativeOperation === null ? null : object(evidence.nativeOperation);
  const parsedEvidence: DispatchEvidence = { identity, source: evidence.source,
    nativeOperation: native ? { namespace: nonempty(native.namespace), id: nonempty(native.id) } : null,
    observation: { namespace: nonempty(extension.namespace), schemaVersion: positiveInteger(extension.schemaVersion), data: cloneJson(extension.data) },
  };
  return parsedEvidence;
}

export function capturedTarget(value: unknown, scope: ConversationScope): CapturedTarget {
  const input = object(value), installed = installation(input.installation), identity = object(input.identity);
  const run = input.run === null ? null : nativeRun(input.run, installed, scope);
  const storedDecision = input.decision === null ? null : object(input.decision);
  const parsedDecision = storedDecision === null ? null : {
    visible: parseDecision(storedDecision.visible), continuation: cloneJson(storedDecision.continuation),
  };
  const target: CapturedTarget = { installation: installed, run, decision: parsedDecision,
    identity: { hostOperationId: nonempty(identity.hostOperationId), target: run
      ? { kind: 'session', reference: run.reference } : { kind: 'new-session', binding: installed.binding } } };
  if (canonicalJson(identity) !== canonicalJson(target.identity)) throw new Error('Corrupt captured target');
  return target;
}

export function observation(value: unknown, target: CapturedTarget): DispatchObservation<ObservedResult> {
  const input = object(value);
  if (input.kind === 'outcome-unknown') return { kind: 'outcome-unknown' };
  if (input.kind === 'not-dispatched' && (input.reason === 'aborted' || input.reason === 'intent-failed')) return { kind: input.kind, reason: input.reason };
  if (input.kind !== 'accepted' && input.kind !== 'conclusive') throw new Error('Invalid observation');
  const parsedEvidence = parseEvidence(input.evidence, target.identity);
  if (input.kind === 'accepted') return { kind: 'accepted', evidence: parsedEvidence };
  const result = object(input.result);
  if (result.kind === 'rejected') return { kind: 'conclusive', evidence: parsedEvidence, result: { kind: 'rejected', reason: nonempty(result.reason) } };
  if (result.kind !== 'completed') throw new Error('Invalid command result');
  return { kind: 'conclusive', evidence: parsedEvidence, result: {
    kind: 'completed', output: cloneJson(result.output),
  } };
}
