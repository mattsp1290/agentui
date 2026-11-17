import { count, exact, record, utf8Bytes } from './decode.js';

export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 16_000_000;
export const IMAGE_MAX_AXIS = 8192;
export const IMAGE_MAX_NAME_BYTES = 160;
export const IMAGE_HOST_MAX_BYTES = 1024 * 1024 * 1024;
export const IMAGE_HOST_MAX_COUNT = 10_000;

export type ImageId = string & { readonly __brand: 'ImageId' };
export type UploadId = string & { readonly __brand: 'UploadId' };
export type ImageMediaType = 'image/png' | 'image/jpeg';
export type ImageInputCapability =
  | { readonly kind: 'supported'; readonly format: 'png-jpeg-v1' }
  | { readonly kind: 'unsupported'; readonly reason: string };

export function parseImageInputCapability(value: unknown): ImageInputCapability {
  const input = record(value);
  if (input.kind === 'supported') {
    exact(input, ['kind', 'format']);
    if (input.format !== 'png-jpeg-v1') throw new Error('Invalid image input format');
    return { kind: 'supported', format: input.format };
  }
  exact(input, ['kind', 'reason']);
  if (input.kind !== 'unsupported' || typeof input.reason !== 'string' || !input.reason.trim() ||
    utf8Bytes(input.reason) > 256 || /[\p{Cc}\p{Cs}]/u.test(input.reason)) throw new Error('Invalid image input reason');
  return { kind: 'unsupported', reason: input.reason };
}
export interface ImageAttachment {
  readonly imageId: ImageId;
  readonly name: string;
  readonly mediaType: ImageMediaType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
}

function isImageId(value: unknown): value is ImageId {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}
function isUploadId(value: unknown): value is UploadId {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}
export function parseImageId(value: unknown): ImageId {
  if (!isImageId(value)) throw new Error('Invalid image reference');
  return value;
}
export function parseUploadId(value: unknown): UploadId {
  if (!isUploadId(value)) throw new Error('Invalid image upload identity');
  return value;
}
export function parseImageName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || utf8Bytes(value) > IMAGE_MAX_NAME_BYTES || /[\p{Cc}\p{Cs}]/u.test(value)) {
    throw new Error('Image name must contain 1 to 160 UTF-8 bytes without control characters');
  }
  return value;
}
export function parseImageDimensions(width: unknown, height: unknown): { width: number; height: number } {
  const w = count(width), h = count(height);
  if (!w || !h || w > IMAGE_MAX_AXIS || h > IMAGE_MAX_AXIS || w * h > IMAGE_MAX_PIXELS) {
    throw new Error('Image must be at most 8192 pixels per side and 16 million pixels');
  }
  return { width: w, height: h };
}
export function parseImageAttachment(value: unknown): ImageAttachment {
  const input = record(value, ['imageId', 'name', 'mediaType', 'byteLength', 'width', 'height']);
  if (input.mediaType !== 'image/png' && input.mediaType !== 'image/jpeg') throw new Error('Choose a PNG or JPEG image');
  const byteLength = count(input.byteLength);
  if (!byteLength || byteLength > IMAGE_MAX_BYTES) throw new Error('Image must contain at most 4 MiB');
  return { imageId: parseImageId(input.imageId), name: parseImageName(input.name), mediaType: input.mediaType, byteLength,
    ...parseImageDimensions(input.width, input.height) };
}

export const IMAGE_MAX_BASE64_CHARS = 5_592_408;
export const IMAGE_TRANSFER_MAX_BYTES = 6 * 1024 * 1024;
export const IMAGE_BODY_TIMEOUT_MS = 30_000;
export const IMAGE_FAILURE_KINDS = ['invalid-image', 'image-scope', 'image-upload-conflict', 'image-unsupported', 'image-capacity', 'image-integrity'] as const;
export type ImageFailureKind = typeof IMAGE_FAILURE_KINDS[number];

export function parseImageBase64(value: unknown, byteLength: unknown): string {
  const length = count(byteLength);
  if (!length || length > IMAGE_MAX_BYTES || typeof value !== 'string' || !value.length ||
    value.length > IMAGE_MAX_BASE64_CHARS || value.length % 4 !== 0) throw new Error('Invalid image bytes');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const content = value.slice(0, value.length - padding);
  if (!/^[A-Za-z0-9+/]+$/.test(content) || value.length / 4 * 3 - padding !== length) throw new Error('Invalid image bytes');
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(content.at(-1) ?? '');
  if ((padding === 2 && last % 16 !== 0) || (padding === 1 && last % 4 !== 0)) throw new Error('Invalid image bytes');
  return value;
}
