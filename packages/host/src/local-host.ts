import { CORE_CATALOG_PAGE, parseCommand, parseScope, sameScope } from '@agentui/contracts';
import { identifier } from '@agentui/contracts/decode';
import type { ConversationPort, ConversationScope, Projection, Receipt, Snapshot } from '@agentui/contracts';
import { createDispatchOperation } from '@mattsp1290/switchboard';
import { budgets, commandKey } from './durable-model.js';
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
  readonly drained: Promise<void>;
  createConversation(scope: ConversationScope, target: Installation): void;
  listConversations(hostId: string, after: string | null, limit: number): readonly ConversationScope[];
  inspect(scope: ConversationScope): { readonly installation: Installation; readonly snapshot: Snapshot<P> };
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
  const dispatching = new Set<string>();
  let resolveDrained!: () => void;
  let rejectDrained!: (error: unknown) => void;
  const drained = new Promise<void>((resolve, reject) => { resolveDrained = resolve; rejectDrained = reject; });
  const finishClosing = () => {
    if (!closed || active !== 0) return;
    try { store.close(); resolveDrained(); }
    catch (error) { rejectDrained(error); }
  };
  const inFlight = async <T>(work: () => Promise<T>): Promise<T> => {
    active++;
    try { return await work(); }
    finally {
      active--;
      finishClosing();
    }
  };
  const authorized = (value: ConversationScope): ConversationScope => {
    const scope = parseScope(value);
    if (closed) throw new Error('Host is closed');
    if (!options.authorize(scope)) throw new Error('Unauthorized scope');
    return scope;
  };
  return {
    drained,
    createConversation(scope: ConversationScope, target: Installation): void {
      store.create(authorized(scope), installation(target));
    },
    inspect(scope) { return store.inspect(authorized(scope)); },
    listConversations(hostId: string, after: string | null, limit: number): readonly ConversationScope[] {
      const hostIdValue = identifier(hostId), cursor = after === null ? null : identifier(after);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > CORE_CATALOG_PAGE) throw new Error('Invalid catalog limit');
      if (closed) throw new Error('Host is closed');
      return store.listConversations(hostIdValue, cursor, limit).map(scope => {
        if (!options.authorize(scope)) throw new Error('Unauthorized scope');
        return scope;
      });
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
          const admitted = store.admit(command, options.driver.capability(command), options.driver.installation);
          if (admitted.kind === 'rejected') return admitted;
          if (admitted.kind === 'existing') return { kind: 'receipt', receipt: admitted.receipt };
          const stored = admitted.stored;
          const key = commandKey(scope, command.clientCommandId);
          const operation = createDispatchOperation({ mode: 'fresh', identity: stored.target.identity,
            signal: new AbortController().signal,
            recordIntent: () => store.verifyIntent(stored),
            dispatchNative: () => options.driver.dispatch(stored.command, stored.target),
          });
          return inFlight(async () => {
            dispatching.add(key);
            try {
              const observed = await operation.run();
              const receipt = store.settle(scope, command.clientCommandId, observed.observation);
              return { kind: 'receipt' as const, receipt };
            } finally { dispatching.delete(key); }
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
        const observed = result.kind === 'ok' ? result.value.observation : { kind: 'outcome-unknown' } as const;
        if (observed.kind === 'outcome-unknown' && dispatching.has(commandKey(scope, id))) {
          const current = store.command(scope, id);
          if (!current) throw new Error('Unknown command');
          return current.receipt;
        }
        return store.settle(scope, id, observed);
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      journal.close();
      finishClosing();
    },
  };
}
