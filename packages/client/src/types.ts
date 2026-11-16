import type { ClientCommand, ConversationDocument, ConversationPort, ConversationScope, PermissionScope, Projection, Receipt, SubmitResult } from '@agentui/contracts';
import type { ImageAttachment, UploadId } from '@agentui/contracts/image';

export interface OutboxEntry {
  readonly command: ClientCommand;
  readonly draftRevision: number | null;
}
/** A null attachment is a selection the host has not yet confirmed. */
export interface ComposerImageRecord {
  readonly selectionId: string;
  readonly uploadId: UploadId;
  readonly name: string;
  readonly byteLength: number;
  readonly attachment: ImageAttachment | null;
}
export interface LocalRecords {
  readonly version: 2;
  readonly scope: ConversationScope;
  readonly draft: string;
  readonly draftRevision: number;
  readonly outbox: readonly OutboxEntry[];
  readonly image: ComposerImageRecord | null;
}
export interface DraftImageChange {
  readonly put?: { readonly selectionId: string; readonly bytes: Uint8Array };
  readonly remove?: readonly string[];
}
/** Image bytes are stored once beside the records and must change in the same transaction as them. */
export interface DraftStoragePort {
  /** Use one port per store: loading claims the conversation, and saves from a port replaced by a later loader are ignored. */
  load(scope: ConversationScope): Promise<unknown>;
  save(records: LocalRecords, image?: DraftImageChange): Promise<void>;
  loadImage(scope: ConversationScope, selectionId: string): Promise<Uint8Array | null>;
}
export interface ComposerImage {
  readonly selectionId: string;
  readonly name: string;
  readonly byteLength: number;
  readonly status: 'uploading' | 'ready' | 'failed' | 'interrupted';
  readonly reason?: string;
  readonly attachment?: ImageAttachment;
}
export interface ImageUploadPort {
  upload(input: { readonly scope: ConversationScope; readonly uploadId: UploadId; readonly name: string; readonly bytes: Uint8Array }): Promise<ImageAttachment>;
}
export type ConnectionState =
  | { readonly kind: 'disconnected' | 'connecting' | 'connected' }
  | { readonly kind: 'resync' | 'mismatch' | 'failed'; readonly reason: string };
export interface ClientView<P> {
  readonly document: ConversationDocument<P>;
  readonly cursor: number | null;
  readonly draft: string;
  readonly outbox: readonly OutboxEntry[];
  readonly connection: ConnectionState;
  readonly submitting: readonly string[];
  readonly image: ComposerImage | null;
}
export interface ConversationStore<P> {
  readonly ready: Promise<void>;
  getSnapshot(): ClientView<P>;
  subscribe(listener: () => void): () => void;
  setDraft(text: string): Promise<void>;
  /** Upload failures are reported through the view's image status, not by rejecting. */
  selectImage(file: { readonly name: string; readonly bytes: Uint8Array }): Promise<void>;
  retryImage(): Promise<void>;
  removeImage(): Promise<void>;
  send(text?: string): Promise<SubmitResult>;
  approve(pendingId: string, choiceId: string): Promise<SubmitResult>;
  revokePermission(permissionId: string, scope: PermissionScope): Promise<SubmitResult>;
  cancel(runId: string): Promise<SubmitResult>;
  retry(clientCommandId: string): Promise<SubmitResult>;
  refreshReceipt(clientCommandId: string): Promise<Receipt | null>;
  connect(): Promise<void>;
  disconnect(): void;
}
export interface StoreOptions<E, P> {
  readonly scope: ConversationScope;
  readonly port: ConversationPort<E, P>;
  readonly projection: Projection<E, P>;
  readonly drafts: DraftStoragePort;
  readonly createCommandId: () => string;
  readonly images?: ImageUploadPort;
  /** Must return UUID v4 strings; defaults to createCommandId. */
  readonly createImageId?: () => string;
}
