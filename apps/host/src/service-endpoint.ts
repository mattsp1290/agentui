import type { ServerResponse } from 'node:http';
import { ServiceError } from '@agentui/contracts/service';
import { FAILURE_STATUS } from './errors.js';
import { json } from './framing.js';

export async function writeServiceResult(response: ServerResponse, run: () => Promise<unknown>): Promise<void> {
  try { json(response, 200, { ok: true, value: await run() }); }
  catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('unavailable', 'Host request did not complete');
  }
}

export function writeServiceFailure(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed) { response.destroy(); return; }
  const kind = error instanceof ServiceError ? error.kind : 'invalid';
  const message = error instanceof ServiceError ? error.message : 'Invalid host request';
  json(response, FAILURE_STATUS[kind], { ok: false, error: { kind, message } });
}
