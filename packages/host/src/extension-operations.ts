import { record } from '@agentui/contracts/decode';
import { parseExtensionCallValue } from '@agentui/contracts/service';
import type { ExtensionCallFailure, ExtensionCallValue } from '@agentui/contracts/service';

/** The host replies to an extension operation within this many milliseconds of admission. */
export const EXTENSION_OPERATION_DEADLINE_MS = 15_000;

export const failedCall = (cause: ExtensionCallFailure): ExtensionCallValue => ({ kind: 'failed', cause });

/** Reads a handler result. Thrown errors classify it: ExtensionCallTooLarge is too-large, anything else invalid-result. */
export function operationResult(value: unknown): { readonly value: ExtensionCallValue; readonly agentsChanged: boolean } {
  const input = record(value);
  if (input.kind === 'refused') {
    record(value, ['kind', 'code']);
    return { value: parseExtensionCallValue({ kind: 'refused', code: input.code }), agentsChanged: false };
  }
  if (input.kind !== 'ok') throw new Error('Invalid operation result');
  const changed = Object.hasOwn(input, 'agentsChanged');
  record(value, changed ? ['kind', 'output', 'agentsChanged'] : ['kind', 'output']);
  if (changed && input.agentsChanged !== true) throw new Error('Invalid operation result');
  return { value: parseExtensionCallValue({ kind: 'ok', output: input.output }), agentsChanged: changed };
}

/**
 * Runs one admitted operation under a deadline. Its controller stays in `live` until the reply, so a caller can abort
 * every admitted call. An abort ends the call at once: `timeout` when the deadline fired, `unavailable` otherwise.
 * Once `run` commits a value, the operation has taken effect, so an abort after that replies with the committed value
 * rather than reporting a failure for work that was done. The signal keeps the default abort reason, so handlers
 * observe the same abort they always did.
 */
export function runAdmitted(run: (signal: AbortSignal, commit: (value: ExtensionCallValue) => void) => Promise<ExtensionCallValue>,
  deadlineMs: number, live: Set<AbortController>): Promise<ExtensionCallValue> {
  const controller = new AbortController();
  let timedOut = false;
  let committed: ExtensionCallValue | undefined;
  const ended = new Promise<ExtensionCallValue>(resolve => controller.signal.addEventListener('abort',
    () => resolve(committed ?? failedCall(timedOut ? 'timeout' : 'unavailable')), { once: true }));
  live.add(controller);
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
  return Promise.race([run(controller.signal, value => { committed = value; }), ended])
    .finally(() => { clearTimeout(timer); live.delete(controller); });
}
