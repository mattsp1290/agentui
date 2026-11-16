import { recoverFrontendBinding } from './frontend-sends.js';
import type { FrontendSendActor } from './frontend-sends.js';
import type { FrontendBinding, FrontendBindingRequest } from '@agentui/contracts';
import { frontendToolsFor } from './frontend-tools/index.js';
import { observationFailure } from './provider-stream.js';
import type { ProviderStream } from './provider-stream.js';
import { canRetryObservation, canonicalJson, CORE_CATALOG_PAGE, parseCommand, parseScope, sameScope } from '@agentui/contracts';
import { identifier } from '@agentui/contracts/decode';
import type { ConversationPermissions, ConversationPort, ConversationScope, Projection, Receipt, Snapshot, ProviderObservationStatus } from '@agentui/contracts';
import { budgets, commandKey } from './durable-model.js';
import { nonempty } from './codec.js';
import { installation, dispatchNative, reconcileNative } from './native-execution.js';
import { isQuarantined } from './settlement.js';
import type { HostBudgets, HostOutput, Installation, ProviderDriver } from './durable-model.js';
import { providerInstallationKey } from './provider-creation.js';
import type { ConversationInstallation, ProviderInstallation, StoredCreation, CreationObservation, ProviderCreation } from './provider-creation.js';
import type { ProviderConversationOperations, ProviderCreationOperations } from './providers.js';
import { SqliteStore } from './sqlite-store.js';
import { Journal } from './journal.js';
import { registerFrontendToolsHost } from './frontend-tools-context.js';

