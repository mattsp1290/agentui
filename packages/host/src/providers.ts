import { randomUUID } from 'node:crypto';
import { canonicalJson, copyJson } from '@agentui/contracts';
import { identifier, record } from '@agentui/contracts/decode';
import { backendProviderContractVersion, checkExtensionEntrypoint, parseExtensionManifest, validateExtensionLifetime } from '@agentui/sdk';
import type { ConversationScope, RunAuthority } from '@agentui/contracts';
import { creationIntent, creationObservation, providerCreation, providerIdentity } from './provider-creation.js';
import type { ProviderCreation, ProviderInstallation, CreationObservation } from './provider-creation.js';
import type { BackendProvider, ConnectedProvider, CredentialHandle, ExtensionLifetime, ExtensionManifest,
  ProviderInstance, ProviderModel, ProviderPresentation, ServerExtensionEntry, ServerProviderCredentials } from '@agentui/sdk';

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
}
export interface DiscoveredProvider {
  readonly contributionId: string;
  readonly instance: ProviderIdentity;
  readonly expectedAuthority: RunAuthority['kind'];
  readonly capabilities: Readonly<Record<'create' | 'send' | 'cancel' | 'decide' | 'reconcile' | 'observe', boolean>>;
  readonly agents: readonly { readonly opaqueId: string; readonly name: string }[];
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
  discover(): Promise<DiscoveredProvider>;
  capture(scope: ConversationScope, selected: ProviderInstallation): ProviderCreation;
  execute(original: ProviderCreation, fresh: boolean, beforeEffect: () => void): Promise<CreationObservation>;
  matches(selected: ProviderInstallation): boolean;
  close(): Promise<void>;
}
function bindProvider<M extends ProviderModel, I extends string>(id: string, backend: BackendProvider<M, I>,
  presentation: ProviderPresentation<M, I>, authority: ProviderAuthority, failed: () => void): BoundProvider {
  const instance: ProviderInstance<I> = Object.freeze({ ...presentation.instance });
  const identity = providerIdentity(instance), key = identityKey(instance);
  let authorization: ProviderAuthorization<I> | undefined;
  let connection: Promise<ConnectedProvider<M, I>> | undefined;
  let acquired: ConnectedProvider<M, I> | undefined;
  let closing: Promise<void> | undefined;
  let discovering: Promise<DiscoveredProvider> | undefined;
  function assertAuthorized(): ProviderAuthorization<I> {
    if (closing || !authorization) throw new Error('Provider unavailable');
    authorization.assertAuthorized();
    return authorization;
  }
  function connect(): Promise<ConnectedProvider<M, I>> {
    connection ??= Promise.resolve().then(async () => {
      authorization = authority.issue(id, instance);
      assertAuthorized();
      const result = await backend.connect({ apiVersion: backendProviderContractVersion, instance, credential: authorization.credential });
      if (result.kind !== 'connected') throw new Error('Provider unavailable');
      acquired = result.backend;
      assertAuthorized();
      if (identityKey(acquired.instance) !== key || typeof acquired.close !== 'function' || typeof acquired.discover !== 'function') {
        throw new Error('Invalid provider connection');
      }
      return acquired;
    });
    return connection;
  }
  function close(): Promise<void> {
    closing ??= Promise.resolve().then(async () => {
      await connection?.catch(() => {});
      try { await acquired?.close(); } catch { throw new Error('Provider cleanup failed'); }
    });
    return closing;
  }
  async function discover(): Promise<DiscoveredProvider> {
    try {
      if (closing) throw new Error('Provider unavailable');
      const connected = await connect();
      assertAuthorized();
      const capabilities = record(connected.capabilities, ['create', 'send', 'cancel', 'decide', 'reconcile', 'observe']);
      const normalized = { create: capability(capabilities.create), send: capability(capabilities.send),
        cancel: capability(capabilities.cancel), decide: capability(capabilities.decide),
        reconcile: capability(capabilities.reconcile), observe: capability(capabilities.observe) };
      const result = record(copyJson(await connected.discover()), ['kind', 'agents']);
      assertAuthorized();
      if (result.kind !== 'available' || !Array.isArray(result.agents) || result.agents.length > 1000) throw new Error('Invalid discovery');
      const seen = new Set<string>();
      const agents = result.agents.map(value => {
        const agent = record(value, ['ref', 'name']), ref = record(agent.ref, ['instance', 'kind', 'opaqueId']);
        const opaqueId = text(ref.opaqueId);
        if (ref.kind !== 'agent' || identityKey(ref.instance) !== key || seen.has(opaqueId)) throw new Error('Invalid provider agent');
        seen.add(opaqueId);
        return { opaqueId, name: text(agent.name) };
      });
      return { contributionId: id, instance: identity, expectedAuthority: assertAuthorized().expectedAuthority, capabilities: normalized, agents };
    } catch {
      failed();
      await authority.close();
      await close();
      throw new Error('Provider discovery failed');
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
    async execute(original, fresh, beforeEffect) {
      const source = fresh ? 'create' : 'lookup';
      let entered = false;
      try {
        const granted = validate(original.installation);
        if (canonicalJson(original.credential) !== canonicalJson(granted.credential)) throw new Error('Provider unavailable');
        const operation = creationIntent(original.intent, original.installation, instance);
        const connected = await connect();
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
  let phase: 'new' | 'activating' | 'active' | 'closing' = 'new';
  let closing: Promise<void> | undefined;
  let catalog: readonly DiscoveredProvider[] = [];
  function track<T>(operation: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(operation);
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  async function close(): Promise<void> {
    if (closing) return closing;
    phase = 'closing';
    const authorities = extensions.map(extension => extension.authority.close());
    // Attach rejection handlers immediately while admitted calls drain.
    const authorityResults = Promise.allSettled(authorities);
    closing = (async () => {
      await Promise.allSettled(pending);
      const results = await authorityResults;
      results.push(...await Promise.allSettled(bindings.map(binding => binding.close())));
      results.push(...await Promise.allSettled(lifetimes.map(lifetime => Promise.resolve().then(() => lifetime.dispose()))));
      catalog = [];
      if (results.some(result => result.status === 'rejected')) throw new Error('Provider cleanup failed');
    })();
    return closing;
  }
  return {
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
                    bindings.push(bindProvider(id, backend, presentation, extension.authority, () => { void close().catch(() => {}); }));
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
    discover(): Promise<readonly DiscoveredProvider[]> {
      if (phase !== 'active') return Promise.reject(new Error('Provider discovery unavailable'));
      return track(async () => {
        const results = await Promise.allSettled(bindings.map(binding => binding.discover()));
        if (phase !== 'active' || results.some(result => result.status === 'rejected')) throw new Error('Provider discovery failed');
        catalog = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
        return structuredClone(catalog);
      });
    },
    capture(scope: ConversationScope, selected: ProviderInstallation): ProviderCreation {
      if (phase !== 'active') throw new Error('Provider unavailable');
      const discovered = catalog.find(provider => provider.contributionId === selected.contributionId && identityKey(provider.instance) === identityKey(selected.instance));
      if (!discovered?.agents.some(agent => canonicalJson(agent) === canonicalJson(selected.agent))) throw new Error('Provider agent unavailable');
      const binding = bindings.find(binding => binding.matches(selected));
      if (!binding) throw new Error('Provider unavailable');
      return binding.capture(scope, selected);
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
