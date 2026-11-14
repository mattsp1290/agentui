import { parseCommand, parseScope, sameScope } from '@agentui/contracts';
import type { ConversationPort, ConversationScope, Projection, Receipt } from '@agentui/contracts';
import { createDispatchOperation } from '@mattsp1290/switchboard';
import { budgets } from './durable-model.js';
import { installation, nonempty } from './codec.js';
import { isQuarantined } from './settlement.js';
import type { HostBudgets, HostOutput, Installation, ProviderDriver } from './durable-model.js';
import { SqliteStore } from './sqlite-store.js';
import { Journal } from './journal.js';

export interface LocalHostOptions<E, P> {
  readonly path: string;
  readonly projection: Projection<E, P>;
  readonly driver: ProviderDriver<E>;
  readonly authorize: (scope: ConversationScope) => boolean;
  readonly budgets?: Partial<HostBudgets>;
}
export interface LocalHost<E, P> {
  createConversation(scope: ConversationScope, target: Installation): void;
  append(scope: ConversationScope, output: HostOutput<E>): void;
  conversation(scope: ConversationScope): ConversationPort<E, P>;
  reconcile(scope: ConversationScope, id: string): Promise<Receipt | null>;
  close(): void;
}
export function openLocalHost<E, P>(options: LocalHostOptions<E, P>): LocalHost<E, P> {
  const store = new SqliteStore(options.path, options.projection, budgets(options.budgets));
  const journal = new Journal(store);
  store.onCommit = () => journal.wake();
  let closed = false;
  let active = 0;
  const inFlight = async <T>(work: () => Promise<T>): Promise<T> => {
    active++;
    try { return await work(); }
    finally {
      active--;
      if (closed && active === 0) store.close();
    }
  };
  const authorized = (value: ConversationScope): ConversationScope => {
    const scope = parseScope(value);
    if (closed) throw new Error('Host is closed');
    if (!options.authorize(scope)) throw new Error('Unauthorized scope');
    return scope;
  };
  return {
    createConversation(scope: ConversationScope, target: Installation): void {
      store.create(authorized(scope), installation(target));
    },
    append(scope: ConversationScope, output: HostOutput<E>): void {
      store.append(authorized(scope), output);
    },
    conversation(value: ConversationScope): ConversationPort<E, P> {
      const scope = authorized(value);
      return {
        scope,
        async submit(value) {
          let command;
          try {
            command = parseCommand(value);
            authorized(command.scope);
            if (!sameScope(scope, command.scope)) return { kind: 'rejected', reason: 'scope-mismatch' };
          } catch { return { kind: 'rejected', reason: 'invalid-or-unauthorized-command' }; }
          const admitted = store.admit(command, options.driver.capability(command));
          if (admitted.kind === 'rejected') return admitted;
          if (admitted.kind === 'existing') return { kind: 'receipt', receipt: admitted.receipt };
          const stored = admitted.stored;
          const operation = createDispatchOperation({ mode: 'fresh', identity: stored.target.identity,
            signal: new AbortController().signal,
            recordIntent: () => store.verifyIntent(stored),
            dispatchNative: () => options.driver.dispatch(stored.command, stored.target),
          });
          return inFlight(async () => {
            const observed = await operation.run();
            const receipt = store.settle(scope, command.clientCommandId, observed.observation);
            return { kind: 'receipt' as const, receipt };
          });
        },
        async receipt(id) {
          authorized(scope);
          const stored = store.command(scope, nonempty(id));
          return stored ? stored.receipt : null;
        },
        watch(request, receive) {
          authorized(scope);
          return journal.watch(scope, request, receive);
        },
      };
    },
    async reconcile(scope: ConversationScope, id: string) {
      authorized(scope);
      const stored = store.command(scope, nonempty(id));
      if (!stored) return null;
      if (stored.observation?.kind === 'conclusive' && isQuarantined(stored)) {
        return store.settle(scope, id, stored.observation);
      }
      if (stored.observation?.kind === 'conclusive' || stored.observation?.kind === 'not-dispatched') return stored.receipt;
      const lookup = options.driver.lookup;
      const operation = createDispatchOperation({ mode: 'recovery', identity: stored.target.identity,
        previous: store.recoveryPrevious(stored),
        ...(lookup ? { reconcileNative: () => lookup.call(options.driver, stored.command, stored.target) } : {}),
      });
      return inFlight(async () => {
        const result = await operation.reconcile(new AbortController().signal);
        if (result.kind !== 'ok') {
          return stored.observation === null
            ? store.settle(scope, id, { kind: 'outcome-unknown' }) : stored.receipt;
        }
        return store.settle(scope, id, result.value.observation);
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      journal.close();
      if (active === 0) store.close();
    },
  };
}
