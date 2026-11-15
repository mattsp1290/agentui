export const contractVersion = 1;

export interface ConversationScope {
  readonly hostId: string;
  readonly conversationId: string;
}

export interface ProviderBinding {
  readonly namespace: string;
  readonly installationId: string;
  readonly opaqueSessionId: string;
}

export type RunAuthority =
  | { readonly kind: 'agentui-host'; readonly hostId: string; readonly binding: ProviderBinding }
  | { readonly kind: 'remote-provider'; readonly binding: ProviderBinding };

export interface RunIdentity {
  readonly conversation: ConversationScope;
  readonly runId: string;
  readonly authority: RunAuthority;
}

export { canonicalJson, copyJson, parseProviderBinding, parseRunAuthority, parseRunIdentity, JsonLimitError, DEFAULT_MAX_COMMAND_BYTES, JSON_MAX_NODES, JSON_MAX_DEPTH, parseCommand, parseScope, parseReceipt, parseDecision, parseDocument, FeedMismatchError, parseFeedItem, parseHostEvent, sameScope, foldDocument } from './durable.js';
export {
  CORE_CATALOG_PAGE, HOST_DEFAULT_PAGE_EVENTS, HOST_DEFAULT_PAGE_BYTES, HOST_DEFAULT_SNAPSHOT_BYTES,
  CORE_SNAPSHOT_ENVELOPE_RESERVE, CORE_SNAPSHOT_DOCUMENT_JSON_BUDGET,
} from './budgets.js';
export type {
  Json, CommandBody, ClientCommand, ReceiptState, Receipt, SubmitResult, PendingDecision,
  ConversationDocument, HostEvent, Envelope, Snapshot, FeedItem, FeedEnd, Feed, ConversationPort, Projection,
} from './durable.js';

export * from './observation.js';
