import { randomUUID } from 'node:crypto';
import type { RunAuthority } from '@agentui/contracts';
import { canonicalJson } from '@agentui/contracts';
import { identifier } from '@agentui/contracts/decode';
import { providerIdentity } from '@agentui/host';
import type { ProviderAuthority, ProviderIdentity } from '@agentui/host';
import type { CredentialHandle, ProviderInstance } from '@agentui/sdk';
import type { AccessDatabase } from './access-database.js';

export interface ProviderInstallation {
  readonly id: string;
  readonly instance: ProviderIdentity;
  readonly service: string;
  readonly expectedAuthority: RunAuthority['kind'];
  readonly authentication: { readonly kind: 'unauthenticated' } | {
    readonly kind: 'secret'; readonly revision: string; readonly resolve: () => Promise<string>;
  };
}
function origin(service: string): string {
  let url: URL;
  try { url = new URL(service); } catch { throw new Error('Provider authorization refused'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Provider authorization refused');
  }
  return url.origin;
}
function nonblank(value: string): string {
  if (!identifier(value).trim()) throw new Error('Provider authorization refused');
  return value;
}

/** Borrows Access's connection. Only grant metadata is persisted, never secrets. */
export function createProviderAuthority(state: AccessDatabase, namespace: string, installations: readonly ProviderInstallation[]): ProviderAuthority & { revoke(handle: string): void } {
  const configured = new Map(installations.map(installation => {
    const instance = providerIdentity(installation.instance);
    if (!['agentui-host', 'remote-provider'].includes(installation.expectedAuthority) || instance.namespace !== namespace) throw new Error('Provider authorization refused');
    const authentication: ProviderInstallation['authentication'] = installation.authentication.kind === 'secret'
      ? { kind: 'secret', revision: nonblank(installation.authentication.revision), resolve: installation.authentication.resolve }
      : { kind: 'unauthenticated' };
    if (installation.authentication.kind !== 'secret' && installation.authentication.kind !== 'unauthenticated') throw new Error('Provider authorization refused');
    return [nonblank(installation.id), { instance, service: origin(installation.service), authentication, expectedAuthority: installation.expectedAuthority }];
  }));
  if (configured.size !== installations.length) throw new Error('Provider authorization refused');
  const pending = new Set<Promise<unknown>>(), admitted = new Map<string, string>();
  let active = true;
  function installationFor(id: string, instance: ProviderIdentity) {
    const installation = configured.get(id);
    if (!active || !installation || canonicalJson(installation.instance) !== canonicalJson(providerIdentity(instance))) {
      throw new Error('Provider authorization refused');
    }
    return installation;
  }
  function authorize<I extends string>(id: string, instance: ProviderInstance<I>, handle: CredentialHandle<I> | null): void {
    const installation = installationFor(id, instance);
    if (installation.authentication.kind === 'unauthenticated') {
      if (handle !== null) throw new Error('Provider authorization refused');
      return;
    }
    if (!handle || handle.kind !== 'credential-handle' || handle.hostId !== state.hostId ||
      canonicalJson(providerIdentity(handle.instance)) !== canonicalJson(installation.instance) || admitted.get(handle.opaqueHandle) !== id) {
      throw new Error('Provider authorization refused');
    }
    const row = state.database.prepare(`SELECT 1 FROM service_provider_credentials WHERE handle=? AND host=? AND namespace=?
      AND contribution=? AND installation=? AND generation=? AND protocol=? AND service=? AND revision=? AND revoked=0`).get(
      handle.opaqueHandle, state.hostId, namespace, id, instance.installationId, instance.generation,
      instance.protocolVersion, installation.service, installation.authentication.revision);
    if (!row) throw new Error('Provider authorization refused');
  }
  return {
    revoke(handle: string) {
      if (!active) throw new Error('Provider authorization refused');
      state.database.prepare('UPDATE service_provider_credentials SET revoked=1 WHERE handle=? AND host=? AND namespace=?').run(handle, state.hostId, namespace);
    },
    issue<I extends string>(id: string, supplied: ProviderInstance<I>) {
      const instance: ProviderInstance<I> = Object.freeze({ ...supplied });
      const installation = installationFor(id, instance);
      let credential: CredentialHandle<I> | null = null;
      if (installation.authentication.kind === 'secret') {
        const fields = [state.hostId, namespace, id, instance.installationId, instance.generation,
          instance.protocolVersion, installation.service, installation.authentication.revision];
        const previous = state.database.prepare(`SELECT handle, revoked FROM service_provider_credentials WHERE host=? AND namespace=?
          AND contribution=? AND installation=? AND generation=? AND protocol=? AND service=? AND revision=?`).get(...fields);
        if (previous && (previous.revoked !== 0 || typeof previous.handle !== 'string')) throw new Error('Provider authorization refused');
        const handle = typeof previous?.handle === 'string' ? previous.handle : randomUUID();
        if (!previous) state.database.prepare(`INSERT INTO service_provider_credentials
          (handle,host,namespace,contribution,installation,generation,protocol,service,revision,revoked) VALUES(?,?,?,?,?,?,?,?,?,0)`).run(handle, ...fields);
        admitted.set(handle, id);
        credential = Object.freeze({ kind: 'credential-handle', hostId: state.hostId, instance, opaqueHandle: handle });
      }
      const captured = credential;
      authorize(id, instance, captured);
      return { credential, expectedAuthority: installation.expectedAuthority, assertAuthorized: () => authorize(id, instance, captured) };
    },
    credentials: {
      use<I extends string, T>(request: { readonly credential: CredentialHandle<I>; readonly service: string }, action: (secret: string) => Promise<T>): Promise<T> {
        const task = Promise.resolve().then(async () => {
          try {
            const credential = request.credential, id = admitted.get(credential.opaqueHandle);
            if (!id) throw new Error('Provider authorization refused');
            authorize(id, credential.instance, credential);
            const installation = installationFor(id, credential.instance);
            if (installation.service !== origin(request.service) || installation.authentication.kind !== 'secret') throw new Error('Provider authorization refused');
            const secret = await installation.authentication.resolve();
            authorize(id, credential.instance, credential);
            if (typeof secret !== 'string' || !secret.trim()) throw new Error('Provider authorization refused');
            const result = await action(secret);
            authorize(id, credential.instance, credential);
            return result;
          } catch { throw new Error('Provider credential use refused'); }
        });
        pending.add(task);
        void task.then(() => pending.delete(task), () => pending.delete(task));
        return task;
      },
    },
    async close() {
      active = false;
      await Promise.allSettled(pending);
    },
  };
}
