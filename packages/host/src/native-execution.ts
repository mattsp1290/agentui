import { canonicalJson, parseDecision, parseRunIdentity, sameScope } from '@agentui/contracts';
import type { ConversationScope, Json, Projection } from '@agentui/contracts';
import { createDispatchOperation, parseSessionReference } from '@mattsp1290/switchboard';
import type { DispatchEvidence, DispatchIdentity } from '@mattsp1290/switchboard';
import type { CapturedTarget, HostOutput, Installation, NativeRun, NotDispatched, ObservedResult, ProviderDispatchObservation, ProviderDriver, NativeStoredCommand } from './durable-model.js';
import { array, copyCanonicalJson, nonempty, object, positiveInteger } from './codec.js';
import type { SettlementObservation } from './settlement.js';

function assertDispatchIdentity(identity: DispatchIdentity): void {
  // Switchboard exposes no binding parser; recovery construction validates without dispatching.
  createDispatchOperation({ mode: 'recovery', identity });
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
      const continuation: Json = copyCanonicalJson(input.continuation);
      return { visible: parseDecision(input.visible), continuation };
    }) };
}

export function parseEvidence(value: unknown, identity: DispatchIdentity): DispatchEvidence {
  const evidence = object(value), extension = object(evidence.observation);
  if (canonicalJson(evidence.identity) !== canonicalJson(identity)) throw new Error('Evidence identity mismatch');
  if (evidence.source !== 'native-acknowledgement' && evidence.source !== 'authoritative-native-lookup') throw new Error('Invalid evidence source');
  const native = evidence.nativeOperation === null ? null : object(evidence.nativeOperation);
  const parsedEvidence: DispatchEvidence = { identity, source: evidence.source,
    nativeOperation: native ? { namespace: nonempty(native.namespace), id: nonempty(native.id) } : null,
    observation: { namespace: nonempty(extension.namespace), schemaVersion: positiveInteger(extension.schemaVersion), data: copyCanonicalJson(extension.data) },
  };
  return parsedEvidence;
}

export function capturedTarget(value: unknown, scope: ConversationScope): CapturedTarget {
  const input = object(value), installed = installation(input.installation), identity = object(input.identity);
  const run = input.run === null ? null : nativeRun(input.run, installed, scope);
  const storedDecision = input.decision === null ? null : object(input.decision);
  const parsedDecision = storedDecision === null ? null : {
    visible: parseDecision(storedDecision.visible), continuation: copyCanonicalJson(storedDecision.continuation),
  };
  const target: CapturedTarget = { installation: installed, run, decision: parsedDecision,
    identity: { hostOperationId: nonempty(identity.hostOperationId), target: run
      ? { kind: 'session', reference: run.reference } : { kind: 'new-session', binding: installed.binding } } };
  if (canonicalJson(identity) !== canonicalJson(target.identity)) throw new Error('Corrupt captured target');
  return target;
}

function notDispatched(reason: unknown): NotDispatched {
  return { kind: 'not-dispatched', reason: nonempty(reason) };
}

export function observation(value: unknown, target: CapturedTarget): ProviderDispatchObservation<ObservedResult> {
  const input = object(value);
  if (input.kind === 'outcome-unknown') return { kind: 'outcome-unknown' };
  if (input.kind === 'not-dispatched') return notDispatched(input.reason);
  if (input.kind !== 'accepted' && input.kind !== 'conclusive') throw new Error('Invalid observation');
  const parsedEvidence = parseEvidence(input.evidence, target.identity);
  if (input.kind === 'accepted') return { kind: 'accepted', evidence: parsedEvidence };
  const result = object(input.result);
  if (result.kind === 'rejected') return { kind: 'conclusive', evidence: parsedEvidence, result: { kind: 'rejected', reason: nonempty(result.reason) } };
  if (result.kind !== 'completed') throw new Error('Invalid command result');
  return { kind: 'conclusive', evidence: parsedEvidence, result: {
    kind: 'completed', output: copyCanonicalJson(result.output),
  } };
}

export function captureTarget(input: Omit<CapturedTarget, 'identity'>, hostOperationId: string): CapturedTarget {
  const { installation, run } = input;
  const target: CapturedTarget = { ...input, identity: { hostOperationId, target: run
    ? { kind: 'session', reference: run.reference } : { kind: 'new-session', binding: installation.binding } } };
  assertDispatchIdentity(target.identity);
  return target;
}

export async function dispatchNative<E>(stored: NativeStoredCommand, driverFor: (target: Installation) => ProviderDriver<E> | undefined,
  verifyIntent: () => void): Promise<ProviderDispatchObservation<ObservedResult>> {
  let localRefusal: NotDispatched | undefined;
  const operation = createDispatchOperation({ mode: 'fresh', identity: stored.target.identity,
    signal: new AbortController().signal, recordIntent: verifyIntent,
    dispatchNative: async () => {
      const captured = driverFor(stored.target.installation);
      if (!captured) throw new Error('Captured agent is unavailable');
      const observed = await captured.dispatch(stored.command, stored.target);
      if (observed.kind === 'not-dispatched') {
        localRefusal = notDispatched(observed.reason);
        // Switchboard accepts only native observations. This placeholder stays private
        // while the one-shot handle and its lifecycle events remain unexposed.
        return { kind: 'outcome-unknown' };
      }
      return observed;
    },
  });
  const observed = (await operation.run()).observation;
  return localRefusal ?? observed;
}

export async function reconcileNative<E>(stored: NativeStoredCommand, driver: ProviderDriver<E> | undefined): Promise<ProviderDispatchObservation<ObservedResult>> {
  const lookup = driver?.lookup;
  const previous = stored.observation === null || stored.observation.kind === 'not-dispatched'
    ? { kind: 'outcome-unknown' } as const : stored.observation;
  const operation = createDispatchOperation({ mode: 'recovery', identity: stored.target.identity, previous,
    ...(lookup ? { reconcileNative: () => lookup.call(driver, stored.command, stored.target) } : {}),
  });
  const result = await operation.reconcile(new AbortController().signal);
  return result.kind === 'ok' ? result.value.observation : { kind: 'outcome-unknown' };
}

export function settlementObservation(value: ProviderDispatchObservation<ObservedResult>): SettlementObservation<DispatchEvidence> {
  if (value.kind === 'outcome-unknown' || value.kind === 'not-dispatched') return value;
  return { ...value, evidence: { correlation: canonicalJson(value.evidence.identity),
    operation: value.evidence.nativeOperation, source: value.evidence } };
}

export function nativeObservation(value: SettlementObservation<DispatchEvidence>): ProviderDispatchObservation<ObservedResult> {
  if (value.kind === 'pending') throw new Error('Invalid native pending evidence');
  if (value.kind === 'conclusive') {
    if (value.result.kind === 'receipt-completed') throw new Error('Invalid native completion');
    return { ...value, result: value.result, evidence: { ...value.evidence.source, nativeOperation: value.evidence.operation } };
  }
  if (value.kind === 'outcome-unknown' || value.kind === 'not-dispatched') return value;
  return { ...value, evidence: { ...value.evidence.source, nativeOperation: value.evidence.operation } };
}
