import { observeProvider, ObservationFailure } from './provider-stream.js';
import type { ProviderStream, ProviderStreamStore } from './provider-stream.js';
import { randomUUID } from 'node:crypto';
import { canonicalJson, copyJson, parseConversationPermissions } from '@agentui/contracts';
import { identifier, record } from '@agentui/contracts/decode';
import { backendProviderContractVersion, checkExtensionEntrypoint, parseExtensionManifest, validateExtensionLifetime } from '@agentui/sdk';
import type { ConversationPermissions, ConversationScope, RunAuthority } from '@agentui/contracts';
import { providerTarget, providerOutcome, providerReference } from './provider-commands.js';
import type { ProviderTarget, ProviderObservation, ProviderAction } from './provider-commands.js';
import { creationBinding, creationIntent, creationObservation, providerCreation, providerIdentity } from './provider-creation.js';
import type { ProviderCreation, ProviderInstallation, CreationObservation, StoredCreation } from './provider-creation.js';
import type { BackendProvider, ConnectedProvider, CredentialHandle, ExtensionLifetime, ExtensionManifest,
  ProviderCommand, ProviderInstance, ProviderModel, ProviderPresentation, ServerExtensionEntry, ServerProviderCredentials } from '@agentui/sdk';

export { providerIdentity } from './provider-creation.js';
export type { ProviderIdentity } from './provider-creation.js';
import type { ProviderIdentity } from './provider-creation.js';
export interface ProviderAuthorization<I extends string> {
  readonly credential: CredentialHandle<I> | null;
  readonly expectedAuthority: RunAuthority['kind'];
  assertAuthorized(): void;
}
export interface ProviderAuthority {
  readonly credentials: ServerProviderCredentials;
  issue<I extends string>(id: string, instance: ProviderInstance<I>): ProviderAuthorization<I>;
  close(): Promise<void>;
}
export interface ProviderExtension {
  readonly manifest: ExtensionManifest;
  readonly entry: ServerExtensionEntry;
  readonly authority: ProviderAuthority;
  readonly dispose?: () => Promise<void>;
}
export interface DiscoveredProvider {
  readonly kind: 'available';
  readonly contributionId: string;
  readonly instance: ProviderIdentity;
  readonly expectedAuthority: RunAuthority['kind'];
  readonly capabilities: Readonly<Record<'create' | 'send' | 'cancel' | 'decide' | 'reconcile' | 'observe', boolean>>;
  readonly agents: readonly { readonly opaqueId: string; readonly name: string }[];
}
export type ProviderUnavailableCause = 'offline' | 'authentication-failed' | 'unauthorized' | 'version-unsupported' | 'invalid-installation';
export interface UnavailableProvider {
  readonly kind: 'unavailable';
  readonly contributionId: string;
  readonly instance: ProviderIdentity;
  readonly cause: ProviderUnavailableCause;
}
export type ProviderStatus = DiscoveredProvider | UnavailableProvider;
export const providerUnavailableReasons: Readonly<Record<ProviderUnavailableCause, string>> = Object.freeze({
  offline: 'The provider service is offline or unreachable. AgentUI checks again automatically.',
  'authentication-failed': 'The provider rejected the configured credential. Update the secret it uses; AgentUI checks again automatically.',
  unauthorized: 'The configured credential is not authorized for this provider. Grant it access; AgentUI checks again automatically.',
  'version-unsupported': 'The provider service version is unsupported. Install a compatible version; AgentUI checks again automatically.',
  'invalid-installation': 'The provider installation is invalid. Fix the extension configuration, then restart the host.',
});
const rediscoveryInterval = 30_000;
type RetryableCause = Exclude<ProviderUnavailableCause, 'invalid-installation'>;
export function isProviderUnavailableCause(value: unknown): value is ProviderUnavailableCause {
  return typeof value === 'string' && Object.hasOwn(providerUnavailableReasons, value);
}
function failureCause(kind: unknown): ProviderUnavailableCause {
  switch (kind) {
    case 'unavailable': return 'offline';
    case 'authentication-failed': case 'unauthorized': case 'version-unsupported': return kind;
    case 'unsupported': return 'version-unsupported';
    default: return 'invalid-installation';
  }
}

