import { parseCommand, parseScope, sameScope } from '@agentui/contracts';
import type { ConversationPort, ConversationScope, Projection } from '@agentui/contracts';
import { createDispatchOperation } from '@mattsp1290/switchboard';
import { budgets, installation } from './durable-model.js';
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
export function openLocalHost<E, P>(options: LocalHostOptions<E, P>) {
  const store = new SqliteStore(options.path, options.projection, budgets(options.budgets));
  const journal = new Journal(store);
  let closed = false;
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
      journal.wake();
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
          journal.wake();
          const stored = admitted.stored;
          const operation = createDispatchOperation({ mode: 'fresh', identity: stored.target.identity,
            signal: new AbortController().signal,
            recordIntent: () => store.verifyIntent(stored),
            dispatchNative: () => options.driver.dispatch(stored.command, stored.target),
          });
          const observed = await operation.run();
          const receipt = store.settle(scope, command.clientCommandId, observed.observation);
          journal.wake();
          return { kind: 'receipt', receipt };
        },
        async receipt(id) {
          authorized(scope);
          const stored = store.command(scope, id);
          return stored ? store.exposedReceipt(stored) : null;
        },
        watch(request, receive) {
          authorized(scope);
          return journal.watch(scope, request, receive);
        },
      };
    },
    async reconcile(scope: ConversationScope, id: string) {
      authorized(scope);
      const stored = store.command(scope, id);
      if (!stored) return null;
      if (stored.observation?.kind === 'conclusive' || stored.observation?.kind === 'not-dispatched') return stored.receipt;
      const lookup = options.driver.lookup;
      const operation = createDispatchOperation({ mode: 'recovery', identity: stored.target.identity,
        previous: store.recoveryPrevious(stored),
        ...(lookup ? { reconcileNative: () => lookup.call(options.driver, stored.command, stored.target) } : {}),
      });
      const result = await operation.reconcile(new AbortController().signal);
      if (result.kind !== 'ok') return store.exposedReceipt(stored);
      const receipt = store.settle(scope, id, result.value.observation);
      journal.wake();
      return receipt;
    },
    close(): void {
      if (closed) return;
      closed = true;
      journal.close();
      store.close();
    },
  };
}
