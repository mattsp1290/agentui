import { z } from 'zod';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ExtensionOperation, ServerExtensionEntry } from '@agentui/sdk';
import { CoworkersClient, type Coworker } from './client.js';
import { registerCoworkersProvider } from './provider.js';
import type { CoworkerSummary, CoworkersListOutput } from './operation-output.js';

const OPERATION_TIMEOUT_MS = 10_000;
/** Bounds that keep `coworkers.list` well under the host's 256,000-byte operation output limit. */
export const MAX_LISTED_COWORKERS = 500;
export const MAX_COWORKER_TEXT = 200;
const LIST_BUDGET_BYTES = 200_000;
const refused = (code: string) => ({ kind: 'refused', code } as const);
/** Cuts at a code point boundary, so no lone surrogate reaches the output. */
const capped = (value: string) => { const points = Array.from(value); return points.length > MAX_COWORKER_TEXT ? points.slice(0, MAX_COWORKER_TEXT).join('') : value; };

/** The listed coworkers in service order, cut by count and byte budget; `truncated` says whether any were left out. */
export function listedCoworkers(coworkers: readonly Coworker[]): CoworkersListOutput {
  const listed: CoworkerSummary[] = [];
  let bytes = 0;
  for (const coworker of coworkers) {
    if (listed.length >= MAX_LISTED_COWORKERS) break;
    const item = { coworkerId: coworker.coworkerId, name: capped(coworker.name), role: capped(coworker.role), workspace: coworker.workspace,
      slack: coworker.slack, instructionsBytes: coworker.instructions.bytes };
    bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes > LIST_BUDGET_BYTES) break;
    listed.push(item);
  }
  return { management: false, coworkers: listed, truncated: listed.length < coworkers.length };
}

/** The installed server entry: one provider per configured installation and the `coworkers.list` operation. */
const entry: ServerExtensionEntry = {
  kind: 'server',
  sdkVersion: EXTENSION_SDK_VERSION,
  activate(context) {
    for (const installation of context.installations) {
      registerCoworkersProvider(context, installation.id, { service: installation.service, instance: installation.instance });
    }
    const list: ExtensionOperation = {
      async run(call) {
        if (!z.strictObject({}).safeParse(call.input).success) return refused('invalid-input');
        if (!call.credential) return refused('unauthorized');
        const signal = AbortSignal.any([call.signal, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]);
        try {
          return await context.credentials.use({ credential: call.credential, service: call.installation.service }, async token => {
            const result = await new CoworkersClient({ origin: call.installation.service, token }).coworkers(signal);
            if (result.kind === 'ok') return { kind: 'ok' as const, output: listedCoworkers(result.value.coworkers) };
            if (result.kind === 'transport' || (result.kind === 'http' && result.status >= 500)) return refused('unreachable');
            if (result.kind === 'http' && (result.status === 401 || result.status === 403)) return refused('unauthorized');
            return refused('rejected');
          });
        } catch { return refused('unauthorized'); }
      },
    };
    context.operations.add('coworkers.list', list);
    return { dispose() {} };
  },
};
export default entry;