function text(value: unknown): string {
  const result = identifier(value);
  if (!result.trim()) throw new Error('Invalid provider identifier');
  return result;
}
function identityKey(value: unknown): string { return canonicalJson(providerIdentity(value)); }
function capability(value: unknown): boolean {
  const input = record(value);
  if (input.kind === 'supported') { record(value, ['kind']); return true; }
  if (input.kind === 'unsupported') { record(value, ['kind', 'reason']); text(input.reason); return false; }
  throw new Error('Invalid provider capability');
}
interface BoundProvider {
  discover(): Promise<ProviderStatus>;
  capture(scope: ConversationScope, selected: ProviderInstallation): ProviderCreation;
  execute(original: ProviderCreation, fresh: boolean, beforeEffect: () => void): Promise<CreationObservation>;
  readPermissions(original: StoredCreation): Promise<ConversationPermissions>;
  captureCommand(original: StoredCreation, action: ProviderAction, operationId: string): ProviderTarget;
  executeCommand(original: ProviderTarget, fresh: boolean, beforeEffect: () => void): Promise<ProviderObservation>;
  observe(original: StoredCreation, store: ProviderStreamStore, freshSnapshot?: boolean): Promise<ProviderStream>;
  matches(selected: ProviderInstallation): boolean;
  close(): Promise<void>;
}
function bindProvider<M extends ProviderModel, I extends string>(id: string, backend: BackendProvider<M, I>,
  presentation: ProviderPresentation<M, I>, authority: ProviderAuthority): BoundProvider {
  type Attempt = { readonly kind: 'connected'; readonly backend: ConnectedProvider<M, I> }
    | { readonly kind: 'refused'; readonly cause: RetryableCause }
    | { readonly kind: 'invalid'; readonly backend: ConnectedProvider<M, I> | undefined };
  type Connection = { readonly kind: 'connected'; readonly backend: ConnectedProvider<M, I> } | { readonly kind: 'unavailable'; readonly cause: ProviderUnavailableCause };
  type State = { readonly kind: 'idle' | 'retired' }
    | { readonly kind: 'connecting'; readonly attempt: Promise<Attempt>; readonly settled: Promise<Connection> }
    | { readonly kind: 'connected'; readonly backend: ConnectedProvider<M, I> };
  const instance: ProviderInstance<I> = Object.freeze({ ...presentation.instance });
  const identity = providerIdentity(instance), key = identityKey(instance);
  const retired: Connection = { kind: 'unavailable', cause: 'invalid-installation' };
  let state: State = { kind: 'idle' };
  let authorization: ProviderAuthorization<I> | undefined;
  let released: Promise<void> = Promise.resolve();
  let cleanupFailed = false;
  let discovering: Promise<ProviderStatus> | undefined;
  function assertAuthorized(): ProviderAuthorization<I> {
    if (state.kind === 'retired' || !authorization) throw new Error('Provider unavailable');
    authorization.assertAuthorized();
    return authorization;
  }
  function release(next: { readonly kind: 'idle' | 'retired' }): void {
    const previous = state;
    state = next;
    const held = previous.kind === 'connected' ? Promise.resolve(previous.backend)
      : previous.kind === 'connecting' ? previous.attempt.then(result => result.kind === 'refused' ? undefined : result.backend) : undefined;
    if (!held) return;
    const closed = held.then(acquired => acquired?.close()).catch(() => { cleanupFailed = true; });
    released = Promise.all([released, closed]).then(() => {});
  }
  async function attempt(): Promise<Attempt> {
    let acquired: ConnectedProvider<M, I> | undefined;
    try {
      authorization = authority.issue(id, instance);
      assertAuthorized();
      const result = await backend.connect({ apiVersion: backendProviderContractVersion, instance, credential: authorization.credential });
      if (result.kind !== 'connected') {
        const cause = failureCause(result.kind);
        return cause === 'invalid-installation' ? { kind: 'invalid', backend: undefined } : { kind: 'refused', cause };
      }
      acquired = result.backend;
      assertAuthorized();
      if (identityKey(acquired.instance) !== key || typeof acquired.close !== 'function' || typeof acquired.discover !== 'function' ||
        (acquired.permissions && [acquired.permissions.read, acquired.permissions.revoke, acquired.permissions.reconcileRevoke].some(method => typeof method !== 'function'))) {
        throw new Error('Invalid provider connection');
      }
      return { kind: 'connected', backend: acquired };
    } catch { return { kind: 'invalid', backend: acquired }; }
  }
  function connect(): Promise<Connection> {
    switch (state.kind) {
      case 'retired': return Promise.resolve(retired);
      case 'connecting': return state.settled;
      case 'connected': return Promise.resolve({ kind: 'connected', backend: state.backend });
    }
    const pending = attempt();
    const settled = pending.then((result): Connection => {
      if (state.kind !== 'connecting' || state.attempt !== pending) return retired;
      switch (result.kind) {
        case 'connected': state = { kind: 'connected', backend: result.backend }; return result;
        case 'refused': state = { kind: 'idle' }; return { kind: 'unavailable', cause: result.cause };
        case 'invalid': release({ kind: 'retired' }); return retired;
      }
    });
    state = { kind: 'connecting', attempt: pending, settled };
    return settled;
  }
  async function acquire(): Promise<ConnectedProvider<M, I>> {
    const result = await connect();
    if (result.kind !== 'connected') throw new Error('Provider unavailable');
    return result.backend;
  }
  async function close(): Promise<void> {
    if (state.kind !== 'retired') release({ kind: 'retired' });
    await released;
    if (cleanupFailed) throw new Error('Provider cleanup failed');
  }
  async function discover(): Promise<ProviderStatus> {
    const unavailable = (cause: ProviderUnavailableCause): ProviderStatus => ({ kind: 'unavailable', contributionId: id, instance: identity, cause });
    const connection = await connect();
    if (connection.kind !== 'connected') return unavailable(connection.cause);
    const current = connection.backend;
    try {
      assertAuthorized();
      const capabilities = record(current.capabilities, ['create', 'send', 'cancel', 'decide', 'reconcile', 'observe']);
      const normalized = { create: capability(capabilities.create), send: capability(capabilities.send),
        cancel: capability(capabilities.cancel), decide: capability(capabilities.decide),
        reconcile: capability(capabilities.reconcile), observe: capability(capabilities.observe) };
      const result = record(copyJson(await current.discover()));
      const { expectedAuthority } = assertAuthorized();
      if (result.kind !== 'available') {
        record(result, ['kind', 'reason']);
        const cause = failureCause(result.kind);
        if (cause === 'invalid-installation') throw new Error('Invalid discovery');
        // Capabilities are probed at connect, so an upgraded service is only seen through a fresh connection.
        if (cause === 'version-unsupported' && state.kind === 'connected' && state.backend === current) release({ kind: 'idle' });
        return unavailable(cause);
      }
      record(result, ['kind', 'agents']);
      if (!Array.isArray(result.agents) || result.agents.length > 1000) throw new Error('Invalid discovery');
      const seen = new Set<string>();
      const agents = result.agents.map(value => {
        const agent = record(value, ['ref', 'name']), ref = record(agent.ref, ['instance', 'kind', 'opaqueId']);
        const opaqueId = text(ref.opaqueId);
        if (ref.kind !== 'agent' || identityKey(ref.instance) !== key || seen.has(opaqueId)) throw new Error('Invalid provider agent');
        seen.add(opaqueId);
        return { opaqueId, name: text(agent.name) };
      });
      return { kind: 'available', contributionId: id, instance: identity, expectedAuthority, capabilities: normalized, agents };
    } catch {
      if (state.kind !== 'retired') release({ kind: 'retired' });
      return unavailable('invalid-installation');
    }
  }
  function validate(selected: ProviderInstallation): ProviderAuthorization<I> {
    const granted = assertAuthorized();
    if (selected.contributionId !== id || identityKey(selected.instance) !== key || selected.expectedAuthority !== granted.expectedAuthority) {
      throw new Error('Provider unavailable');
    }
    return granted;
  }
  return {
    matches: selected => selected.contributionId === id && identityKey(selected.instance) === key,
    capture(scope, selected) {
      const granted = validate(selected);
      return providerCreation({ installation: selected, credential: granted.credential,
        intent: { kind: 'create', operationId: randomUUID(), scope,
          agent: { kind: 'agent', instance: identity, opaqueId: selected.agent.opaqueId } } }, scope);
    },
    async observe(original, store, freshSnapshot) {
      const authorize = () => {
        if (state.kind === 'retired' || !authorization) throw new ObservationFailure('original-provider-unavailable');
        try { authorization.assertAuthorized(); }
        catch { throw new ObservationFailure('original-credentials-unavailable'); }
        if (original.installation.expectedAuthority !== authorization.expectedAuthority ||
          canonicalJson(original.credential) !== canonicalJson(authorization.credential)) throw new ObservationFailure('original-credentials-unavailable');
      };
      authorize();
      if (original.observation?.kind !== 'confirmed') throw new ObservationFailure('original-binding-unavailable');
      const intent = creationIntent(original.intent, original.installation, instance);
      const binding = creationBinding(original.observation.binding, intent, original.installation);
      const connected = await acquire();
      authorize();
      if (!capability(connected.capabilities.observe)) throw new ObservationFailure('unsupported');
      return observeProvider(connected, presentation, { installation: original.installation, intent: original.intent,
        credential: original.credential }, binding, authorize, store, freshSnapshot);
    },
    async readPermissions(original) {
      const authorize = () => {
        const granted = validate(original.installation);
        if (canonicalJson(original.credential) !== canonicalJson(granted.credential)) throw new Error('Original credentials unavailable');
      };
      try {
        authorize();
        if (original.observation?.kind !== 'confirmed') throw new Error('Original binding unavailable');
        const intent = creationIntent(original.intent, original.installation, instance);
        const binding = creationBinding(original.observation.binding, intent, original.installation);
        const connected = await acquire();
        authorize();
        if (!connected.permissions) return { kind: 'unsupported', reason: 'This provider does not report permissions.' };
        const result = record(copyJson(await connected.permissions.read(binding)));
        authorize();
        if (result.kind !== 'available') {
          record(result, ['kind', 'reason']); text(result.reason);
          return { kind: result.kind === 'unsupported' ? 'unsupported' : 'unavailable', reason: 'Provider permissions unavailable.' };
        }
        record(result, ['kind', 'permissions']);
        if (!Array.isArray(result.permissions) || result.permissions.length > 1000 ||
          canonicalJson(binding) !== canonicalJson(original.observation.binding)) throw new Error('Invalid permissions');
        return parseConversationPermissions({ kind: 'available', observedAt: new Date().toISOString(), permissions: result.permissions.map(value => {
          const row = record(value, ['ref', 'scope', 'actionLabel', 'detail']);
          const ref = providerReference(row.ref, binding, original.installation, 'permission', instance);
          return { permissionId: ref.ref.opaqueId, scope: row.scope, actionLabel: row.actionLabel, detail: row.detail };
        }) });
      } catch { return { kind: 'unavailable', reason: 'Original provider permissions unavailable.' }; }
    },
    captureCommand(original, action, operationId) {
      const granted = validate(original.installation);
      if (original.observation?.kind !== 'confirmed' || canonicalJson(original.credential) !== canonicalJson(granted.credential)) throw new Error('Provider unavailable');
      const intent = creationIntent(original.intent, original.installation, instance);
      const binding = creationBinding(original.observation.binding, intent, original.installation);
      const target = (operation: unknown) => providerTarget({ kind: 'provider', installation: original.installation, credential: original.credential, operation }, intent.scope);
      if (action.kind === 'revoke-permission') {
        if (state.kind !== 'connected' || !state.backend.permissions) throw new Error('Permission management unavailable');
        return target({ kind: action.kind, operationId, binding, scope: action.scope,
          permission: { binding, ref: { kind: 'permission', instance, opaqueId: action.permissionId } } });
      }
      if (action.kind === 'send') {
        const request = copyJson(presentation.request(action.text, binding));
        if (canonicalJson(binding) !== canonicalJson(original.observation.binding)) throw new Error('Provider binding changed');
        const decoded = presentation.decodeRequest(copyJson(request));
        if (canonicalJson(decoded) !== canonicalJson(request)) throw new Error('Provider request changed');
        return target({ kind: 'send', operationId, binding, request });
      } else {
        const run = providerReference(action.run, binding, original.installation, 'run');
        return target(action.kind === 'cancel' ? { kind: 'cancel', operationId, binding, run }
          : { kind: 'decide', operationId, binding, run,
            decision: providerReference(action.decision, binding, original.installation, 'decision'),
            choice: providerReference(action.choice, binding, original.installation, 'choice') });
      }
    },
    async executeCommand(original, fresh, beforeEffect) {
      let entered = false;
      const authorize = () => {
        const granted = validate(original.installation);
        if (canonicalJson(original.credential) !== canonicalJson(granted.credential)) throw new Error('Provider unavailable');
      };
      try {
        authorize();
        const captured = original.operation;
        const intent = creationIntent(captured.binding.creation, original.installation, instance);
        const binding = creationBinding(captured.binding, intent, original.installation);
        const connected = await acquire();
        authorize();
        if (captured.kind === 'revoke-permission') {
          const manager = connected.permissions;
          if (!manager) throw new Error('Permission management unavailable');
          const operation = { operationId: captured.operationId, binding, scope: captured.scope,
            permission: providerReference(captured.permission, binding, original.installation, 'permission', instance) };
          beforeEffect();
          authorize();
          entered = true;
          const result = await (fresh ? manager.revoke(operation) : manager.reconcileRevoke(operation));
          authorize();
          return providerOutcome(result, original, fresh);
        }
        let operation: ProviderCommand<M, I>;
        const operationId = captured.operationId;
        if (captured.kind === 'send') {
          const request = presentation.decodeRequest(copyJson(captured.request));
          if (canonicalJson(request) !== canonicalJson(captured.request)) throw new Error('Provider request changed');
          operation = { kind: 'send', operationId, binding, request };
        } else if (captured.kind === 'cancel') {
          operation = { kind: 'cancel', operationId, binding, run: providerReference(captured.run, binding, original.installation, 'run', instance) };
        } else {
          providerReference(captured.run, binding, original.installation, 'run', instance);
          operation = { kind: 'decide', operationId, binding,
            decision: providerReference(captured.decision, binding, original.installation, 'decision', instance),
            choice: providerReference(captured.choice, binding, original.installation, 'choice', instance) };
        }
        if (!capability(connected.capabilities.reconcile) || (fresh && !capability(connected.capabilities[captured.kind]))) throw new Error('Provider command unavailable');
        beforeEffect();
        authorize();
        entered = true;
        const result = await (fresh ? connected.submit(operation) : connected.reconcileCommand(operation));
        authorize();
        return providerOutcome(result, original, fresh);
      } catch {
        return fresh && !entered ? { kind: 'not-dispatched', reason: 'provider-local-refusal' } : { kind: 'outcome-unknown' };
      }
    },
    async execute(original, fresh, beforeEffect) {
      const source = fresh ? 'create' : 'lookup';
      let entered = false;
      try {
        const granted = validate(original.installation);
        if (canonicalJson(original.credential) !== canonicalJson(granted.credential)) throw new Error('Provider unavailable');
        const operation = creationIntent(original.intent, original.installation, instance);
        const connected = await acquire();
        validate(original.installation);
        if (!capability(connected.capabilities[fresh ? 'create' : 'reconcile'])) {
          return { kind: fresh ? 'not-dispatched' : 'uncertain', source, evidence: null };
        }
        beforeEffect();
        validate(original.installation);
        entered = true;
        const result = record(copyJson(await (fresh ? connected.create(operation) : connected.reconcileCreation(operation))));
        validate(original.installation);
        if (result.kind === 'confirmed') {
          record(result, ['kind', 'value', 'evidence']);
          return creationObservation({ kind: 'confirmed', source, binding: result.value, evidence: result.evidence }, original);
        }
        if (result.kind === 'pending' || result.kind === 'rejected' || result.kind === 'uncertain') {
          record(result, result.kind === 'pending' ? ['kind', 'evidence'] : ['kind', 'reason', 'evidence']);
          if (result.kind !== 'pending') text(result.reason);
          return creationObservation({ kind: result.kind, source, evidence: result.evidence }, original);
        }
        record(result, ['kind', 'reason']);
        text(result.reason);
        if (!['not-dispatched', 'unsupported', 'unavailable', 'authentication-failed', 'unauthorized', 'version-unsupported'].includes(String(result.kind))) {
          throw new Error('Invalid creation outcome');
        }
        return { kind: fresh ? 'not-dispatched' : 'uncertain', source, evidence: { kind: String(result.kind) } };
      } catch {
        if (fresh && !entered) return { kind: 'not-dispatched', source: 'host', evidence: null };
        return { kind: 'uncertain', source, evidence: null };
      }
    },
    discover() {
      discovering ??= discover().finally(() => { discovering = undefined; });
      return discovering;
    }, close,
  };
}

