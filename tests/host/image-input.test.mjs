import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { verifyImageUpload } from '../../packages/host/dist/image-input.js';
import { IMAGE_MAX_BYTES, parseImageAttachment, parseImageId, parseUploadId, parseImageName } from '@agentui/contracts/image';
import { chunk, png, screenshotPng, screenshotJpeg, replaceChunk } from './image-fixtures.mjs';

const verify = bytes => verifyImageUpload('Screenshot.png', bytes);
for (const [mediaType, make] of [['image/png', screenshotPng], ['image/jpeg', screenshotJpeg]]) {
  test(`fully decodes and preserves screenshot-sized ${mediaType}`, () => {
    const bytes = make();
    assert.ok(bytes.length > 64_000);
    const result = verify(bytes);
    assert.deepEqual(result.metadata, { name: 'Screenshot.png', mediaType, byteLength: bytes.length, width: 1200, height: 800 });
    assert.deepEqual(result.bytes, bytes);
    bytes.fill(0);
    assert.notDeepEqual(result.bytes, bytes);
  });
}

test('public image metadata has bounded names and opaque identities without bytes', () => {
  const id = randomUUID();
  assert.equal(parseImageId(id), id);
  assert.equal(parseUploadId(id), id);
  assert.equal(parseImageName('🎨'.repeat(40)), '🎨'.repeat(40));
  for (const name of ['', ' ', '🎨'.repeat(41), 'x\n', '\ud800']) assert.throws(() => parseImageName(name));
  for (const id of ['', '../image.png', 'x'.repeat(1000)]) assert.throws(() => parseImageId(id));
  const attachment = { imageId: id, ...verify(png()).metadata };
  assert.deepEqual(parseImageAttachment(attachment), attachment);
  assert.throws(() => parseImageAttachment({ ...attachment, bytes: 'private' }));
  assert.throws(() => parseImageAttachment({ ...attachment, width: 8193 }));
});

test('checks compressed bytes, dimensions, type and name before decoding', () => {
  assert.throws(() => verify(Buffer.alloc(IMAGE_MAX_BYTES + 1)), /4 MiB/);
  assert.throws(() => verify(Buffer.alloc(0)), /4 MiB/);
  assert.throws(() => verify(Buffer.from('GIF89a')), /PNG or JPEG/);
  assert.throws(() => verifyImageUpload('🎨'.repeat(41), png()), /160 UTF-8/);
  for (const dimensions of [{ width: 8193, height: 1 }, { width: 4001, height: 4000 }, { width: 0, height: 1 }]) {
    assert.throws(() => verify(png({ ...dimensions, scanlines: Buffer.alloc(1) })), /8192.*16 million/);
  }
});

test('supports PNG palette, sub-byte grayscale, 16-bit and Adam7 scanline sizes', () => {
  const cases = [
    png({ width: 3, height: 2, color: 0, depth: 1, scanlines: Buffer.alloc(4) }),
    png({ width: 3, height: 2, color: 3, depth: 2, scanlines: Buffer.alloc(4), extra: [chunk('PLTE', Buffer.from([255, 0, 0]))] }),
    png({ width: 3, height: 2, color: 6, depth: 16, scanlines: Buffer.alloc(50) }),
    png({ width: 1, height: 1, interlace: 1, scanlines: Buffer.alloc(5) }),
    png({ width: 8, height: 8, interlace: 1, scanlines: Buffer.alloc(271) }),
    png({ width: 3, height: 2, color: 6, depth: 16, interlace: 1, scanlines: Buffer.alloc(52) }),
  ];
  for (const bytes of cases) assert.equal(verify(bytes).metadata.mediaType, 'image/png');
});

test('accepts the advertised 16 million pixels with 16-bit RGBA and full filter overhead', () => {
  const bytes = png({ width: 4000, height: 4000, depth: 16, scanlines: Buffer.alloc(4000 * (4000 * 8 + 1)) });
  assert.ok(bytes.length < IMAGE_MAX_BYTES);
  assert.equal(verify(bytes).metadata.width, 4000);
});

test('rejects PNG truncation, inflation surplus, animation, invalid chunks and corrupt CRCs', () => {
  const valid = png();
  const ancillary = png({ extra: [chunk('tEXt', Buffer.from('hello'))] });
  ancillary[45] ^= 1;
  const malformed = [
    valid.subarray(0, -1), Buffer.concat([valid, Buffer.from([0])]), ancillary,
    png({ extra: [chunk('acTL', Buffer.alloc(8))] }),
    png({ color: 2, depth: 1 }),
    png({ scanlines: Buffer.alloc(17) }), png({ scanlines: Buffer.alloc(19) }),
    png({ width: 1, height: 1, interlace: 1, scanlines: Buffer.alloc(6) }),
    png({ scanlines: Buffer.from([5, ...Buffer.alloc(17)]) }),
    replaceChunk(valid, 'IDAT', data => chunk('IDAT', data.subarray(0, -1))),
    replaceChunk(valid, 'IDAT', data => chunk('IDAT', Buffer.concat([data, Buffer.from([0])]))),
    replaceChunk(valid, 'IDAT', data => Buffer.concat([chunk('IDAT', data.subarray(0, 2)), chunk('tEXt'), chunk('IDAT', data.subarray(2))])),
    replaceChunk(valid, 'IHDR', data => Buffer.concat([chunk('IHDR', data), chunk('IHDR', data)])),
    replaceChunk(valid, 'IDAT', () => chunk('IDAT', Buffer.from([0x78, 0x9c]))),
    png({ width: 1, height: 1, scanlines: Buffer.alloc(1024 * 1024) }),
  ];
  for (const [index, bytes] of malformed.entries()) assert.throws(() => verify(bytes), { code: 'invalid-image' }, `malformed PNG ${index}`);
  const truncated = replaceChunk(valid, 'IDAT', data => chunk('IDAT', data.subarray(0, -4)));
  assert.equal(PNG.sync.read(truncated).width, 2);
  assert.throws(() => verify(truncated), { code: 'invalid-image' });
});

test('rejects truncated JPEG scans, forged dimensions and trailing or malformed segments', () => {
  const valid = screenshotJpeg();
  const oversized = Buffer.from(valid);
  const frame = oversized.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(frame > 0);
  oversized.writeUInt16BE(8193, frame + 7);
  assert.throws(() => verify(oversized), /8192/);
  for (const bytes of [valid.subarray(0, -2), Buffer.concat([valid, Buffer.from([0])]),
    Buffer.concat([valid.subarray(0, -100), Buffer.from([0xff, 0xd9])]),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 0xff, 0xd9])]) {
    assert.throws(() => verify(bytes), { code: 'invalid-image' });
  }
});
