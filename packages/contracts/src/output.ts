import { count, hex, record } from './decode.js';

export const OUTPUT_MAX_BYTES = 65_536;
export const OUTPUT_MAX_COUNT = 32;
export const OUTPUT_MAX_LIST_BYTES = 65_536;
export const OUTPUT_MAX_ID_BYTES = 512;
export const OUTPUT_MAX_METADATA_BYTES = 1_024;
export const OUTPUT_MAX_BINDING_BYTES = 8_192;

declare const outputIdentity: unique symbol;
export type OutputId = string & { readonly [outputIdentity]: true };
export function isOutputId(value: unknown): value is OutputId {
  return typeof value === 'string' && /^output-[0-9a-f]{64}$/u.test(value);
}
export function parseOutputId(value: unknown): OutputId {
  if (!isOutputId(value)) throw new Error('Invalid output identity');
  return value;
}
export interface TextMetadata {
  readonly name: string;
  readonly mediaType: 'text/plain';
  readonly byteLength: number;
  readonly sha256: string;
}
export interface TextOutput extends TextMetadata {
  readonly outputId: OutputId;
  readonly lifetime: 'provider-retained';
}
export type OutputFailure =
  | { readonly kind: 'unsupported'; readonly reason: 'outputs-unsupported' }
  | { readonly kind: 'unavailable'; readonly reason: 'outputs-unavailable' }
  | { readonly kind: 'invalid'; readonly reason: 'outputs-invalid' };
export type OutputListing = { readonly kind: 'available'; readonly outputs: readonly TextOutput[] } | OutputFailure;
export type OutputRead =
  | { readonly kind: 'available'; readonly output: TextOutput; readonly bytes: Uint8Array }
  | { readonly kind: 'missing'; readonly reason: 'output-missing' }
  | OutputFailure;

export function parseTextMetadata(value: unknown): TextMetadata {
  const input = record(value, ['name', 'mediaType', 'byteLength', 'sha256']);
  if (typeof input.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,123}\.txt$/u.test(input.name) ||
    input.mediaType !== 'text/plain') throw new Error('Invalid text output metadata');
  const byteLength = count(input.byteLength);
  if (byteLength > OUTPUT_MAX_BYTES) throw new Error('Text output exceeds limit');
  return { name: input.name, mediaType: input.mediaType, byteLength, sha256: hex(input.sha256, 64) };
}
