import type { ContinuationRefusal, ConversationClosure } from '@agentui/contracts';
import type { ContinuationBoundary, ConversationContinuation } from './application-controller.js';

export const BEFORE_CONTINUE = 'Starts a new provider conversation with the same agent. The provider sends it the newest complete turns, up to 64 KiB. '
  + 'Older turns and turns with an unknown outcome are left out. Nothing you sent is resent. Tools, approvals and pending work do not carry over.';
export const NEW_CHAT_NOTE = 'Nothing from this chat is sent. Add any context yourself.';
export const CONTINUING = 'Continuing…';
export const PENDING = 'The provider saved the continuation but has not delivered the carried context. AgentUI will not send it again.';
export const UNCONFIRMED = 'Continue is not confirmed. Checking again cannot start a second conversation.';
export const STALLED = 'AgentUI could not confirm this continuation yet.';
export type ContinuationChoice = 'Continue' | 'Try again' | 'Check again' | 'Start a new chat';
const REFUSAL: Record<ContinuationRefusal, { readonly text: string; readonly choices: readonly ContinuationChoice[] }> = {
  busy: { text: 'The provider is still finishing work here.', choices: ['Try again'] },
  // Provider limits reset, and a refused handoff wrote nothing at the provider, so a later attempt is safe.
  limit: { text: 'The agent is over a provider limit.', choices: ['Try again', 'Start a new chat'] },
  unavailable: { text: 'The provider could not carry context.', choices: ['Start a new chat'] },
  'continued-elsewhere': { text: 'This conversation was continued outside AgentUI.', choices: ['Start a new chat'] },
};
const BOUNDARY_REASON: Record<ConversationClosure, string> = {
  cancelled: 'was stopped',
  failed: 'ended after the provider reported a failure',
  exhausted: 'reached its turn limit',
};

function turns(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
// Rounded up to a tenth, so a non-empty transcript never reads as 0 KiB.
function kib(bytes: number): string {
  return String(Math.ceil(bytes * 10 / 1024) / 10);
}
export function boundaryNote({ closure, carried }: ContinuationBoundary): string {
  const reason = closure && closure !== 'unknown' ? ` because the earlier one ${BOUNDARY_REASON[closure]}` : '';
  return [`Continued in a new provider conversation${reason}.`,
    carried && carried.carriedTurns > 0 && `Carried the newest ${turns(carried.carriedTurns, 'completed turn')} (${kib(carried.carriedBytes)} KiB of ${kib(carried.limitBytes)} KiB).`,
    carried && carried.omittedTurns > 0 && `${turns(carried.omittedTurns, 'older turn')} left out.`,
    carried && carried.uncertainTurns > 0 && `${turns(carried.uncertainTurns, 'turn')} with an unknown outcome left out and not resent.`,
    'Tools, approvals and the agent’s memory did not carry over.',
    carried && carried.carriedTurns > 0 && 'The first reply acknowledges the carried turns.',
  ].filter(Boolean).join(' ');
}

export interface ContinuationNoticeState {
  /** The one-line state; empty while Continue is offered. */
  readonly status: string;
  /** Whether the text that explains Continue comes before the choices. */
  readonly disclosure: boolean;
  /** {@link NEW_CHAT_NOTE} follows whenever Start a new chat is offered. */
  readonly choices: readonly ContinuationChoice[];
}
/** What a closed chat's notice shows; `null` until the first read answers. Nothing starts until a choice is clicked. */
export function continuationNotice({ view, action, error, stalled }: ConversationContinuation): ContinuationNoticeState | null {
  // A lookup that failed before any read answered leaves the same give-up state, so a control always remains.
  if (stalled || (!view && (action === 'check' || error))) return { status: STALLED, disclosure: false, choices: ['Check again', 'Start a new chat'] };
  if (!view) return null;
  const successor = view.successor;
  if (action === 'start' || action === 'move' || successor?.kind === 'starting' || successor?.kind === 'confirmed') return { status: CONTINUING, disclosure: false, choices: [] };
  if (successor === null) return { status: '', disclosure: true, choices: ['Continue', 'Start a new chat'] };
  if (successor.kind === 'refused') return { status: REFUSAL[successor.refusal].text, disclosure: false, choices: REFUSAL[successor.refusal].choices };
  if (successor.kind === 'pending') return { status: PENDING, disclosure: false, choices: ['Check again', 'Start a new chat'] };
  return { status: UNCONFIRMED, disclosure: false, choices: ['Check again', 'Try again'] };
}
/** The line the persistent polite region announces; it lives above the conversation view, so a move cannot unmount it. */
export function continuationAnnouncement(continuation: ConversationContinuation | null, concluded: boolean): string {
  if (!continuation) return '';
  if (concluded) return continuationNotice(continuation)?.status ?? '';
  return continuation.arrived === 'continue' && continuation.boundary ? boundaryNote(continuation.boundary) : '';
}
/** The label of the control that loads one more earlier segment, or `null` when none is left to load. */
export function earlierLabel({ more, action }: ConversationContinuation): string | null {
  if (!more) return null;
  return action === 'earlier' ? 'Loading earlier messages…' : 'Show earlier messages';
}