export interface LocalHostOptions<E, P> {
  readonly path: string;
  readonly projection: Projection<E, P>;
  readonly driver: ProviderDriver<E> | readonly ProviderDriver<E>[];
  readonly authorize: (scope: ConversationScope) => boolean;
  readonly providers?: ProviderConversationOperations;
  readonly budgets?: Partial<HostBudgets>;
}
export interface LocalHost<E, P> {
  readonly drained: Promise<void>;
  createConversation(scope: ConversationScope, target: Installation): void;
  createProviderConversation(scope: ConversationScope, target: ProviderInstallation, providers: ProviderCreationOperations): Promise<CreationObservation>;
  creation(scope: ConversationScope): StoredCreation | null;
  conversationPermissions(scope: ConversationScope): Promise<ConversationPermissions>;
  observeProvider(scope: ConversationScope): Promise<void>;
  observationStatus(scope: ConversationScope): ProviderObservationStatus;
  retryObservation(scope: ConversationScope): Promise<ProviderObservationStatus>;
  listConversations(hostId: string, after: string | null, limit: number): readonly ConversationScope[];
  installation(scope: ConversationScope): ConversationInstallation | null;
  inspect(scope: ConversationScope): { readonly installation: ConversationInstallation; readonly snapshot: Snapshot<P> };
  append(scope: ConversationScope, output: HostOutput<E>): void;
  conversation(scope: ConversationScope, actor?: FrontendSendActor): ConversationPort<E, P>;
  reconcile(scope: ConversationScope, id: string, actor?: FrontendSendActor): Promise<Receipt | null>;
  frontendBinding(input: FrontendBindingRequest, actor: FrontendSendActor): Promise<FrontendBinding>;
  close(): void;
}
export function openLocalHost<E, P>(options: LocalHostOptions<E, P>): LocalHost<E, P> {
  const store = new SqliteStore(options.path, options.projection, budgets(options.budgets));
  const configured = 'source' in options.driver ? [options.driver] : options.driver;
  const drivers = new Map(configured.map(driver => [canonicalJson(driver.installation), driver]));
  if (drivers.size !== configured.length) { store.close(); throw new Error('Duplicate agent installation'); }
  const driverFor = (target: Installation) => drivers.get(canonicalJson(target));
  const journal = new Journal(store);
  store.onCommit = () => journal.wake();
  let closed = false, observationCleanupFailed = false;
  let active = 0;
  const dispatching = new Set<string>();
  const creating = new Map<string, Promise<CreationObservation>>();
  type Observation = { state:
    | { readonly kind: 'starting'; readonly task: Promise<void> }
    | { readonly kind: 'live'; readonly stream: ProviderStream }
    | Extract<ProviderObservationStatus, { kind: 'stopped' }> };
  const observing = new Map<string, Observation>();
  let resolveDrained!: () => void;
  let rejectDrained!: (error: unknown) => void;
  const drained = new Promise<void>((resolve, reject) => { resolveDrained = resolve; rejectDrained = reject; });
  const finishClosing = () => {
    if (!closed || active !== 0) return;
    if (observationCleanupFailed) { rejectDrained(new Error('Provider observation cleanup failed')); return; }
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
  const observationStatus = (scope: ConversationScope): ProviderObservationStatus => {
    authorized(scope);
    const target = store.findInstallation(scope), original = store.creation(scope);
    if (!original && target && !('kind' in target)) return { kind: 'not-applicable' };
    if (original?.observation?.kind !== 'confirmed') return { kind: 'stopped', reason: 'original-binding-unavailable' };
    const state = observing.get(canonicalJson(scope))?.state;
    if (state?.kind === 'starting') return { kind: 'recovering' };
    if (state?.kind === 'live') return { kind: 'observing' };
    return state ?? { kind: 'stopped', reason: options.providers ? 'recovery-failed' : 'original-provider-unavailable' };
  };
  const observeProvider = async (scope: ConversationScope, freshSnapshot = false): Promise<void> => {
    authorized(scope);
    const key = canonicalJson(scope), previous = observing.get(key);
    if (previous?.state.kind === 'starting') return previous.state.task;
    if (previous?.state.kind === 'live' || previous?.state.reason === 'cleanup-failed') return;
    const original = store.creation(scope), registry = options.providers;
    if (original?.observation?.kind !== 'confirmed' || !registry) return;
    const entry: Observation = { state: { kind: 'stopped', reason: 'recovery-failed' } };
    const task = inFlight(async () => {
      try {
        const stream = await Promise.resolve().then(() => registry.observe(original, store, freshSnapshot));
        entry.state = { kind: 'live', stream };
        void stream.drained.then(reason => {
          if (observing.get(key) === entry) entry.state = { kind: 'stopped', reason: reason === 'closed' ? 'provider-disconnected' : reason };
        }, () => {
          observationCleanupFailed = true;
          if (observing.get(key) === entry) entry.state = { kind: 'stopped', reason: 'cleanup-failed' };
        });
      } catch (error) {
        if (observing.get(key) === entry) entry.state = { kind: 'stopped', reason: observationFailure(error, 'recovery-failed') };
      }
    });
    entry.state = { kind: 'starting', task };
    observing.set(key, entry);
    await task;
  };
  const checkOwner = (stored: ReturnType<typeof store.command>, actor?: FrontendSendActor, effect = false) => {
    if (stored?.command.version !== 2) return;
    if (effect) {
      if (!('kind' in stored) || !options.providers) throw new Error('Frontend owner unavailable');
      options.providers.frontendInput(stored.target);
    }
    const state = store.frontendSends.check({ scope: stored.command.scope, id: stored.command.clientCommandId, actor, command: stored.command });
    if (effect && state !== 'available') throw new Error('Frontend owner unavailable');
  };
  const host: LocalHost<E, P> = {
    drained,
    observeProvider,
    observationStatus,
    async retryObservation(scope) {
      const status = observationStatus(scope);
      if (status.kind === 'recovering' || canRetryObservation(status)) await observeProvider(scope, true);
      return observationStatus(scope);
    },
    createConversation(scope: ConversationScope, target: Installation): void {
      store.create(authorized(scope), installation(target));
    },
    conversationPermissions(value) {
      const scope = authorized(value), original = store.creation(scope);
      if (!original) {
        const installed = store.findInstallation(scope);
        return Promise.resolve(installed && 'kind' in installed
          ? { kind: 'unavailable', reason: 'Original provider binding unavailable.' }
          : { kind: 'unsupported', reason: 'This conversation does not report permissions.' });
      }
      return inFlight(async () => {
        const result: ConversationPermissions = await options.providers?.readPermissions(original) ?? { kind: 'unavailable', reason: 'Original provider unavailable.' };
        authorized(scope);
        return result;
      });
    },
    creation(scope) { return store.creation(authorized(scope)); },
    async createProviderConversation(scope, target, providers) {
      authorized(scope);
      const prior = store.creation(scope);
      if (!prior && store.findInstallation(scope)) throw new Error('Conversation already exists without provider creation provenance');
      if (prior && providerInstallationKey(prior.installation) !== providerInstallationKey(target)) throw new Error('Creation agent is immutable');
      const key = canonicalJson(scope), leased = creating.get(key);
      if (leased) return leased;
      if (prior?.observation && ['confirmed', 'rejected', 'not-dispatched'].includes(prior.observation.kind)) {
        if (prior.observation.kind === 'confirmed') await observeProvider(scope);
        return prior.observation;
      }
      let original: ProviderCreation;
      if (prior) original = { installation: prior.installation, intent: prior.intent, credential: prior.credential };
      else {
        try { original = providers.capture(scope, target); }
        catch { return { kind: 'not-dispatched', source: 'host', evidence: null }; }
      }
      if (!prior) store.reserveCreation(original);
      const task = inFlight(async () => {
        const observed = await providers.execute(original, !prior, () => {
          authorized(scope);
          if (!prior) store.attemptCreation(original);
        });
        const settled = store.settleCreation(original, observed);
        if (settled.kind === 'confirmed' && !closed) await observeProvider(scope);
        return settled;
      });
      creating.set(key, task);
      try { return await task; } finally { creating.delete(key); }
    },
    installation(scope) { return store.findInstallation(authorized(scope)); },
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
    conversation(value: ConversationScope, actor?: FrontendSendActor): ConversationPort<E, P> {
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
          const target = store.findInstallation(scope);
          const provider = target && 'kind' in target;
          const driver = target && !('kind' in target) ? driverFor(target) : undefined;
          const registry = options.providers;
          const admit = () => store.admit(command, provider ? { kind: 'supported' } : command.body.kind === 'revoke-permission'
            ? { kind: 'unsupported', reason: 'permission-management-unsupported' } : driver?.capability(command) ??
            { kind: 'unsupported', reason: 'This conversation’s agent is unavailable or belongs to a different agent or workspace.' }, driver?.installation,
            registry ? (original, operation, action) => registry.captureCommand(original, action, operation) : undefined, actor);
          let admitted = admit();
          if (provider && command.body.kind === 'send' && admitted.kind === 'rejected' && admitted.reason === 'send-awaiting-confirmation') {
            const blocker = store.blockingSend(scope);
            if (!blocker || !('kind' in blocker) || blocker.receipt.state.kind !== 'accepted') return admitted;
            let receipt: Receipt | null;
            try { receipt = await host.reconcile(scope, blocker.command.clientCommandId, actor); }
            catch { return admitted; }
            if (receipt?.state.kind !== 'completed' && receipt?.state.kind !== 'rejected') return admitted;
            authorized(scope);
            admitted = admit();
          }
          if (admitted.kind === 'rejected') return admitted;
          if (admitted.kind === 'existing') return { kind: 'receipt', receipt: admitted.receipt };
          const stored = admitted.stored;
          const key = commandKey(scope, command.clientCommandId);
          return inFlight(async () => {
            dispatching.add(key);
            try {
              const observed = 'kind' in stored
                ? await registry?.executeCommand(stored.target, true, () => { authorized(scope); checkOwner(stored, actor, true); store.verifyIntent(stored); }) ?? { kind: 'not-dispatched', reason: 'provider-local-refusal' } as const
                : await dispatchNative(stored, driverFor, () => store.verifyIntent(stored));
              const receipt = store.settle(scope, command.clientCommandId, observed);
              checkOwner(stored, actor);
              return { kind: 'receipt' as const, receipt };
            } finally { dispatching.delete(key); }
          });
        },
        async receipt(id) {
          authorized(scope);
          const stored = store.command(scope, nonempty(id));
          checkOwner(stored, actor);
          return stored ? stored.receipt : null;
        },
        watch(request, receive) {
          authorized(scope);
          return journal.watch(scope, request, receive);
        },
      };
    },
    async reconcile(scope: ConversationScope, id: string, actor?: FrontendSendActor) {
      authorized(scope);
      const stored = store.command(scope, nonempty(id));
      if (!stored) return null;
      checkOwner(stored, actor);
      if (stored.observation?.kind === 'conclusive' && isQuarantined(stored)) {
        return store.settle(scope, id, stored.observation);
      }
      if (stored.observation?.kind === 'conclusive' || stored.observation?.kind === 'not-dispatched') return stored.receipt;
      return inFlight(async () => {
        const observed = 'kind' in stored
          ? await options.providers?.executeCommand(stored.target, false, () => { authorized(scope); checkOwner(stored, actor, true); store.verifyIntent(stored); }) ?? { kind: 'outcome-unknown' } as const
          : await reconcileNative(stored, driverFor(stored.target.installation));
        if (observed.kind === 'outcome-unknown' && dispatching.has(commandKey(scope, id))) {
          const current = store.command(scope, id);
          if (!current) throw new Error('Unknown command');
          checkOwner(current, actor);
          return current.receipt;
        }
        const receipt = store.settle(scope, id, observed);
        checkOwner(stored, actor);
        return receipt;
      });
    },
    frontendBinding(input, actor) {
      const scope = authorized(input.scope);
      return inFlight(() => recoverFrontendBinding({ request: { ...input, scope }, actor, owners: store.frontendSends,
        command: () => { authorized(scope); return store.command(scope, input.id); },
        transaction: work => store.transaction(work), reconcile: () => host.reconcile(scope, input.id, actor),
        producer: () => frontendToolsFor(host).producer(scope), providers: options.providers }));
    },
    close(): void {
      if (closed) return;
      closed = true;
      journal.close();
      if (!observing.size) { finishClosing(); return; }
      void inFlight(async () => {
        const entries = [...observing.values()];
        await Promise.all(entries.map(entry => entry.state.kind === 'starting' ? entry.state.task : undefined));
        const streams = entries.flatMap(entry => entry.state.kind === 'live' ? [entry.state.stream] : []);
        for (const stream of streams) {
          try { stream.close(); } catch { observationCleanupFailed = true; }
        }
        const results = await Promise.allSettled(streams.map(stream => stream.drained));
        if (results.some(result => result.status === 'rejected')) observationCleanupFailed = true;
      });
    },
  };
  registerFrontendToolsHost(host, {
    db: store.db,
    transaction: work => store.transaction(work),
    findInstallation: scope => store.findInstallation(scope),
    authorized,
  });
  return host;
}
