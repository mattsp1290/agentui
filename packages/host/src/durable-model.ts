import { canonicalJson, parseScope } from '@agentui/contracts';
import type { ClientCommand, ConversationScope, Json, PendingDecision, Projection, Receipt, RunIdentity } from '@agentui/contracts';
import { createDispatchOperation, parseSessionReference } from '@mattsp1290/switchboard';
import type { DispatchIdentity, DispatchObservation, NativeDispatchObservation, SessionBinding, SessionReference } from '@mattsp1290/switchboard';

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
  readonly snapshotBytes: number;
  readonly subscribers: number;
  readonly deliveryMs: number;
  readonly pollMs: number;
}
export function budgets(input: Partial<HostBudgets> = {}): HostBudgets {
  const result = { maxCommandBytes: 64_000, maxEventBytes: 64_000, pageEvents: 64, pageBytes: 256_000,
    replayEvents: 1000, replayBytes: 2_000_000, snapshotBytes: 4_000_000,
    subscribers: 100, deliveryMs: 30_000, pollMs: 100, ...input };
  for (const name of Object.keys(input)) {
    if (!['maxCommandBytes', 'maxEventBytes', 'pageEvents', 'pageBytes', 'replayEvents', 'replayBytes', 'snapshotBytes', 'subscribers', 'deliveryMs', 'pollMs'].includes(name)) throw new Error('Unknown host budget');
  }
  if (result.deliveryMs > 2_147_483_647 || result.pollMs > 2_147_483_647) throw new Error('Timer budget exceeds platform limit');
  for (const value of Object.values(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid host budget');
  }
  if (result.maxEventBytes > result.pageBytes) throw new Error('Event budget exceeds page budget');
  return result;
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
    createDispatchOperation({ mode: 'recovery', identity: { hostOperationId: 'binding-probe',
      target: { kind: 'new-session', binding: parsed.binding } } });
  } catch { throw new Error('Invalid installation binding'); }
  return parsed;
}
export function decision(value: unknown): PendingDecision {
  const input = object(value);
  const choices = array(input.choices).map(nonempty);
  if (choices.length === 0 || new Set(choices).size !== choices.length) throw new Error('Invalid choices');
  return { pendingId: nonempty(input.pendingId), runId: nonempty(input.runId), choices, prompt: nonempty(input.prompt) };
}
export function receipt(value: unknown): Receipt {
  const input = object(value), state = object(input.state);
  const base = { scope: parseScope(input.scope), clientCommandId: nonempty(input.clientCommandId),
    hostOperationId: nonempty(input.hostOperationId), sequence: integer(input.sequence) };
  switch (state.kind) {
    case 'pending': case 'accepted': case 'completed': return { ...base, state: { kind: state.kind } };
    case 'not-dispatched': case 'rejected': case 'uncertain':
      return { ...base, state: { kind: state.kind, reason: nonempty(state.reason) } };
    default: throw new Error('Invalid receipt');
  }
}
export function nativeRun(value: unknown, expected: Installation, scope: ConversationScope): NativeRun {
  const input = object(value), identity = object(input.identity), authority = object(identity.authority);
  const binding = object(authority.binding), conversation = parseScope(identity.conversation);
  if (canonicalJson(conversation) !== canonicalJson(scope) || authority.kind !== 'agentui-host' ||
    authority.hostId !== scope.hostId || binding.installationId !== expected.installationId) throw new Error('Foreign run authority');
  const reference = parseSessionReference({ value: input.reference, expected: expected.binding });
  if (reference.kind !== 'ok') throw new Error('Invalid native reference');
  if (binding.opaqueSessionId !== reference.value.opaque) throw new Error('Session identity mismatch');
  return { identity: { conversation, runId: nonempty(identity.runId), authority: { kind: 'agentui-host',
    hostId: scope.hostId, binding: { namespace: nonempty(binding.namespace),
      installationId: expected.installationId, opaqueSessionId: reference.value.opaque } } }, reference: reference.value };
}
export function output<E>(value: unknown, projection: Pick<Projection<E, unknown>, 'decodeEvent'>, installed: Installation,
  scope: ConversationScope): HostOutput<E> {
  const input = object(value);
  return { events: array(input.events).map(event => projection.decodeEvent(event)),
    runs: array(input.runs).map(run => nativeRun(run, installed, scope)),
    decisions: array(input.decisions).map(value => {
      const input = object(value);
      const continuation: Json = JSON.parse(canonicalJson(input.continuation));
      return { visible: decision(input.visible), continuation };
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
