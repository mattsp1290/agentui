import { canonicalJson, DEFAULT_MAX_COMMAND_BYTES, HOST_DEFAULT_PAGE_EVENTS, HOST_DEFAULT_PAGE_BYTES, HOST_DEFAULT_SNAPSHOT_BYTES } from '@agentui/contracts';
import type { ClientCommand, ConversationScope, Json, PendingDecision, Receipt, RunIdentity } from '@agentui/contracts';
import type { DispatchIdentity, DispatchObservation, NativeDispatchObservation, SessionBinding, SessionReference } from '@mattsp1290/switchboard';

export function scopeKey(scope: ConversationScope): [string, string] { return [scope.hostId, scope.conversationId]; }
export function commandKey(scope: ConversationScope, id: string): string { return canonicalJson([...scopeKey(scope), id]); }

export interface Installation {
  readonly installationId: string;
  readonly binding: SessionBinding;
}
export interface NativeRun {
  readonly identity: RunIdentity;
  readonly reference: SessionReference;
}
export interface NativeDecision {
  readonly visible: PendingDecision;
  readonly continuation: Json;
}
export interface HostOutput<E> {
  readonly events: readonly E[];
  readonly runs: readonly NativeRun[];
  readonly decisions: readonly NativeDecision[];
}
export type CommandResult<E> =
  | { readonly kind: 'completed'; readonly output: HostOutput<E> }
  | { readonly kind: 'rejected'; readonly reason: string };
export interface CapturedTarget {
  readonly installation: Installation;
  readonly identity: DispatchIdentity;
  readonly run: NativeRun | null;
  readonly decision: NativeDecision | null;
}
/**
 * Output and evidence must satisfy canonicalJson, including its depth, node and 16,000,000-character limits.
 * An invalid driver result can leave an admitted intent unresolved. Exact-id retries never dispatch again;
 * reconcile records uncertainty when lookup is unavailable and can settle later valid authoritative evidence.
 */
export interface ProviderDriver<E> {
  readonly source: 'recorded';
  capability(command: ClientCommand): { readonly kind: 'supported' } | { readonly kind: 'unsupported'; readonly reason: string };
  dispatch(command: ClientCommand, target: CapturedTarget): Promise<NativeDispatchObservation<CommandResult<E>>>;
  lookup?(command: ClientCommand, target: CapturedTarget): Promise<NativeDispatchObservation<CommandResult<E>>>;
}
export type ObservedResult =
  | { readonly kind: 'completed'; readonly output: unknown }
  | { readonly kind: 'rejected'; readonly reason: string };
export interface StoredCommand {
  readonly command: ClientCommand;
  readonly target: CapturedTarget;
  readonly receipt: Receipt;
  readonly observation: DispatchObservation<ObservedResult> | null;
}
export interface HostBudgets {
  readonly maxCommandBytes: number;
  readonly maxEventBytes: number;
  readonly pageEvents: number;
  readonly pageBytes: number;
  readonly replayEvents: number;
  readonly replayBytes: number;
  /** Full encoded snapshot plus 128 reserved bytes per pending/accepted receipt must fit.
   * Unresolved receipts remain until authoritative settlement makes them terminal; terminal
   * receipts leave the snapshot only when they fall outside its retention window.
   * Admission refuses conversation-capacity while full. No forced release is provided. */
  readonly snapshotBytes: number;
  readonly subscribers: number;
  readonly deliveryMs: number;
  readonly pollMs: number;
}
const DEFAULT_BUDGETS: HostBudgets = { maxCommandBytes: DEFAULT_MAX_COMMAND_BYTES, maxEventBytes: 64_000,
    pageEvents: HOST_DEFAULT_PAGE_EVENTS, pageBytes: HOST_DEFAULT_PAGE_BYTES,
    replayEvents: 1000, replayBytes: 2_000_000, snapshotBytes: HOST_DEFAULT_SNAPSHOT_BYTES,
    subscribers: 100, deliveryMs: 30_000, pollMs: 100 };
export function budgets(input: Partial<HostBudgets> = {}): HostBudgets {
  const result = { ...DEFAULT_BUDGETS, ...input };
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_BUDGETS, name)) throw new Error('Unknown host budget');
  }
  if (result.deliveryMs > 2_147_483_647 || result.pollMs > 2_147_483_647) throw new Error('Timer budget exceeds platform limit');
  for (const value of Object.values(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid host budget');
  }
  if (result.maxEventBytes > result.pageBytes) throw new Error('Event budget exceeds page budget');
  return result;
}
