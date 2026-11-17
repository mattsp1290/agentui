import { rmdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

const waitMs = Number(process.env.AGENTUI_REFRESH_WAIT_MS);
const source = process.env.AGENTUI_REFRESH_SOURCE;
function removeSource(): void {
  if (!source) return;
  for (const remove of [() => unlinkSync(source), () => rmdirSync(dirname(source))]) {
    try { remove(); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) process.exitCode = 75;
    }
  }
}
process.on('exit', removeSource);
if (!Number.isSafeInteger(waitMs) || waitMs < 1) process.exit(72);
const end = () => process.exit(72);
process.stdin.on('end', end);
process.stdin.on('error', end);
process.stdin.resume();
if ('unref' in process.stdin && typeof process.stdin.unref === 'function') process.stdin.unref();
setTimeout(end, waitMs).unref();
