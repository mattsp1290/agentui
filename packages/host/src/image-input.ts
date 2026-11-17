import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { decode } from 'jpeg-js';
import { IMAGE_MAX_BYTES, parseImageDimensions, parseImageName } from '@agentui/contracts/image';
import type { ImageAttachment, ImageFailureKind } from '@agentui/contracts/image';

export class ImageInputError extends Error {
  constructor(readonly code: ImageFailureKind, message: string) {
    super(message);
    this.name = 'ImageInputError';
  }
}
export function imageFailure(error: unknown): { readonly code: ImageInputError['code']; readonly message: string } | null {
  return error instanceof ImageInputError ? { code: error.code, message: error.message } : null;
}
interface VerifiedImageUpload {
  readonly metadata: Omit<ImageAttachment, 'imageId'>;
  readonly bytes: Buffer;
  readonly digest: string;
}
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngFormats: Readonly<Record<number, { channels: number; depths: readonly number[] }>> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};
const adam7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;
function invalid(): never { throw new ImageInputError('invalid-image', 'This image is damaged or uses an unsupported PNG or JPEG format'); }

function imageDimensions(width: number, height: number) {
  try { return parseImageDimensions(width, height); }
  catch { throw new ImageInputError('invalid-image', 'Image must be at most 8192 pixels per side and 16 million pixels'); }
}
function pngDimensions(bytes: Buffer) {
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid();
  const dimensions = imageDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  const depth = bytes.readUInt8(24), color = bytes.readUInt8(25), interlace = bytes.readUInt8(28), format = pngFormats[color];
  if (!format?.depths.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || interlace > 1) invalid();
  const compressed: Buffer[] = [];
  let phase: 'header' | 'data' | 'after-data' = 'header';
  let paletteEntries = 0, transparency = false, ended = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) invalid();
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = bytes.toString('latin1', offset + 4, offset + 8), data = bytes.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new ImageInputError('invalid-image', 'Animated PNG images are unsupported');
    if (type !== 'IDAT' && phase === 'data') phase = 'after-data';
    switch (type) {
      case 'IHDR':
        if (offset !== 8 || length !== 13) invalid();
        break;
      case 'PLTE':
        if (phase !== 'header' || paletteEntries || transparency || color === 0 || color === 4 || !length || length % 3 || length > 768) invalid();
        paletteEntries = length / 3;
        if (color === 3 && paletteEntries > 2 ** depth) invalid();
        break;
      case 'tRNS':
        if (phase !== 'header' || transparency || !length) invalid();
        if (!(color === 0 && length === 2 || color === 2 && length === 6 || color === 3 && length <= paletteEntries)) invalid();
        transparency = true;
        break;
      case 'gAMA':
        if (phase !== 'header' || length !== 4 || data.readUInt32BE(0) === 0) invalid();
        break;
      case 'IDAT':
        if (phase === 'after-data' || color === 3 && !paletteEntries) invalid();
        phase = 'data';
        compressed.push(data);
        break;
      case 'IEND':
        if (length !== 0 || !compressed.length || end !== bytes.length) invalid();
        ended = true;
        break;
      default:
        if (type.charCodeAt(0) < 97) invalid();
    }
    offset = end;
  }
  if (!ended) invalid();
  const passes = interlace ? adam7 : [[0, 0, 1, 1] as const];
  let scanlineBytes = 0;
  for (const [x, y, dx, dy] of passes) {
    const width = Math.max(0, Math.ceil((dimensions.width - x) / dx));
    const height = Math.max(0, Math.ceil((dimensions.height - y) / dy));
    if (width && height) scanlineBytes += height * (1 + Math.ceil(width * format.channels * depth / 8));
  }
  const input = Buffer.concat(compressed);
  const inflated: unknown = inflateSync(input, { maxOutputLength: scanlineBytes, info: true });
  if (!inflated || typeof inflated !== 'object' || !('buffer' in inflated) || !Buffer.isBuffer(inflated.buffer) ||
    inflated.buffer.length !== scanlineBytes || !('engine' in inflated) || !inflated.engine || typeof inflated.engine !== 'object' ||
    !('bytesWritten' in inflated.engine) || inflated.engine.bytesWritten !== input.length) invalid();
  return dimensions;
}

// Phones append MPF secondary images and gain maps after the primary image's EOI; only the primary is checked and decoded.
function jpegPrimary(bytes: Buffer) {
  let dimensions: ReturnType<typeof parseImageDimensions> | undefined;
  let scanned = false, inScan = false;
  for (let offset = 2; offset < bytes.length;) {
    if (bytes[offset++] !== 0xff) {
      if (inScan) continue;
      invalid();
    }
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes.readUInt8(offset++);
    if (inScan && (marker === 0 || marker >= 0xd0 && marker <= 0xd7)) continue;
    inScan = false;
    if (marker === 0xd9) {
      if (!dimensions || !scanned) invalid();
      return { dimensions, end: offset };
    }
    if (offset + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > bytes.length) invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (dimensions || length < 11 || bytes[offset + 2] !== 8) invalid();
      dimensions = imageDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      const components = bytes.readUInt8(offset + 7);
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) invalid();
      for (let component = offset + 8; component < end; component += 3) {
        const sampling = bytes.readUInt8(component + 1), horizontal = sampling >> 4, vertical = sampling & 15;
        if (!horizontal || !vertical || horizontal > 4 || vertical > 4) invalid();
      }
    } else if (marker === 0xda) {
      if (!dimensions || length < 6 || length !== 6 + 2 * bytes.readUInt8(offset + 2)) invalid();
      scanned = true;
      inScan = true;
    } else if (!(marker === 0xc4 || marker === 0xdb || marker === 0xdd || marker === 0xfe || marker >= 0xe0 && marker <= 0xef)) invalid();
    offset = end;
  }
  return invalid();
}

export function verifyImageUpload(name: string, input: Uint8Array): VerifiedImageUpload {
  let displayName: string;
  try { displayName = parseImageName(name); }
  catch { throw new ImageInputError('invalid-image', 'Image name must contain 1 to 160 UTF-8 bytes without control characters'); }
  try {
    if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > IMAGE_MAX_BYTES) {
      throw new ImageInputError('invalid-image', 'Choose an image containing at most 4 MiB');
    }
    const bytes = Buffer.from(input);
    const isPng = bytes.subarray(0, 8).equals(pngSignature);
    if (!isPng && (bytes[0] !== 0xff || bytes[1] !== 0xd8)) throw new ImageInputError('invalid-image', 'Choose a PNG or JPEG image');
    const primary = isPng ? { dimensions: pngDimensions(bytes), end: bytes.length } : jpegPrimary(bytes), { dimensions } = primary;
    const decoded = isPng ? PNG.sync.read(bytes, { checkCRC: true }) : decode(bytes.subarray(0, primary.end), {
      tolerantDecoding: false, maxResolutionInMP: 16, maxMemoryUsageInMB: 256, formatAsRGBA: true,
    });
    if (decoded.width !== dimensions.width || decoded.height !== dimensions.height || decoded.data.length !== dimensions.width * dimensions.height * 4) invalid();
    return { bytes, digest: createHash('sha256').update(bytes).digest('hex'), metadata: {
      name: displayName, mediaType: isPng ? 'image/png' : 'image/jpeg', byteLength: bytes.length, ...dimensions,
    } };
  } catch (error) {
    if (error instanceof ImageInputError) throw error;
    if (error instanceof Error && error.message.startsWith('maxMemoryUsageInMB limit exceeded')) {
      throw new ImageInputError('invalid-image', 'This image requires too much memory to decode. Choose a smaller image');
    }
    invalid();
  }
}
