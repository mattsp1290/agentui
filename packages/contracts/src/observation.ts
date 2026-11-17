import { count, record } from './decode.js';

const STOP_REASONS = ['unsupported', 'snapshot-unavailable', 'invalid-projection', 'recovery-failed',
  'retry-exhausted', 'provider-disconnected', 'original-provider-unavailable',
  'original-credentials-unavailable', 'original-binding-unavailable', 'cleanup-failed'] as const;
const CLOSURES = ['cancelled', 'failed', 'exhausted'] as const;
export type ObservationStopReason = typeof STOP_REASONS[number];
export type ConversationClosure = typeof CLOSURES[number];
const REFUSALS = ['busy', 'limit', 'unavailable', 'continued-elsewhere'] as const;
export type ContinuationRefusal = typeof REFUSALS[number];
/** Counts of the earlier conversation's turns that a provider carried into its successor. */
export interface ContinuationCarried {
  readonly carriedTurns: number;
  readonly omittedTurns: number;
  readonly uncertainTurns: number;
  readonly carriedBytes: number;
  readonly limitBytes: number;
}
export type ProviderObservationStatus =
  | { readonly kind: 'not-applicable' | 'recovering' | 'observing' }
  | { readonly kind: 'stopped'; readonly reason: ObservationStopReason }
  | { readonly kind: 'concluded'; readonly cause: ConversationClosure };

export function parseConversationClosure(value: unknown): ConversationClosure {
  const cause = CLOSURES.find(cause => cause === value);
  if (!cause) throw new Error('Invalid conversation closure');
  return cause;
}
export function parseContinuationRefusal(value: unknown): ContinuationRefusal {
  const refusal = REFUSALS.find(refusal => refusal === value);
  if (!refusal) throw new Error('Invalid continuation refusal');
  return refusal;
}
export function parseContinuationCarried(value: unknown): ContinuationCarried {
  const input = record(value, ['carriedTurns', 'omittedTurns', 'uncertainTurns', 'carriedBytes', 'limitBytes']);
  return { carriedTurns: count(input.carriedTurns), omittedTurns: count(input.omittedTurns), uncertainTurns: count(input.uncertainTurns),
    carriedBytes: count(input.carriedBytes), limitBytes: count(input.limitBytes) };
}
export function parseProviderObservationStatus(value: unknown): ProviderObservationStatus {
  const input = record(value);
  if (input.kind === 'stopped') {
    record(value, ['kind', 'reason']);
    const reason = STOP_REASONS.find(reason => reason === input.reason);
    if (!reason) throw new Error('Invalid observation stop reason');
    return { kind: 'stopped', reason };
  }
  if (input.kind === 'concluded') {
    record(value, ['kind', 'cause']);
    return { kind: 'concluded', cause: parseConversationClosure(input.cause) };
  }
  record(value, ['kind']);
  if (input.kind !== 'not-applicable' && input.kind !== 'recovering' && input.kind !== 'observing') throw new Error('Invalid observation status');
  return { kind: input.kind };
}
export function canRetryObservation(status: ProviderObservationStatus): boolean {
  return status.kind === 'stopped' && ['snapshot-unavailable', 'invalid-projection', 'recovery-failed',
    'retry-exhausted', 'provider-disconnected'].includes(status.reason);
}
