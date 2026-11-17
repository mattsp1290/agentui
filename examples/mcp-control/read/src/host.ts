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
export const parseOrigin = (value: unknown) => originSchema.parse(value);

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
