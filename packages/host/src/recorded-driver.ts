import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { canonicalJson } from '@agentui/contracts';
import type { ClientCommand } from '@agentui/contracts';
import type { NativeDispatchObservation } from '@mattsp1290/switchboard';
import { nonempty, object, output, parseEvidence } from './codec.js';
import type { CapturedTarget, CommandResult, Installation, ProviderDriver } from './durable-model.js';

export interface RecordedDriverOptions<E> {
  readonly installation: Installation;
  readonly backendPath: string;
  readonly decodeEvent: (value: unknown) => E;
  readonly resolve: (command: ClientCommand, target: CapturedTarget) => Promise<CommandResult<E> | 'accepted'>;
  readonly afterAcceptance?: (command: ClientCommand, target: CapturedTarget) => Promise<void>;
  readonly cancel?: { readonly kind: 'supported' } | { readonly kind: 'unsupported'; readonly reason: string };
}
export function createRecordedDriver<E>(options: RecordedDriverOptions<E>): ProviderDriver<E> {
  return {
    source: 'recorded', installation: options.installation,
    capability(command) {
      return command.body.kind === 'cancel' ? options.cancel ?? { kind: 'unsupported', reason: 'recorded-cancel-unavailable' } : { kind: 'supported' };
    },
    async dispatch(command, target) {
      const result = await options.resolve(command, target);
      const evidence = { identity: target.identity, source: 'native-acknowledgement',
        nativeOperation: { namespace: 'agentui-recorded', id: target.identity.hostOperationId },
        observation: { namespace: 'agentui-recorded', schemaVersion: 1, data: { source: 'recorded' } },
      } as const;
      const observed: NativeDispatchObservation<CommandResult<E>> = result === 'accepted'
        ? { kind: 'accepted', evidence } : { kind: 'conclusive', evidence, result };
      const fd = openSync(options.backendPath, 'a');
      try { appendFileSync(fd, `${canonicalJson(observed)}\n`); fsyncSync(fd); }
      finally { closeSync(fd); }
      await options.afterAcceptance?.(command, target);
      return observed;
    },
    async lookup(command, target) {
      if (!existsSync(options.backendPath)) return { kind: 'outcome-unknown' };
      const lines = readFileSync(options.backendPath, 'utf8').trim().split('\n').filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index--) {
        let parsed: unknown;
        try { parsed = JSON.parse(lines[index]!); }
        catch (error) { if (index === lines.length - 1) continue; throw error; }
        const observed = object(parsed), evidence = object(observed.evidence);
        if (canonicalJson(evidence.identity) === canonicalJson(target.identity)) {
          const parsedEvidence = { ...parseEvidence(evidence, target.identity), source: 'authoritative-native-lookup' } as const;
          if (observed.kind === 'accepted') return { kind: 'accepted', evidence: parsedEvidence };
          if (observed.kind !== 'conclusive') throw new Error('Invalid recorded observation');
          const result = object(observed.result);
          if (result.kind === 'rejected') return { kind: 'conclusive', evidence: parsedEvidence,
            result: { kind: 'rejected', reason: nonempty(result.reason) } };
          if (result.kind !== 'completed') throw new Error('Invalid recorded result');
          return { kind: 'conclusive', evidence: parsedEvidence, result: {
            kind: 'completed', output: output(result.output, options, target.installation, command.scope),
          } };
        }
      }
      return { kind: 'outcome-unknown' };
    },
  };
}
