import type { Event } from '@agentui/protocol';
import type { AguiModel } from './extensions.js';
import type { ConversationRef } from './providers.js';

export interface AguiOriginalRun<I extends string> {
  readonly operationId: string;
  readonly threadId: string;
  readonly run: ConversationRef<I, 'run'>;
}
export type AguiRunBatch<I extends string> = AguiOriginalRun<I> & {
  readonly firstPosition: number;
  readonly events: readonly [Event, ...Event[]];
};
export type AguiRunSnapshot<I extends string> = AguiOriginalRun<I> & (
  | { readonly kind: 'complete'; readonly events: readonly Event[] }
  | { readonly kind: 'unavailable' }
);
/** Complete original-run history is independent of the canonical transcript. */
export interface AguiObservations<M extends AguiModel, I extends string> {
  readonly event: (event: M['event']) => readonly AguiRunBatch<I>[];
  /** Every supplied original requires its complete prefix through this snapshot, or unavailable. */
  readonly snapshot: (state: M['state'], originals: readonly AguiOriginalRun<I>[]) => readonly AguiRunSnapshot<I>[];
}
