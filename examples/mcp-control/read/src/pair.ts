import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { boundedJson, parseAccess, parseCredential, parseInvitation, parseOrigin, profilePath, PROFILE_BYTES } from './access.js';
import { Reader } from './reader.js';
import { z } from 'zod';

export async function pair(originInput: string, path: string): Promise<void> {
  const origin = parseOrigin(originInput);
  await profilePath(path);
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let saved = false;
  const timeout = setTimeout(() => process.stdin.destroy(new Error('Invitation deadline')), 5000);
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > PROFILE_BYTES) throw new Error('Invitation exceeds limit');
      chunks.push(buffer);
    }
    clearTimeout(timeout);
    const invitation = parseInvitation(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
    const response = await fetch(`${origin}/native/v1/pair`, {
      method: 'POST', redirect: 'error', credentials: 'omit', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, ...invitation }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Pairing refused'); }
    const envelope = await boundedJson(response, PROFILE_BYTES);
    const value = z.strictObject({ ok: z.literal(true), value: z.unknown() }).parse(envelope).value;
    const credential = parseCredential(value);
    if (credential.hostId !== invitation.hostId) throw new Error('Pairing identity mismatch');
    const access = parseAccess({ version: 1, origin, ...credential });
    await new Reader(access).authorize(AbortSignal.timeout(5000));
    await file.writeFile(`${JSON.stringify(access)}\n`);
    await file.sync();
    saved = true;
  } finally {
    clearTimeout(timeout);
    await file.close();
    if (!saved) await unlink(path);
  }
}
