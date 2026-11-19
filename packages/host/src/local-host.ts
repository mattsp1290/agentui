import { randomUUID } from 'node:crypto';
import { assertFrontendSendActor, FrontendAccessError } from './frontend-sends.js';
import type { FrontendSendActor } from './frontend-sends.js';
import type { FrontendBinding, FrontendBindingRequest } from '@agentui/contracts';
import type { FrontendToolProducer } from './frontend-tools/index.js';
import type { ImageAttachment, ImageId, ImageInputCapability, UploadId } from '@agentui/contracts/image';
import { observationFailure } from './provider-stream.js';
import type { ProviderStream } from './provider-stream.js';
import { canRetryObservation, canonicalJson, CORE_CATALOG_PAGE, parseCommand, parseScope, sameScope } from '@agentui/contracts';
import { identifier } from '@agentui/contracts/decode';
import type { OutputId, OutputListing, OutputRead, OutputFailure, ConversationClosure, ConversationPermissions, ConversationPort, ConversationScope, ContinuationRefusal, Projection, Receipt, Snapshot, ProviderObservationStatus } from '@agentui/contracts';
import type { ContinuationAction, ContinuationView } from '@agentui/contracts/service';
import { budgets, commandKey, isOffered, sendBlock } from './durable-model.js';
import { nonempty } from './codec.js';
import { installation, dispatchNative, reconcileNative } from './native-execution.js';
import { isQuarantined } from './settlement.js';
import type { HostBudgets, HostOutput, Installation, ProviderDriver, StoredCommand, OfferedStoredCommand } from './durable-model.js';
import { providerInstallationKey } from './provider-creation.js';
import type { ConversationInstallation, CreationPredecessor, ProviderInstallation, StoredCreation, CreationObservation, ProviderCreation } from './provider-creation.js';
import type { ProviderConversationOperations, ProviderCreationOperations } from './providers.js';
import { SqliteStore } from './sqlite-store.js';
import { Journal } from './journal.js';
import { registerFrontendToolsHost } from './frontend-tools-context.js';

