import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const parseJson = (body) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
export const readJson = (path) => parseJson(readFileSync(path));
export const digest = (body, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(body).digest(encoding);

export function forkFile(folder, file) {
  const target = resolve(folder, file);
  const local = relative(folder, target);
  assert.ok(!isAbsolute(file) && local !== '' && local !== '..' && !local.startsWith(`..${sep}`), `${file}: must stay inside the fork folder`);
  return target;
}
