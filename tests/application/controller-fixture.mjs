import { SERVICE_WIRE_VERSION, EXTENSION_SDK_VERSION, CODEX_SDK_RUNTIME, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
import { createApplicationController } from '../../apps/desktop/dist/application/application-controller.js';

export const scope = { hostId: 'host', conversationId: 'conversation' };
export const empty = () => ({ version: 2, route: null, pendingCreation: null });
export const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
export function fixture() {
  const images = new Map(), loads = [], selected = [], captured = new Map(), views = new Map(), drafts = new Map(), leases = [], created = [], submitted = [], cursors = [], feeds = [];
  let nextId = 0, hostId = 'host', feedCloses = 0, metadataCalls = 0;
  const behavior = { principalId: 'principal', frontendOffers: 'unsupported', binding: async request => ({ kind: 'pending', id: request.id }), select() {}, agents: null, runtime: RECORDED_RUNTIME, defaultId: 'default', agentLookup: null, catalog: async () => {}, metadata: async () => {}, acquire: async () => {}, reopen: async () => {}, close: () => {}, create: async () => {}, write: async () => {}, read: async () => {}, listing: async () => ({ ids: [], after: null, unreadable: 0 }),
    permissions: async () => ({ kind: 'available', observedAt: new Date().toISOString(), permissions: [] }),
    observation: async () => ({ kind: 'not-applicable' }), search: async () => ({ items: [], after: null }), submit: async () => { throw new Error('Reply lost'); } };
  function lease(viewId, failure) {
    const owner = { viewId, failure, closed: false, select() { behavior.select(); },
      async readView(host) { await behavior.read(); return views.get(`${viewId}/${host}`) ?? empty(); },
      async saveView(host, value) { if (owner.closed) throw new Error('Closed owner'); views.set(`${viewId}/${host}`, value); },
      savedViews: (...args) => behavior.listing(...args),
      async draftScopes(hostId, after) {
        const scopes = [...drafts.values()].filter(row => drafts.get(`${viewId}/${hostId}/${row.scope.conversationId}`) === row && row.scope.hostId === hostId && (after === null || row.scope.conversationId > after)).map(row => row.scope).sort((a, b) => a.conversationId < b.conversationId ? -1 : 1).slice(0, 100);
        return { scopes, after: scopes.length === 100 ? scopes.at(-1).conversationId : null };
      },
      drafts(onFailure) {
        return { load: async selected => { await behavior.load?.(selected, viewId); loads.push(`${viewId}/${selected.hostId}/${selected.conversationId}`); return drafts.get(`${viewId}/${selected.hostId}/${selected.conversationId}`) ?? null; },
          loadImage: async (selected, id) => images.get(`${viewId}/${selected.hostId}/${selected.conversationId}/${id}`)?.slice() ?? null,
          async save(value, image) {
            try { await behavior.write(); if (owner.closed) throw new Error('Closed owner'); const key = id => `${viewId}/${value.scope.hostId}/${value.scope.conversationId}/${id}`;
              for (const id of image?.remove ?? []) images.delete(key(id));
              if (image?.put) images.set(key(image.put.selectionId), image.put.bytes.slice());
              drafts.set(`${viewId}/${value.scope.hostId}/${value.scope.conversationId}`, value); }
            catch (error) { onFailure(error); throw error; }
          } };
      },
      close() { owner.closed = true; return behavior.close(owner); } };
    leases.push(owner);
    return owner;
  }
  const descriptor = (id = behavior.defaultId, runtime = behavior.runtime) => ({ id, label: id, runtime, imageInput: { kind: 'unsupported', reason: 'This agent cannot receive images.' }, frontendOffers: behavior.frontendOffers, commands: ['send', 'cancel', 'approve'], availability: { kind: 'ready' } });
  const connection = {
    frontendBinding: request => behavior.binding(request),
    async metadata() { metadataCalls++; await behavior.metadata(); return { hostId, principalId: behavior.principalId, agents: behavior.agents ?? [descriptor(), descriptor('other', CODEX_SDK_RUNTIME)], defaultAgentId: behavior.defaultId, compatibility: { wireVersion: behavior.wireVersion ?? SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION,
      nativeRuntime: behavior.runtime,
      desiredGitRevision: 'revision', appliedArtifact: { gitRevision: 'revision', artifactId: 'artifact' } } }; },
    async catalog(after) { const supplied = await behavior.catalog(after); cursors.push(after); return (supplied ?? (after === null ? Array.from({ length: 100 }, (_, n) => ({ hostId, conversationId: `c-${n}` })) : [])).map(scope => ({ scope, preview: null })); },
    async create(value, agentId) { created.push(value); selected.push(agentId); captured.set(value.conversationId, descriptor(agentId)); await behavior.create(); return value; },
    async conversationAgent(value) { return behavior.agentLookup ? behavior.agentLookup(value) : captured.get(value.conversationId) ?? descriptor(); },
    conversationPermissions: input => behavior.permissions(input),
    providerObservation: input => behavior.observation(input),
    search: (...args) => behavior.search(...args),
    async reconcile() { return null; },
    uploadImage: input => behavior.uploadImage(input),
    readImage: (selected, imageId) => behavior.readImage(selected, imageId),
    conversation(selected) { return { scope: selected,
      async submit(command) { submitted.push(command); return behavior.submit(command); },
      async receipt() { return null; },
      watch(request, receive) { const end = deferred(); const feed = { scope: selected, receive, ended: end.promise, finish: end.resolve, close() { feedCloses++; } }; feeds.push(feed); return feed; } }; },
  };
  const app = createApplicationController({ createConnection: () => connection,
    ownedViewStorage: { open: async failure => { await behavior.acquire(); return lease('original-view', failure); }, reopen: async (id, failure) => { await behavior.reopen(id); return lease(id, failure); } }, createId: () => behavior.uuids ? `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` : `id-${++nextId}` });
  return { app, views, drafts, loads, selected, captured, descriptor, leases, created, submitted, cursors, feeds, behavior,
    host: value => { hostId = value; }, feedCloses: () => feedCloses, metadataCalls: () => metadataCalls };
}

