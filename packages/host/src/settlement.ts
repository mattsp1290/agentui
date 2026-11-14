import { canonicalJson } from '@agentui/contracts';
import type { DispatchEvidence, DispatchObservation } from '@mattsp1290/switchboard';
import type { ObservedResult, StoredCommand } from './durable-model.js';

type Observation = DispatchObservation<ObservedResult>;
export const OUTPUT_REJECTED = 'output-rejected';
export const CAPACITY_EXHAUSTED = 'capacity-exhausted';
export function isQuarantined(stored: Pick<StoredCommand, 'receipt'>): boolean {
  const state = stored.receipt.state;
  return state.kind === 'uncertain' && (state.reason === OUTPUT_REJECTED || state.reason === CAPACITY_EXHAUSTED);
}
export type Settlement =
  | { readonly kind: 'keep' }
  | { readonly kind: 'record-evidence' | 'apply'; readonly observed: Observation }
  | { readonly kind: 'conflict'; readonly reason: 'native operation' | 'terminal evidence' | 'acceptance evidence' };
function fact(value: DispatchObservation<unknown>): string {
  if (value.kind === 'accepted' || value.kind === 'conclusive') {
    return canonicalJson({ kind: value.kind, identity: value.evidence.identity,
      result: value.kind === 'conclusive' ? value.result : null });
  }
  return canonicalJson(value);
}
function compatibleNative(a: DispatchEvidence['nativeOperation'], b: DispatchEvidence['nativeOperation']): boolean {
  return a === null || b === null || (a.namespace === b.namespace && a.id === b.id);
}

export function settlement(previous: Observation | null, incoming: Observation, quarantined: boolean): Settlement {
  let observed = incoming;
  if ((previous?.kind === 'accepted' || previous?.kind === 'conclusive') &&
      (observed.kind === 'accepted' || observed.kind === 'conclusive')) {
    if (!compatibleNative(previous.evidence.nativeOperation, observed.evidence.nativeOperation)) {
      return { kind: 'conflict', reason: 'native operation' };
    }
    observed = { ...observed, evidence: { ...observed.evidence,
      nativeOperation: observed.evidence.nativeOperation ?? previous.evidence.nativeOperation } };
  }
  switch (previous?.kind) {
    case 'conclusive': case 'not-dispatched':
      if (observed.kind === previous.kind && fact(observed) !== fact(previous)) {
        return { kind: 'conflict', reason: 'terminal evidence' };
      }
      if (quarantined) {
        const retained = previous.kind === 'conclusive' && (observed.kind === 'accepted' || observed.kind === 'conclusive')
          ? { ...previous, evidence: { ...previous.evidence, nativeOperation: observed.evidence.nativeOperation } }
          : previous;
        return { kind: 'apply', observed: retained };
      }
      if (observed.kind === 'conclusive' && previous.kind === 'conclusive' &&
          observed.evidence.nativeOperation !== null && previous.evidence.nativeOperation === null) {
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