/** Imported entries are full-trust server code; this registry is not a sandbox. */
export function createProviderRegistry(extensions: readonly ProviderExtension[]) {
  const bindings: BoundProvider[] = [], lifetimes: ExtensionLifetime[] = [];
  const pending = new Set<Promise<unknown>>();
  const streams = new Set<ProviderStream>();
  let retiring: Set<ProviderStream> | undefined;
  let cleanupFailed = false;
  let phase: 'new' | 'activating' | 'active' | 'closing' = 'new';
  let closing: Promise<void> | undefined;
  let catalog: readonly ProviderStatus[] = [];
  let discoveredAt = 0;
  let background: Promise<unknown> | undefined;
  function status(selected: Pick<ProviderInstallation, 'contributionId' | 'instance'>): ProviderStatus | undefined {
    return catalog.find(provider => provider.contributionId === selected.contributionId && identityKey(provider.instance) === identityKey(selected.instance));
  }
  function available(selected: ProviderInstallation): DiscoveredProvider | undefined {
    const found = status(selected);
    return found?.kind === 'available' ? found : undefined;
  }
  function track<T>(operation: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(operation);
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  async function refresh(): Promise<readonly ProviderStatus[]> {
    discoveredAt = Date.now();
    const results = await Promise.all(bindings.map(binding => binding.discover()));
    if (phase !== 'active') throw new Error('Provider discovery failed');
    catalog = results;
    return structuredClone(catalog);
  }
  // Reads never wait on backend I/O; a retryable outage is rediscovered behind the response, at most once per interval.
  function rediscover(): void {
    if (phase !== 'active' || background || Date.now() - discoveredAt < rediscoveryInterval ||
      !catalog.some(provider => provider.kind === 'unavailable' && provider.cause !== 'invalid-installation')) return;
    background = refresh().catch(() => {}).finally(() => { background = undefined; });
  }
  function stop(stream: ProviderStream): void {
    try { stream.close(); } catch { cleanupFailed = true; }
  }
  function close(): Promise<void> {
    if (closing) return closing;
    phase = 'closing';
    const draining = new Set(streams);
    retiring = draining;
    const authorities: Promise<void>[] = [];
    // Cleanup can reenter close(), so publish first. The microtask reads authorityResults after initialization.
    closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...pending, background]);
      for (const stream of draining) stop(stream);
      const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([...draining].map(stream => stream.drained));
      results.push(...await Promise.allSettled(bindings.map(binding => binding.close())));
      results.push(...await authorityResults);
      results.push(...await Promise.allSettled(lifetimes.map(lifetime => Promise.resolve().then(() => lifetime.dispose()))));
      results.push(...await Promise.allSettled(extensions.map(extension => Promise.resolve().then(() => extension.dispose?.()))));
      catalog = [];
      if (cleanupFailed || results.some(result => result.status === 'rejected')) throw new Error('Provider cleanup failed');
    });
    for (const extension of extensions) {
      try { authorities.push(extension.authority.close()); } catch { cleanupFailed = true; }
    }
    const authorityResults = Promise.allSettled(authorities);
    for (const stream of draining) stop(stream);
    return closing;
  }
  return {
    activity(): { readonly phase: typeof phase; readonly pending: number } { return { phase, pending: pending.size }; },
    activate(): Promise<void> {
      if (phase !== 'new') return Promise.reject(new Error('Provider activation unavailable'));
      phase = 'activating';
      return track(async () => {
        try {
          const identities = new Set<string>(), namespaces = new Set<string>();
          for (const extension of extensions) {
            const manifest = parseExtensionManifest(extension.manifest);
            if (phase !== 'activating' || namespaces.has(manifest.namespace) ||
              checkExtensionEntrypoint(manifest, 'server', extension.entry).kind !== 'compatible') throw new Error('Invalid provider extension');
            namespaces.add(manifest.namespace);
            const ids = new Set<string>();
            let registering = true;
            let invalid = false;
            let lifetime: ExtensionLifetime;
            try {
              lifetime = await extension.entry.activate({ namespace: manifest.namespace, credentials: extension.authority.credentials,
                providers: { add(id, backend, presentation) {
                  try {
                    if (!registering || phase !== 'activating') throw new Error('Registration closed');
                    text(id);
                    const identity = providerIdentity(presentation.instance), key = identityKey(identity);
                    if (identity.namespace !== manifest.namespace || ids.has(id) || identities.has(key) ||
                      backend.apiVersion !== backendProviderContractVersion || typeof backend.connect !== 'function' ||
                      [presentation.decodeRequest, presentation.decodeCursor, presentation.decodeState, presentation.decodeEvent,
                        presentation.request, presentation.snapshot, presentation.apply].some(callback => typeof callback !== 'function')) {
                      throw new Error('Invalid provider registration');
                    }
                    ids.add(id); identities.add(key);
                    bindings.push(bindProvider(id, backend, presentation, extension.authority));
                  } catch { invalid = true; throw new Error('Invalid provider registration'); }
                } },
              });
            } finally { registering = false; }
            validateExtensionLifetime(lifetime);
            lifetimes.push(lifetime);
            if (invalid || phase !== 'activating') throw new Error('Provider activation failed');
          }
          phase = 'active';
        } catch {
          void close().catch(() => {});
          throw new Error('Provider activation failed');
        }
      });
    },
    discover(): Promise<readonly ProviderStatus[]> {
      if (phase !== 'active') return Promise.reject(new Error('Provider discovery unavailable'));
      return track(refresh);
    },
    catalog(): readonly ProviderStatus[] {
      if (phase !== 'active') return [];
      rediscover();
      return structuredClone(catalog);
    },
    statusOf(selected: Pick<ProviderInstallation, 'contributionId' | 'instance'>): ProviderStatus | undefined {
      if (phase !== 'active') return undefined;
      const found = status(selected);
      return found && structuredClone(found);
    },
    capture(scope: ConversationScope, selected: ProviderInstallation): ProviderCreation {
      if (phase !== 'active') throw new Error('Provider unavailable');
      const discovered = available(selected);
      if (!discovered?.agents.some(agent => agent.opaqueId === selected.agent.opaqueId)) throw new Error('Provider agent unavailable');
      const binding = bindings.find(binding => binding.matches(selected));
      if (!binding) throw new Error('Provider unavailable');
      return binding.capture(scope, selected);
    },
    captureCommand(original: StoredCreation, action: ProviderAction, operationId: string): ProviderTarget {
      if (phase !== 'active') throw new Error('Provider unavailable');
      const selected = original.installation;
      const discovered = available(selected);
      const binding = bindings.find(binding => binding.matches(selected));
      if (!binding || !discovered || (action.kind !== 'revoke-permission' && (!discovered.capabilities[action.kind] || !discovered.capabilities.reconcile)) ||
        !discovered.agents.some(agent => agent.opaqueId === selected.agent.opaqueId)) throw new Error('Provider command unavailable');
      return binding.captureCommand(original, action, operationId);
    },
    readPermissions(original: StoredCreation): Promise<ConversationPermissions> {
      return track(async () => {
        const binding = bindings.find(binding => binding.matches(original.installation));
        if (phase !== 'active' || !binding) return { kind: 'unavailable', reason: 'Original provider unavailable.' };
        return binding.readPermissions(original);
      });
    },
    observe(original: StoredCreation, store: ProviderStreamStore, freshSnapshot?: boolean): Promise<ProviderStream> {
      return track(async () => {
        const binding = bindings.find(binding => binding.matches(original.installation));
        if (cleanupFailed) throw new ObservationFailure('cleanup-failed');
        if (phase !== 'active' || !binding) throw new ObservationFailure('original-provider-unavailable');
        const stream = await binding.observe(original, store, freshSnapshot);
        streams.add(stream);
        void stream.drained.then(() => streams.delete(stream), () => { cleanupFailed = true; streams.delete(stream); });
        if (phase !== 'active') { retiring?.add(stream); stop(stream); }
        return stream;
      });
    },
    executeCommand(original: ProviderTarget, fresh: boolean, beforeEffect: () => void): Promise<ProviderObservation> {
      return track(async () => {
        if (phase !== 'active') return fresh ? { kind: 'not-dispatched', reason: 'provider-local-refusal' } : { kind: 'outcome-unknown' };
        const binding = bindings.find(binding => binding.matches(original.installation));
        if (!binding) return fresh ? { kind: 'not-dispatched', reason: 'provider-local-refusal' } : { kind: 'outcome-unknown' };
        return binding.executeCommand(original, fresh, beforeEffect);
      });
    },
    execute(original: ProviderCreation, fresh: boolean, beforeEffect: () => void): Promise<CreationObservation> {
      return track(async () => {
        const binding = bindings.find(binding => binding.matches(original.installation));
        if (phase !== 'active' || !binding) return { kind: fresh ? 'not-dispatched' : 'uncertain', source: fresh ? 'create' : 'lookup', evidence: null };
        return binding.execute(original, fresh, beforeEffect);
      });
    }, close,
  };
}

export type ProviderCreationOperations = Pick<ReturnType<typeof createProviderRegistry>, 'capture' | 'execute'>;
export type ProviderConversationOperations = Pick<ReturnType<typeof createProviderRegistry>, 'captureCommand' | 'executeCommand' | 'observe' | 'readPermissions'>;
