import { canonicalJson } from '@agentui/contracts';
import type { ObservedResult, StoredCommand } from './durable-model.js';

interface Evidence<S> {
  readonly correlation: string;
  readonly operation: { readonly namespace: string; readonly id: string } | null;
  readonly source: S;
}
export type SettlementObservation<S> =
  | { readonly kind: 'outcome-unknown' }
  | { readonly kind: 'not-dispatched'; readonly reason: 'aborted' | 'intent-failed' }
  | { readonly kind: 'accepted'; readonly evidence: Evidence<S> }
  | { readonly kind: 'conclusive'; readonly evidence: Evidence<S>; readonly result: ObservedResult };
export const OUTPUT_REJECTED = 'output-rejected';
export const CAPACITY_EXHAUSTED = 'capacity-exhausted';
export function isQuarantined(stored: Pick<StoredCommand, 'receipt'>): boolean {
  const state = stored.receipt.state;
  return state.kind === 'uncertain' && (state.reason === OUTPUT_REJECTED || state.reason === CAPACITY_EXHAUSTED);
}
export type Settlement<S> =
  | { readonly kind: 'keep' }
  | { readonly kind: 'record-evidence' | 'apply'; readonly observed: SettlementObservation<S> }
  | { readonly kind: 'conflict'; readonly reason: 'execution operation' | 'command identity' | 'terminal evidence' | 'acceptance evidence' };
function fact<S>(value: SettlementObservation<S>): string {
  if (value.kind === 'accepted' || value.kind === 'conclusive') {
    return canonicalJson({ kind: value.kind, identity: value.evidence.correlation,
      result: value.kind === 'conclusive' ? value.result : null });
  }
  return canonicalJson(value);
}
function compatibleOperation<S>(a: Evidence<S>['operation'], b: Evidence<S>['operation']): boolean {
  return a === null || b === null || (a.namespace === b.namespace && a.id === b.id);
}

export function settlement<S>(previous: SettlementObservation<S> | null, incoming: SettlementObservation<S>, context: { readonly quarantined: boolean }): Settlement<S> {
  const { quarantined } = context;
  let observed = incoming;
  if ((previous?.kind === 'accepted' || previous?.kind === 'conclusive') &&
      (observed.kind === 'accepted' || observed.kind === 'conclusive')) {
    if (previous.evidence.correlation !== observed.evidence.correlation) return { kind: 'conflict', reason: 'command identity' };
    if (!compatibleOperation(previous.evidence.operation, observed.evidence.operation)) {
      return { kind: 'conflict', reason: 'execution operation' };
    }
    observed = { ...observed, evidence: { ...observed.evidence,
      operation: observed.evidence.operation ?? previous.evidence.operation } };
  }
  switch (previous?.kind) {
    case 'conclusive': case 'not-dispatched':
      if (observed.kind === previous.kind && fact(observed) !== fact(previous)) {
        return { kind: 'conflict', reason: 'terminal evidence' };
      }
      if (quarantined) {
        const retained = previous.kind === 'conclusive' && (observed.kind === 'accepted' || observed.kind === 'conclusive')
          ? { ...previous, evidence: { ...previous.evidence, operation: observed.evidence.operation } }
          : previous;
        return { kind: 'apply', observed: retained };
      }
      if (observed.kind === 'conclusive' && previous.kind === 'conclusive' &&
          observed.evidence.operation !== null && previous.evidence.operation === null) {
        return { kind: 'record-evidence', observed };
      }
      return { kind: 'keep' };
    case 'accepted':
      if (observed.kind === 'outcome-unknown') return { kind: 'keep' };
      if (observed.kind === 'not-dispatched') return { kind: 'conflict', reason: 'acceptance evidence' };
      break;
    case 'outcome-unknown': case undefined: break;
    default: { const exhaustive: never = previous; return exhaustive; }
  }
  return { kind: previous && !quarantined && fact(previous) === fact(observed) ? 'record-evidence' : 'apply', observed };
}
