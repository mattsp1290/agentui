import { record } from './decode.js';

const STOP_REASONS = ['unsupported', 'snapshot-unavailable', 'invalid-projection', 'recovery-failed',
  'retry-exhausted', 'provider-disconnected', 'original-provider-unavailable',
  'original-credentials-unavailable', 'original-binding-unavailable', 'cleanup-failed'] as const;
export type ObservationStopReason = typeof STOP_REASONS[number];
export type ProviderObservationStatus =
  | { readonly kind: 'not-applicable' | 'recovering' | 'observing' }
  | { readonly kind: 'stopped'; readonly reason: ObservationStopReason };

export function parseProviderObservationStatus(value: unknown): ProviderObservationStatus {
  const input = record(value);
  if (input.kind === 'stopped') {
    record(value, ['kind', 'reason']);
    const reason = STOP_REASONS.find(reason => reason === input.reason);
    if (!reason) throw new Error('Invalid observation stop reason');
    return { kind: 'stopped', reason };
  }
  record(value, ['kind']);
  if (input.kind !== 'not-applicable' && input.kind !== 'recovering' && input.kind !== 'observing') throw new Error('Invalid observation status');
  return { kind: input.kind };
}
export function canRetryObservation(status: ProviderObservationStatus): boolean {
  return status.kind === 'stopped' && ['snapshot-unavailable', 'invalid-projection', 'recovery-failed',
    'retry-exhausted', 'provider-disconnected'].includes(status.reason);
}
