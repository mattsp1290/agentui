import { z } from 'zod';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ExtensionOperation, ServerExtensionEntry } from '@agentui/sdk';
import { CoworkersClient } from './client.js';
import { registerCoworkersProvider } from './provider.js';

const OPERATION_TIMEOUT_MS = 10_000;
const refused = (code: string) => ({ kind: 'refused', code } as const);

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
            if (result.kind === 'ok') return { kind: 'ok' as const, output: { management: false, coworkers: result.value.coworkers.map(coworker => ({
              coworkerId: coworker.coworkerId, name: coworker.name, role: coworker.role, workspace: coworker.workspace, slack: coworker.slack,
              instructionsBytes: coworker.instructions.bytes })) } };
            if (result.kind === 'transport') return refused('unreachable');
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