/** Only a confirmed, concluded provider conversation without frontend observations can be continued. */
export class ContinuationRefused extends Error {}
export interface LocalHostOptions<E, P> {
  readonly path: string;
  readonly projection: Projection<E, P>;
  readonly driver: ProviderDriver<E> | readonly ProviderDriver<E>[];
  readonly authorize: (scope: ConversationScope) => boolean;
  readonly providers?: ProviderConversationOperations;
  readonly budgets?: Partial<HostBudgets>;
}
export interface LocalHost<E, P> {
  imageInput(target: ConversationInstallation | null): ImageInputCapability;
  uploadImage(scope: ConversationScope, uploader: string, uploadId: UploadId, name: string, bytes: Uint8Array): ImageAttachment;
  readImage(scope: ConversationScope, imageId: ImageId): { readonly attachment: ImageAttachment; readonly bytes: Uint8Array };
  readonly drained: Promise<void>;
  createConversation(scope: ConversationScope, target: Installation): void;
  /** The host copies a predecessor's provider binding from its own confirmed record, never from the caller. */
  createProviderConversation(scope: ConversationScope, target: ProviderInstallation, providers: ProviderCreationOperations,
    predecessor?: ConversationScope): Promise<CreationObservation>;
  creation(scope: ConversationScope): StoredCreation | null;
  /** `read` touches only the store, `check` only looks up unsettled successor attempts, and `start` posts at most one new attempt per predecessor at a time.
   * `check` and `start` answer within `continuationReplyMs`; work still in flight then continues, and a held lease reads as `starting`. */
  continuation(scope: ConversationScope, action: ContinuationAction, providers?: ProviderCreationOperations): Promise<ContinuationView>;
  conversationPermissions(scope: ConversationScope): Promise<ConversationPermissions>;
  conversationOutputs(scope: ConversationScope): Promise<OutputListing>;
  readOutput(scope: ConversationScope, id: OutputId): Promise<OutputRead>;
  observeProvider(scope: ConversationScope): Promise<void>;
  observationStatus(scope: ConversationScope): ProviderObservationStatus;
  retryObservation(scope: ConversationScope): Promise<ProviderObservationStatus>;
  listConversations(hostId: string, after: string | null, limit: number): readonly ConversationScope[];
  installation(scope: ConversationScope): ConversationInstallation | null;
  inspect(scope: ConversationScope): { readonly installation: ConversationInstallation; readonly snapshot: Snapshot<P> };
  append(scope: ConversationScope, output: HostOutput<E>): void;
  conversation(scope: ConversationScope, actor?: FrontendSendActor): ConversationPort<E, P>;
  reconcile(scope: ConversationScope, id: string, actor?: FrontendSendActor): Promise<Receipt | null>;
  /** Stops waiting on a provider send that blocks its conversation and is not being dispatched. Never says whether it took effect. */
  abandon(scope: ConversationScope, id: string, actor?: FrontendSendActor): Promise<Receipt | null>;
  frontendBinding(input: FrontendBindingRequest, actor: FrontendSendActor, producerFor: (scope: ConversationScope) => Pick<FrontendToolProducer, 'register'>): Promise<FrontendBinding>;
  close(): void;
}
export function openLocalHost<E, P>(options: LocalHostOptions<E, P>): LocalHost<E, P> {
  const store = new SqliteStore(options.path, options.projection, budgets(options.budgets));
  const configured = 'source' in options.driver ? [options.driver] : options.driver;
  const drivers = new Map(configured.map(driver => [canonicalJson(driver.installation), driver]));
  if (drivers.size !== configured.length) { store.close(); throw new Error('Duplicate agent installation'); }
  const driverFor = (target: Installation) => drivers.get(canonicalJson(target));
  const imageInput = (target: ConversationInstallation | null): ImageInputCapability =>
    target && !('kind' in target) && driverFor(target)?.imageInput === true
      ? { kind: 'supported', format: 'png-jpeg-v1' }
      : { kind: 'unsupported', reason: 'This model cannot read images.' };
  const journal = new Journal(store);
  store.onCommit = () => journal.wake();
  store.onProviderCommit = scope => { void Promise.resolve().then(() => settleEndedSend(scope)); };
  let closed = false, observationCleanupFailed = false;
  let active = 0;
  const dispatching = new Set<string>();
  const creating = new Map<string, Promise<CreationObservation>>();
  const continuing = new Map<string, Promise<boolean>>();
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
  const outputOperation = <T extends OutputListing | OutputRead>(value: ConversationScope,
    read: (providers: ProviderConversationOperations, original: StoredCreation) => Promise<T>): Promise<T | OutputFailure> => {
    const scope = authorized(value), original = store.creation(scope);
    if (!original) {
      const installed = store.findInstallation(scope);
      return Promise.resolve(installed && 'kind' in installed
        ? { kind: 'unavailable', reason: 'outputs-unavailable' }
        : { kind: 'unsupported', reason: 'outputs-unsupported' });
    }
    if (original.observation?.kind !== 'confirmed' || !options.providers) return Promise.resolve({ kind: 'unavailable', reason: 'outputs-unavailable' });
    const providers = options.providers;
    return inFlight(async () => {
      const result = await read(providers, original);
      authorized(scope);
      return result;
    });
  };
  const closure = (original: StoredCreation | null): ConversationClosure | null =>
    original?.observation?.kind === 'confirmed' ? options.providers?.closure?.(original, store) ?? null : null;
  // Without a loaded provider for its installation, a conversation's saved closure cannot be read, which does not make it open.
  const unserved = (original: StoredCreation | null): boolean => original?.observation?.kind === 'confirmed' &&
    (!options.providers || (options.providers.statusOf !== undefined && options.providers.statusOf(original.installation) === undefined));
  const observationStatus = (scope: ConversationScope): ProviderObservationStatus => {
    authorized(scope);
    const target = store.findInstallation(scope), original = store.creation(scope);
    if (!original && target && !('kind' in target)) return { kind: 'not-applicable' };
    if (original?.observation?.kind !== 'confirmed') return { kind: 'stopped', reason: 'original-binding-unavailable' };
    const cause = closure(original);
    if (cause) return { kind: 'concluded', cause };
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
    if (original?.observation?.kind !== 'confirmed' || !registry || closure(original)) return;
    const entry: Observation = { state: { kind: 'stopped', reason: 'recovery-failed' } };
    const task = inFlight(async () => {
      try {
        const stream = await Promise.resolve().then(() => registry.observe(original, store, freshSnapshot));
        entry.state = { kind: 'live', stream };
        settleEndedSend(scope);
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
  const assertMayReceiveEvidence = (stored: StoredCommand, actor?: FrontendSendActor) => {
    if (isOffered(stored)) authorized(stored.command.scope);
    store.frontendSends.authorize('evidence', stored, actor);
  };
  const ownedCommand = (scope: ConversationScope, id: string, actor?: FrontendSendActor) => {
    const stored = store.command(authorized(scope), nonempty(id));
    if (stored) assertMayReceiveEvidence(stored, actor);
    return stored;
  };
  const effectFence = (stored: StoredCommand, assertCallerAuthority: () => void) => {
    assertCallerAuthority();
    authorized(stored.command.scope);
    store.verifyIntent(stored);
  };
  const dispatchFence = (stored: StoredCommand, actor?: FrontendSendActor) => effectFence(stored, () => {
    store.frontendSends.authorize('dispatch', stored, actor);
  });
  const readOnce = (stored: StoredCommand, assertCallerAuthority: () => void, admitted: () => void): Promise<Receipt> => inFlight(async () => {
    if (stored.receipt.state.kind === 'abandoned') return stored.receipt;
    const { scope, clientCommandId: id } = stored.command;
    const observations = 'kind' in stored && stored.target.operation.kind === 'send' && stored.target.operation.observationProtocol
      ? (await import('./frontend-observations.js')).FrontendObservations : undefined;
    if (stored.observation?.kind === 'conclusive' && isQuarantined(stored)) return store.settle(scope, id, stored.observation, observations);
    if (stored.observation?.kind === 'conclusive' || stored.observation?.kind === 'not-dispatched') return stored.receipt;
    const observed = 'kind' in stored
      ? await options.providers?.executeCommand(stored, false, () => { effectFence(stored, assertCallerAuthority); admitted(); }) ?? { kind: 'outcome-unknown' } as const
      : await reconcileNative(stored, driverFor(stored.target.installation));
    if (observed.kind === 'outcome-unknown' && (isOffered(stored) || dispatching.has(commandKey(scope, id)))) {
      const current = store.command(scope, id);
      if (!current) throw new Error('Unknown command');
      return current.receipt;
    }
    return store.settle(scope, id, observed, observations);
  });
  type ReadOrigin = 'run-end' | 'caller';
  interface StatusRead { readonly origin: ReadOrigin; readonly receipt: Promise<Receipt> }
  // Overlapping reads of one provider command share one status read. An observed run end is not settlement evidence; it
  // triggers one status read per command per host process. Only a run-end read the provider admitted spends that attempt,
  // so a run end seen while the provider is being replaced, or met by a caller read that may predate it, is read again.
  const statusReads = new Map<string, StatusRead>(), runEndReads = new Set<string>();
  const reconcileStored = (stored: StoredCommand, origin: ReadOrigin, assertCallerAuthority: () => void): Promise<Receipt> => {
    const settled = stored.receipt.state.kind === 'abandoned' || stored.observation?.kind === 'conclusive' || stored.observation?.kind === 'not-dispatched';
    if (!('kind' in stored) || settled) return readOnce(stored, assertCallerAuthority, () => {});
    const key = commandKey(stored.command.scope, stored.command.clientCommandId);
    const running = statusReads.get(key);
    if (running) {
      try { effectFence(stored, assertCallerAuthority); } catch (error) { return Promise.reject(error); }
      return running.receipt;
    }
    const receipt = readOnce(stored, assertCallerAuthority, origin === 'run-end' ? () => runEndReads.add(key) : () => {});
    statusReads.set(key, { origin, receipt });
    const forget = () => { if (statusReads.get(key)?.receipt === receipt) statusReads.delete(key); };
    void receipt.then(forget, forget);
    return receipt;
  };
  const settleEndedSend = (scope: ConversationScope): void => {
    if (closed) return;
    let stored: StoredCommand | null;
    try { stored = store.endedSend(scope); } catch { return; }
    if (!stored) return;
    const key = commandKey(scope, stored.command.clientCommandId);
    if (dispatching.has(key) || runEndReads.has(key)) return;
    const running = statusReads.get(key);
    if (running?.origin === 'run-end') return;
    const again = () => settleEndedSend(scope);
    if (running) { void running.receipt.then(again, again); return; }
    void reconcileStored(stored, 'run-end', () => authorized(scope)).catch(() => {});
  };
  const settleSendBlocker = async (scope: ConversationScope, actor?: FrontendSendActor): Promise<boolean> => {
    const found = store.blockingSend(scope, 'provider');
    if (found?.block !== 'blocked-reconcilable' || dispatching.has(commandKey(scope, found.stored.command.clientCommandId))) return false;
    const blocker = found.stored;
    const assertRequester = () => {
      store.frontendSends.authorize('settle', blocker, actor);
      authorized(scope);
    };
    assertRequester();
    await reconcileStored(blocker, 'caller', assertRequester);
    assertRequester();
    return store.blockingSend(scope, 'provider') === null;
  };
  const continued = (value: ConversationScope, target: ProviderInstallation): { readonly from: CreationPredecessor; readonly credential: string } => {
    const source = store.creation(authorized(value));
    if (source?.observation?.kind !== 'confirmed' || providerInstallationKey(source.installation) !== providerInstallationKey(target)) {
      throw new Error('Creation predecessor unavailable');
    }
    return { from: { scope: source.intent.scope, binding: source.observation.binding.authority.binding }, credential: canonicalJson(source.credential) };
  };
  const unsettled = (creation: StoredCreation) => !creation.observation || creation.observation.kind === 'pending' || creation.observation.kind === 'uncertain';
  const refusal = (creation: StoredCreation): ContinuationRefusal => {
    const outcome = creation.observation?.kind === 'rejected' ? options.providers?.continuation?.(creation) : null;
    return outcome && 'refused' in outcome ? outcome.refused : 'unavailable';
  };
  const continuationView = (scope: ConversationScope, unrecorded = false): ContinuationView => {
    const original = store.creation(scope), attempts = store.successors(scope);
    const outcome = original?.intent.from && original.observation?.kind === 'confirmed' ? options.providers?.continuation?.(original) : null;
    const confirmed = attempts.find(creation => creation.observation?.kind === 'confirmed');
    const refused = attempts.findLast(creation => creation.observation?.kind === 'rejected' || creation.observation?.kind === 'not-dispatched');
    // A provider refusal of the newest attempt outranks older unsettled attempts: the provider had not sealed the predecessor
    // for them. `continued-elsewhere`, an unreadable refusal and a refusal by this host prove no such thing.
    const newest = unrecorded ? null : attempts.at(-1);
    const answered = newest?.observation?.kind === 'rejected' ? options.providers?.continuation?.(newest) : null;
    let successor: ContinuationView['successor'] = null;
    if (confirmed) successor = { kind: 'confirmed', scope: confirmed.intent.scope };
    else if (continuing.has(canonicalJson(scope))) successor = { kind: 'starting' };
    else if (attempts.some(creation => creation.observation?.kind === 'pending')) successor = { kind: 'pending' };
    else if (answered && 'refused' in answered && answered.refused !== 'continued-elsewhere') successor = { kind: 'refused', refusal: answered.refused };
    else if (attempts.some(unsettled)) successor = { kind: 'unconfirmed' };
    else if (unrecorded) successor = { kind: 'refused', refusal: 'unavailable' };
    else if (refused) successor = { kind: 'refused', refusal: refusal(refused) };
    return { predecessor: original?.intent.from?.scope ?? null, carried: outcome && !('refused' in outcome) ? outcome : null,
      closure: unserved(original) ? 'unknown' : closure(original), successor };
  };
  // Lookups only: an attempt that already left the host is never posted again.
  const checkSuccessors = async (scope: ConversationScope, providers: ProviderCreationOperations): Promise<void> => {
    await Promise.allSettled(store.successors(scope).filter(unsettled).map(creation =>
      host.createProviderConversation(creation.intent.scope, creation.installation, providers)));
  };
  const continuable = (scope: ConversationScope): StoredCreation => {
    const predecessor = store.creation(scope);
    if (predecessor?.observation?.kind !== 'confirmed' || !closure(predecessor) || store.hasFrontendObservations(scope)) {
      throw new ContinuationRefused('Conversation cannot be continued');
    }
    return predecessor;
  };
  /** Settles with `work`, or with `undefined` once the reply budget passes; `work` keeps running and its rejection stays handled. */
  const replyWithin = async <T>(work: Promise<T>): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), store.limits.continuationReplyMs); })]); }
    finally { clearTimeout(timer); }
  };
  /** Resolves true when the host refused the new attempt before recording it. */
  const startSuccessor = async (scope: ConversationScope, predecessor: StoredCreation, providers: ProviderCreationOperations): Promise<boolean> => {
    await checkSuccessors(scope, providers);
    // An uncertain attempt does not block a deliberate new one; the provider accepts at most one successor per predecessor.
    if (store.successors(scope).some(creation => !creation.observation || creation.observation.kind === 'confirmed' ||
      creation.observation.kind === 'pending' || creating.has(canonicalJson(creation.intent.scope)))) return false;
    const next = { hostId: scope.hostId, conversationId: randomUUID() };
    const result = await host.createProviderConversation(next, predecessor.installation, providers, scope);
    const recorded = store.creation(next);
    if (recorded && result.kind === 'rejected' && refusal(recorded) === 'continued-elsewhere') await checkSuccessors(scope, providers);
    return !recorded;
  };
  const host: LocalHost<E, P> = {
    imageInput,
    uploadImage: (scope, uploader, uploadId, name, bytes) => {
      const target = authorized(scope);
      return store.uploadImage(target, uploader, uploadId, name, bytes, imageInput(store.findInstallation(target)));
    },
    readImage: (scope, imageId) => store.readImage(authorized(scope), imageId),
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
    conversationOutputs: scope => outputOperation(scope, (providers, original) => providers.conversationOutputs(original)),
    readOutput: (scope, id) => outputOperation(scope, (providers, original) => providers.readOutput(original, id)),
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
    async continuation(value, action, providers) {
      const scope = authorized(value);
      if (action === 'read') return continuationView(scope);
      if (!providers || unserved(store.creation(scope))) throw new Error('Provider unavailable');
      if (action === 'check') {
        await replyWithin(inFlight(() => checkSuccessors(scope, providers)));
        return continuationView(authorized(scope));
      }
      const predecessor = continuable(scope), key = canonicalJson(scope);
      let lease = continuing.get(key);
      if (!lease) {
        lease = inFlight(() => startSuccessor(scope, predecessor, providers)).finally(() => continuing.delete(key));
        continuing.set(key, lease);
      }
      const unrecorded = await replyWithin(lease);
      return continuationView(authorized(scope), unrecorded === true);
    },
    async createProviderConversation(scope, target, providers, predecessor) {
      authorized(scope);
      const prior = store.creation(scope);
      if (!prior && store.findInstallation(scope)) throw new Error('Conversation already exists without provider creation provenance');
      if (prior && providerInstallationKey(prior.installation) !== providerInstallationKey(target)) throw new Error('Creation agent is immutable');
      if (prior && predecessor && !(prior.intent.from && sameScope(prior.intent.from.scope, predecessor))) throw new Error('Creation predecessor is immutable');
      const key = canonicalJson(scope), leased = creating.get(key);
      if (leased) return leased;
      if (prior?.observation && ['confirmed', 'rejected', 'not-dispatched'].includes(prior.observation.kind)) {
        if (prior.observation.kind === 'confirmed') await observeProvider(scope);
        return prior.observation;
      }
      let original: ProviderCreation;
      if (prior) original = { installation: prior.installation, intent: prior.intent, credential: prior.credential };
      else {
        const source = predecessor ? continued(predecessor, target) : undefined;
        try { original = providers.capture(scope, target, source?.from); }
        catch { return { kind: 'not-dispatched', source: 'host', evidence: null }; }
        // The caller supplies capture, so the captured intent must carry exactly the predecessor the host built, or none.
        if (canonicalJson(original.intent.from ?? null) !== canonicalJson(source?.from ?? null) ||
          (source && canonicalJson(original.credential) !== source.credential)) return { kind: 'not-dispatched', source: 'host', evidence: null };
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
          const assertSubmitter = () => { authorized(scope); if (actor) assertFrontendSendActor(actor); };
          const image = command.version === 1 && command.body.kind === 'send' && command.body.imageId !== undefined;
          const inputCapability = imageInput(target);
          const admit = () => store.admit(command, image && inputCapability.kind === 'unsupported'
            ? inputCapability : provider ? command.body.kind === 'send' && closure(store.creation(scope))
            ? { kind: 'unsupported', reason: 'conversation-closed' } : { kind: 'supported' } : command.version === 2
            ? { kind: 'unsupported', reason: 'frontend-offers-unsupported' } : command.body.kind === 'revoke-permission'
            ? { kind: 'unsupported', reason: 'permission-management-unsupported' } : driver?.capability(command) ??
            { kind: 'unsupported', reason: 'This conversation’s agent is unavailable or belongs to a different agent or workspace.' }, driver?.installation,
            registry ? (original, operation, action) => {
              const captured = registry.captureCommand(original, action, operation);
              assertSubmitter();
              return captured;
            } : undefined, actor);
          let admitted = admit();
          if (provider && command.body.kind === 'send' && admitted.kind === 'rejected' && admitted.reason === 'send-awaiting-confirmation') {
            try { if (!await settleSendBlocker(scope, actor)) return admitted; }
            catch { authorized(scope); return admitted; }
            assertSubmitter();
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
                ? await registry?.executeCommand(stored, true, () => dispatchFence(stored, actor)) ?? { kind: 'not-dispatched', reason: 'provider-local-refusal' } as const
                : await dispatchNative(stored, driverFor, () => store.verifyIntent(stored));
              const observations = 'kind' in stored && stored.target.operation.kind === 'send' && stored.target.operation.observationProtocol
                ? (await import('./frontend-observations.js')).FrontendObservations : undefined;
              const receipt = store.settle(scope, command.clientCommandId, observed, observations);
              assertMayReceiveEvidence(stored, actor);
              return { kind: 'receipt' as const, receipt };
            } finally {
              dispatching.delete(key);
              if (provider) settleEndedSend(scope);
            }
          });
        },
        async receipt(id) {
          const stored = ownedCommand(scope, id, actor);
          return stored ? stored.receipt : null;
        },
        watch(request, receive) {
          authorized(scope);
          return journal.watch(scope, request, receive);
        },
      };
    },
    async reconcile(scope: ConversationScope, id: string, actor?: FrontendSendActor) {
      const stored = ownedCommand(scope, id, actor);
      if (!stored) return null;
      const receipt = await reconcileStored(stored, 'caller', () => assertMayReceiveEvidence(stored, actor));
      assertMayReceiveEvidence(stored, actor);
      return receipt;
    },
    abandon(scope: ConversationScope, id: string, actor?: FrontendSendActor) {
      return inFlight(async () => {
        const stored = ownedCommand(scope, id, actor);
        if (!stored) return null;
        if (!('kind' in stored) || stored.command.body.kind !== 'send' || sendBlock('provider', stored) !== 'blocked-reconcilable' ||
          dispatching.has(commandKey(stored.command.scope, stored.command.clientCommandId))) return stored.receipt;
        store.frontendSends.authorize('settle', stored, actor);
        authorized(scope);
        return store.abandon(stored.command.scope, stored.command.clientCommandId);
      });
    },
    frontendBinding(input, actor, producerFor) {
      const scope = authorized(input.scope);
      return inFlight(async () => {
        const request = { ...input, scope };
        const owners = store.frontendSends;
        const identity = { scope, id: identifier(request.id) };
        const command = () => {
          const stored = ownedCommand(scope, identity.id, actor);
          if (stored && !isOffered(stored)) throw new FrontendAccessError('frontend-owner-missing');
          return stored;
        };
        const initial = command();
        const ownerFence = (stored: OfferedStoredCommand | null) => owners.ownerState(stored ?? identity, actor);
        ownerFence(initial);
        if (request.action === 'unavailable') {
          store.transaction(() => {
            const stored = command();
            if (stored) owners.markUnavailable(stored, actor);
            else owners.tombstone(identity, actor);
          });
          return { kind: 'unavailable', id: identity.id, reason: 'closures-unavailable' };
        } else if (initial && initial.observation?.kind !== 'conclusive' && initial.observation?.kind !== 'not-dispatched') {
          await host.reconcile(scope, identity.id, actor);
        }
        const stored = command(), state = ownerFence(stored);
        if (state === 'unavailable') return { kind: 'unavailable', id: identity.id, reason: 'closures-unavailable' };
        if (stored) {
          const observation = stored.observation;
          const run = observation && 'evidence' in observation ? observation.evidence.source.run : null;
          if (!run) {
            if (observation?.kind === 'not-dispatched') return { kind: 'unavailable', id: identity.id, reason: 'not-dispatched' };
            if (observation?.kind === 'conclusive' && observation.result.kind === 'rejected') return { kind: 'unavailable', id: identity.id, reason: 'provider-rejected' };
          }
          if (!options.providers) throw new Error('Original AG-UI provider unavailable');
          options.providers.assertFrontendInput(stored.target);
          ownerFence(stored);
          if (run) {
            const bound = { kind: 'bound', command: stored.command, hostOperationId: stored.receipt.hostOperationId,
              run: run.identity, threadId: stored.agui.threadId } satisfies FrontendBinding;
            const producer = producerFor(scope);
            producer.register({ identity: bound.run, threadId: bound.threadId, platform: bound.command.body.frontend.platform,
              bindings: bound.command.body.frontend.tools.map(tool => ({ ...tool, name: tool.definition.name })) });
            if (ownerFence(stored) === 'available') return bound;
          }
        }
        if (ownerFence(stored) === 'unavailable') return { kind: 'unavailable', id: identity.id, reason: 'closures-unavailable' };
        return { kind: 'pending', id: identity.id };
      });
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
    frontendTools: (factory, authorize) => store.frontendTools(factory, authorize),
    authorized,
  });
  return host;
}
