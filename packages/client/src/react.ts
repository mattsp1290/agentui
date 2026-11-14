import { useSyncExternalStore } from 'react';
import type { ClientView, ConversationStore } from './types.js';

export function useConversation<P>(store: ConversationStore<P>): ClientView<P> {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
