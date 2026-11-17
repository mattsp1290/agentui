import { createHash } from 'node:crypto';
import { canonicalJson, OUTPUT_MAX_BINDING_BYTES, OUTPUT_MAX_COUNT, OUTPUT_MAX_ID_BYTES,
  OUTPUT_MAX_LIST_BYTES, OUTPUT_MAX_METADATA_BYTES, parseOutputId, parseTextMetadata } from '@agentui/contracts';
import type { OutputFailure, TextMetadata, TextOutput } from '@agentui/contracts';
import { record, utf8Bytes } from '@agentui/contracts/decode';
import type { ConversationRef, ProviderConversation, ProviderInstance } from '@agentui/sdk';
import { creationBinding, creationIntent } from './provider-creation.js';
import type { StoredCreation } from './provider-creation.js';
import { providerReference } from './provider-commands.js';

export interface OriginalOutputBinding<I extends string> {
  readonly original: StoredCreation;
  readonly binding: ProviderConversation<I>;
  readonly instance: ProviderInstance<I>;
}
export interface BoundTextOutput<I extends string> {
  readonly reference: ConversationRef<I, 'output'>;
  readonly output: TextOutput;
}
export function prepareOutputBinding<I extends string>(value: StoredCreation, identity: ProviderInstance<I>): OriginalOutputBinding<I> {
  const original = structuredClone(value), instance = structuredClone(identity);
  if (original.observation?.kind !== 'confirmed') throw new Error('Unconfirmed output binding');
  const intent = creationIntent(original.intent, original.installation, instance);
  const binding = creationBinding(original.observation.binding, intent, original.installation);
  if (utf8Bytes(canonicalJson(binding)) > OUTPUT_MAX_BINDING_BYTES) throw new Error('Output binding exceeds limit');
  return { original, binding, instance };
}
export function outputFailure(value: unknown): OutputFailure {
  const input = record(value, ['kind', 'reason']);
  if (typeof input.reason !== 'string') throw new Error('Invalid output failure');
  switch (input.kind) {
    case 'unsupported': return { kind: 'unsupported', reason: 'outputs-unsupported' };
    case 'unavailable': case 'authentication-failed': case 'unauthorized': case 'version-unsupported':
      return { kind: 'unavailable', reason: 'outputs-unavailable' };
    default: throw new Error('Invalid output failure');
  }
}
export function parseProviderOutputList<I extends string>(value: unknown, original: OriginalOutputBinding<I>): readonly BoundTextOutput<I>[] {
  const listing = record(value, ['kind', 'outputs']);
  if (listing.kind !== 'complete' || !Array.isArray(listing.outputs) || listing.outputs.length > OUTPUT_MAX_COUNT ||
    utf8Bytes(canonicalJson(listing)) > OUTPUT_MAX_LIST_BYTES) throw new Error('Invalid complete output listing');
  const seen = new Set<string>();
  return listing.outputs.map(value => {
    const row = record(value, ['reference', 'name', 'mediaType', 'byteLength', 'sha256']);
    const reference = providerReference(row.reference, original.binding, original.original.installation, 'output', original.instance);
    const opaqueId = reference.ref.opaqueId;
    const controls = [...opaqueId].some(character => { const code = character.charCodeAt(0); return code < 32 || code === 127; });
    if (!opaqueId.trim() || controls || utf8Bytes(opaqueId) > OUTPUT_MAX_ID_BYTES || seen.has(opaqueId)) {
      throw new Error('Invalid output reference');
    }
    seen.add(opaqueId);
    const metadata = parseTextMetadata({ name: row.name, mediaType: row.mediaType, byteLength: row.byteLength, sha256: row.sha256 });
    if (utf8Bytes(canonicalJson({ opaqueId, ...metadata })) > OUTPUT_MAX_METADATA_BYTES) throw new Error('Output metadata exceeds limit');
    const identity = canonicalJson({ version: 1, scope: original.original.intent.scope, installation: original.original.installation,
      binding: original.binding, instance: original.instance, opaqueId, ...metadata });
    const outputId = parseOutputId(`output-${createHash('sha256').update(identity).digest('hex')}`);
    return { reference, output: { outputId, ...metadata, lifetime: 'provider-retained' } };
  });
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
export function copyOutputBytes(value: unknown, metadata: TextMetadata): Uint8Array {
  if (!(value instanceof Uint8Array) || Reflect.get(typedArrayPrototype, 'buffer', value) instanceof SharedArrayBuffer ||
    Reflect.get(typedArrayPrototype, 'byteLength', value) !== metadata.byteLength) {
    throw new Error('Invalid output bytes');
  }
  const bytes = new Uint8Array(value);
  if (bytes.byteLength !== metadata.byteLength || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) {
    throw new Error('Invalid output integrity');
  }
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return bytes;
}
