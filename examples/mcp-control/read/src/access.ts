import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { identifier } from '@agentui/contracts/decode';

export class ReadError extends Error {}
export const idSchema = z.string().refine(value => {
  try { identifier(value); return true; } catch { return false; }
});
const originSchema = z.string().refine(value => {
  try {
    const url = new URL(value);
    return /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(value) && url.origin === value && Number(url.port) <= 65535;
  } catch { return false; }
});
const credentialSchema = z.strictObject({ hostId: idSchema, principalId: idSchema, secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) });
const accessSchema = credentialSchema.extend({ version: z.literal(1), origin: originSchema }).readonly();
export type Access = z.infer<typeof accessSchema>;
const invitationSchema = z.strictObject({ ok: z.literal(true), value: z.strictObject({
  hostId: idSchema, code: z.string().regex(/^[A-Za-z0-9_-]{32}$/u),
}) });
export const parseInvitation = (value: unknown) => invitationSchema.parse(value).value;
export const parseOrigin = (value: unknown) => originSchema.parse(value);
export const parseCredential = (value: unknown) => credentialSchema.parse(value);
export const parseAccess = (value: unknown) => accessSchema.parse(value);
export const PROFILE_BYTES = 4096;

export async function profilePath(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || process.getuid === undefined) throw new ReadError('Invalid private profile path');
  const parent = dirname(path), info = await lstat(parent);
  const checkout = await realpath(fileURLToPath(new URL('../../../../', import.meta.url)));
  const actual = await realpath(parent), inside = relative(checkout, actual);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0 || inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))) {
    throw new ReadError('Use an existing owner-only directory outside the checkout');
  }
  return path;
}
export async function loadAccess(path: string): Promise<Access> {
  await profilePath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > PROFILE_BYTES) {
      throw new ReadError('Invalid private profile');
    }
    const buffer = Buffer.alloc(PROFILE_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > PROFILE_BYTES) throw new ReadError('Invalid private profile');
    return parseAccess(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))));
  } finally { await file.close(); }
}
export async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  if (!response.body) throw new ReadError('Invalid host response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) throw new ReadError('Host response exceeds limit');
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
