import { crc32, deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { encode } from 'jpeg-js';

export function chunk(type, data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4, 'ascii');
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
export function png({ width = 2, height = 2, depth = 8, color = 6, interlace = 0, scanlines, extra = [] } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = depth; header[9] = color; header[12] = interlace;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...extra,
    chunk('IDAT', deflateSync(scanlines ?? Buffer.alloc(height * (1 + width * 4)))), chunk('IEND')]);
}
export function screenshot(width = 1200, height = 800) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = x % 256; data[offset + 1] = y % 256; data[offset + 2] = (x ^ y) % 256; data[offset + 3] = 255;
    }
  }
  return { data, width, height };
}
export const screenshotPng = () => PNG.sync.write(screenshot());
export const screenshotJpeg = () => encode(screenshot(), 85).data;
export function replaceChunk(bytes, type, mutate) {
  const parts = [bytes.subarray(0, 8)];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), end = offset + length + 12;
    parts.push(bytes.toString('ascii', offset + 4, offset + 8) === type
      ? mutate(bytes.subarray(offset + 8, end - 4)) : bytes.subarray(offset, end));
    offset = end;
  }
  return Buffer.concat(parts);
}
