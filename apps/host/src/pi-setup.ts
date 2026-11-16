import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TranscriptEvent } from '@agentui/contracts/conversation';
import type { AgentDescriptor } from '@agentui/contracts/service';
import { piInstallation } from '@agentui/host';
import type { ProviderDriver } from '@agentui/host';
import type { createPiDriver, PiDriverOptions } from '@agentui/host/pi';
import { json, readJson } from './framing.js';

type PiDriver = Awaited<ReturnType<typeof createPiDriver>>;
export type PiSetupState =
  | { readonly kind: 'missing-key' }
  | { readonly kind: 'ready'; readonly source: 'environment' | 'native-session' }
  | { readonly kind: 'unavailable'; readonly reason: string };
const validKey = (key: string) => Boolean(key.trim()) && key.length <= 4096 && [...key].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
const missingKey = 'OpenCode Go needs an API key. Open Settings and select Open secure Pi setup to connect your subscription.';
const runtimeFailure = 'The bundled Pi runtime could not start. Restart AgentUI to retry. Your installed pi command is not used by this integration.';
export function createPiSetup(options: Omit<PiDriverOptions, 'apiKey'>, isClosing: () => boolean) {
  let state: PiSetupState = { kind: 'missing-key' };
  let active: PiDriver | undefined;
  let keyDigest: string | undefined;
  let pending: Promise<PiSetupState> | undefined;
  const availability = (): AgentDescriptor['availability'] => state.kind === 'ready' ? { kind: 'ready' }
    : { kind: 'unavailable', reason: state.kind === 'missing-key' ? missingKey : state.reason };
  const digest = (key: string) => createHash('sha256').update(key).digest('hex');
  async function configure(apiKey: string, source: 'environment' | 'native-session'): Promise<PiSetupState> {
    if (isClosing()) throw new Error('Host is shutting down');
    if (!validKey(apiKey)) throw new Error('Enter a valid OpenCode Go API key.');
    const key = apiKey.trim();
    if (pending) {
      await pending;
      return configure(key, source);
    }
    if (active) {
      if (keyDigest !== digest(key)) throw new Error('Pi is already configured. Restart AgentUI before replacing its API key.');
      return state;
    }
    const activation = (async (): Promise<PiSetupState> => {
      try {
        const candidate = await (await import('@agentui/host/pi')).createPiDriver({ ...options, apiKey: key });
        if (isClosing()) { await candidate.close(); return state; }
        active = candidate;
        keyDigest = digest(key);
        state = { kind: 'ready', source };
      } catch {
        state = { kind: 'unavailable', reason: runtimeFailure };
      }
      return state;
    })();
    pending = activation;
    try { return await activation; } finally { pending = undefined; }
  }
  const driver: ProviderDriver<TranscriptEvent> & { close(): Promise<void> } = {
    source: 'pi', installation: piInstallation(options.cwd),
    capability(command) {
      return active?.capability(command) ?? { kind: 'unsupported', reason: availability().kind === 'ready' ? runtimeFailure : missingKey };
    },
    async dispatch(command, target) {
      if (!active || isClosing()) return { kind: 'not-dispatched', reason: missingKey };
      return active.dispatch(command, target);
    },
    async close() { await pending; await active?.close(); active = undefined; keyDigest = undefined; },
  };
  return { driver, availability, status: () => state, configure };
}
export type PiSetup = ReturnType<typeof createPiSetup>;

export function piSetupEndpoint(setup: PiSetup, capability: string, isClosing: () => boolean) {
  const expected = Buffer.from(`Bearer ${capability}`);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const failure = (status: number, kind: string, message: string) => json(response, status, { ok: false, error: { kind, message } });
    try {
      const headers = request.headersDistinct;
      const authorization = headers.authorization?.[0];
      if (request.method !== 'POST' || request.url !== '/setup/pi' || headers.host?.length !== 1 ||
          headers.host[0] !== `127.0.0.1:${request.socket.localPort}` || headers.origin !== undefined ||
          headers.cookie !== undefined || headers['content-type']?.length !== 1 || headers['content-type'][0] !== 'application/json') {
        failure(400, 'invalid', 'Use the protected AgentUI setup window.'); return;
      }
      const supplied = Buffer.from(authorization ?? '');
      if (headers.authorization?.length !== 1 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        failure(403, 'forbidden', 'Use the protected AgentUI setup window.'); return;
      }
      if (isClosing()) { failure(503, 'unavailable', 'Host is shutting down.'); return; }
      const input = await readJson(request, 8192);
      if (typeof input !== 'object' || input === null || Array.isArray(input) || !('op' in input)) throw new Error();
      if (input.op === 'status' && Object.keys(input).length === 1) {
        json(response, 200, { ok: true, value: setup.status() }); return;
      }
      if (input.op !== 'configure' || Object.keys(input).length !== 2 || !('apiKey' in input) || typeof input.apiKey !== 'string' ||
          !validKey(input.apiKey)) throw new Error();
      try {
        const value = await setup.configure(input.apiKey, 'native-session');
        if (isClosing()) { failure(503, 'unavailable', 'Host is shutting down.'); return; }
        json(response, 200, { ok: true, value });
      } catch {
        failure(409, 'unavailable', 'Pi is already configured. Remove or update OPENCODE_GO_API_KEY in the launcher terminal and SSH host environment, then restart AgentUI to replace its API key.');
      }
    } catch {
      failure(400, 'invalid', 'Enter a valid OpenCode Go API key.');
    }
  };
}
