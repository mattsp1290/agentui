import { canonicalJson, parseFrontendBinding, sameScope } from '@agentui/contracts';
import type { ConversationScope, FrontendBinding, FrontendEligibility, OfferedCommand } from '@agentui/contracts';
import type { ServiceConnection, ServiceMetadata } from '@agentui/contracts/service';
import type { FrontendAdmission, FrontendJournal, FrontendRecoveryReference } from '@agentui/client';
import type { CaptureBorrow, CaptureStore } from './view-leases.js';
import { retainFrontendTools } from '@agentui/sdk/tools';
import type { FrontendToolGeneration, RetainedFrontendTools } from '@agentui/sdk/tools';

export type GenerationSnapshot = { readonly kind: 'transitioning' } | { readonly kind: 'ready'; readonly generations: readonly FrontendToolGeneration[] };
export interface GenerationSink {
  begin(token: object): void;
  publish(token: object, snapshot: GenerationSnapshot): void;
  clear(token: object): void;
}
type CapturedState =
  | { readonly status: 'waiting' | 'unavailable'; readonly binding: null }
  | { readonly status: 'bound'; readonly binding: Extract<FrontendBinding, { kind: 'bound' }> };
export type CapturedSend = CapturedState & {
  readonly key: string;
  readonly command: OfferedCommand;
  readonly viewId: string;
};
type Entry = { readonly key: string; readonly viewId: string; readonly reference: FrontendRecoveryReference; readonly journal: FrontendJournal; readonly recoveryNeeded: () => void;
  readonly retained: RetainedFrontendTools; readonly borrow: CaptureBorrow; row: CapturedSend & { readonly status: 'waiting' | 'bound' }; pending: boolean };
type ScopeHold = { readonly viewId: string; readonly scope: ConversationScope };
type Session = { readonly hostId: string; readonly principalId: string; readonly connection: ServiceConnection };
type Authority = { readonly session: Session | null; readonly lifetime: AbortController };
async function raceAbort<T>(request: () => Promise<T>, signals: readonly AbortSignal[]): Promise<T | null> {
  if (signals.some(signal => signal.aborted)) return null;
  let cancel = () => {};
  const cancelled = new Promise<null>(resolve => {
    cancel = () => resolve(null);
    for (const signal of signals) signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([request(), cancelled]); }
  finally { for (const signal of signals) signal.removeEventListener('abort', cancel); }
}
export interface GenerationSource extends GenerationSink {
  snapshot(): GenerationSnapshot;
}
export function createGenerationSource(): GenerationSource {
  let token: object | null = null, generations: GenerationSnapshot = { kind: 'transitioning' };
  return {
    begin(owner) { token = owner; generations = { kind: 'transitioning' }; },
    publish(owner, value) { if (token === owner) generations = value; },
    clear(owner) { if (token === owner) { token = null; generations = { kind: 'transitioning' }; } },
    snapshot: () => generations,
  };
}
export type FrontendSends = ReturnType<typeof createFrontendSends>;
export function createFrontendSends(deps: {
  readonly generations: Pick<GenerationSource, 'snapshot'>;
  rowsChanged(): void;
}) {
  let closed = false;
  let authority: Authority = { session: null, lifetime: new AbortController() };
  let timer: ReturnType<typeof setTimeout> | undefined;
  function become(session: Session | null): Authority {
    authority.lifetime.abort();
    return authority = { session, lifetime: new AbortController() };
  }
  const failedViews = new Set<string>();
  const entries = new Map<string, Entry>(), provisional = new Map<object, ScopeHold & { retained: RetainedFrontendTools }>();
  const recent = new Map<string, CapturedSend & { ownerId: string }>();
  const keyFor = (viewId: string, command: OfferedCommand) => canonicalJson([viewId, command.scope, command.clientCommandId]);
  const matches = (reference: FrontendRecoveryReference) => authority.session !== null && reference.ownerId === authority.session.principalId && reference.command.scope.hostId === authority.session.hostId;
  const held = (viewId: string, scope: ConversationScope | undefined, item: ScopeHold) => item.viewId === viewId && (!scope || sameScope(scope, item.scope));
  const acquiring = (viewId: string, scope: ConversationScope) => [...provisional.values()].some(item => held(viewId, scope, item));
  let rows: readonly CapturedSend[] = Object.freeze([]);
  function syncRows(): void {
    const next = [...entries.values()].filter(entry => matches(entry.reference)).map<CapturedSend>(entry => entry.row)
      .concat([...recent.values()].filter(row => authority.session?.principalId === row.ownerId && authority.session.hostId === row.command.scope.hostId));
    if (next.length === rows.length && next.every((row, index) => row === rows[index])) return;
    rows = Object.freeze(next); deps.rowsChanged();
  }
  function remember(viewId: string, reference: FrontendRecoveryReference): void {
    if (!matches(reference)) return;
    const key = keyFor(viewId, reference.command);
    if (recent.has(key)) return;
    recent.set(key, Object.freeze({ key, viewId, command: reference.command, ownerId: reference.ownerId, status: 'unavailable', binding: null }));
    const oldest = recent.keys().next();
    if (recent.size > 32 && !oldest.done) recent.delete(oldest.value);
  }
  function schedule(): void {
    clearTimeout(timer);
    if (!closed && authority.session && [...entries.values()].some(entry => entry.row.status === 'waiting' && matches(entry.reference))) {
      timer = setTimeout(() => { void poll(); }, 2_000);
    }
  }
  function unavailable(entry: Entry): Promise<void> {
    const task = entry.journal.unavailable(entry.reference.command.clientCommandId);
    entries.delete(entry.key);
    entry.retained.release();
    remember(entry.viewId, entry.reference);
    syncRows();
    return task.then(() => entry.recoveryNeeded()).catch(error => { entry.borrow.failed(error); throw error; }).finally(() => {
      entry.borrow.release(); schedule();
    });
  }
  async function recover({ viewId, journal, reference, current, signal, failed }: {
    viewId: string; journal: FrontendJournal; reference: FrontendRecoveryReference; current: () => boolean; signal: AbortSignal; failed(error: unknown): void;
  }): Promise<void> {
    const key = keyFor(viewId, reference.command), currentAuthority = authority;
    const session = currentAuthority.session;
    const valid = () => !closed && !failedViews.has(viewId) && !signal.aborted && current() && !currentAuthority.lifetime.signal.aborted;
    if (reference.state === 'unavailable-confirmed' || !valid() || entries.has(key) || acquiring(viewId, reference.command.scope)) return;
    if (reference.state === 'retained') {
      try { await journal.unavailable(reference.command.clientCommandId); }
      catch (error) { if (valid()) failed(error); return; }
      if (!valid()) return;
      if (matches(reference)) { remember(viewId, reference); syncRows(); }
    }
    if (!valid() || !session || !matches(reference) || entries.has(key) || acquiring(viewId, reference.command.scope)) return;
    try {
      const result = await raceAbort(() => session.connection.frontendBinding({ scope: reference.command.scope, id: reference.command.clientCommandId, action: 'unavailable' }), [currentAuthority.lifetime.signal, signal]);
      if (result === null) return;
      const response = parseFrontendBinding(result);
      if (!valid() || !matches(reference) || entries.has(key)) return;
      if (response.kind !== 'unavailable' || response.id !== reference.command.clientCommandId) return;
      await journal.acknowledged(response.id);
      if (valid() && matches(reference) && reference.state === 'unavailable-pending') {
        remember(viewId, reference); syncRows();
      }
    } catch {
      return;
    }
  }
  async function read(entry: Entry): Promise<void> {
    const current = authority, session = current.session;
    if (entry.pending || !session || !matches(entry.reference) || entry.row.status !== 'waiting' || failedViews.has(entry.viewId)) return;
    entry.pending = true;
    const valid = () => !current.lifetime.signal.aborted && entries.get(entry.key) === entry && !failedViews.has(entry.viewId);
    try {
      const command = entry.reference.command;
      const result = await raceAbort(() => session.connection.frontendBinding({ scope: command.scope, id: command.clientCommandId, action: 'recover' }), [current.lifetime.signal]);
      if (result === null) return;
      const response = parseFrontendBinding(result);
      if (!valid()) return;
      if (response.kind === 'bound') {
        if (!sameScope(response.run.conversation, command.scope) || canonicalJson(response.command) !== canonicalJson(command)) throw new Error('Captured command binding does not match its original owner.');
        entry.retained.bind(response.run);
        entry.row = Object.freeze({ ...entry.row, status: 'bound', binding: response });
      } else {
        if (response.id !== command.clientCommandId) throw new Error('Captured command response has the wrong identity.');
        if (response.kind === 'unavailable') { await unavailable(entry); return; }
      }
      syncRows();
    } catch {
      return;
    } finally { entry.pending = false; }
  }
  async function poll(): Promise<void> { await Promise.all([...entries.values()].map(read)); schedule(); }
  return {
    recover,
    needsRecovery(viewId: string, journal: FrontendJournal): boolean {
      return !closed && !failedViews.has(viewId) && journal.read().some(reference => !entries.has(keyFor(viewId, reference.command))
        && (reference.state === 'retained' || (reference.state === 'unavailable-pending' && matches(reference))));
    },
    snapshot: () => rows,
    async session(metadata: Pick<ServiceMetadata, 'hostId' | 'principalId'> | null, connection: ServiceConnection): Promise<void> {
      const session = authority.session;
      const same = metadata && session && metadata.hostId === session.hostId && metadata.principalId === session.principalId && session.connection === connection;
      if (same) { schedule(); return; }
      const transition = become(null); recent.clear(); clearTimeout(timer); syncRows();
      for (const item of provisional.values()) item.retained.release();
      provisional.clear();
      await Promise.allSettled([...entries.values()].map(unavailable));
      if (closed || transition.lifetime.signal.aborted) return;
      become(metadata ? { ...metadata, connection } : null);
      syncRows(); schedule();
    },
    forStore({ viewId, scope, eligibility, capture, recoveryNeeded }: { readonly recoveryNeeded: () => void; readonly viewId: string; readonly scope: ConversationScope; readonly capture: CaptureStore; readonly eligibility: () => FrontendEligibility }): FrontendAdmission {
      return {
        capture() {
          const current = authority, session = current.session;
          if (failedViews.has(viewId)) throw new Error('Local storage failed. Reload before capturing tools.');
          if (closed || !session || session.hostId !== scope.hostId) throw new Error('Reconnect before capturing tools.');
          if (eligibility() !== 'ag-ui-capture-and-bind') return null;
          const generations = deps.generations.snapshot();
          if (generations.kind !== 'ready') throw new Error('Custom tools are changing. Wait for them to load, then send again.');
          const retained = retainFrontendTools({ generations: generations.generations, platform: 'desktop' });
          if (!retained.definitions.length) { retained.release(); return null; }
          if (provisional.size + entries.size >= 32) {
            retained.release();
            throw new Error('32 captured sends are still retained. Release captured tools or reconnect before sending.');
          }
          let borrow: CaptureBorrow;
          try { borrow = capture.borrow(); } catch (error) { retained.release(); throw error; }
          let ownership: 'provisional' | 'transferred' | 'released' = 'provisional';
          const captureToken = {}, ownerId = session.principalId;
          provisional.set(captureToken, { viewId, scope, retained });
          try {
            if (retained.definitions.length !== retained.bindings.length) throw new Error('Captured definitions and bindings differ.');
            const tools = retained.definitions.map(definition => {
              const bindings = retained.bindings.filter(binding => binding.name === definition.name);
              const binding = bindings[0];
              if (bindings.length !== 1 || !binding) throw new Error('Captured tool has no unique activation.');
              return { definition, activationId: binding.activationId };
            });
            return {
              ownerId, offer: { platform: 'desktop', tools },
              commit(command, journal) {
                const acquired = provisional.delete(captureToken);
                const valid = !closed && acquired && !current.lifetime.signal.aborted && !failedViews.has(viewId);
                if (!valid) { retained.release(); return false; }
                const reference: FrontendRecoveryReference = { command, ownerId, state: 'retained' };
                const key = keyFor(viewId, command);
                ownership = 'transferred';
                entries.set(key, { key, viewId, reference, journal, retained, borrow, recoveryNeeded, row: Object.freeze({ key, viewId, command, status: 'waiting', binding: null }), pending: false });
                syncRows(); schedule(); return true;
              },
              release() { if (ownership !== 'provisional') return; ownership = 'released'; provisional.delete(captureToken); retained.release(); borrow.release(); recoveryNeeded(); },
            };
          } catch (error) { provisional.delete(captureToken); retained.release(); borrow.release(); throw error; }
        },
        canRetry(command) {
          const entry = entries.get(keyFor(viewId, command));
          return Boolean(!closed && entry && matches(entry.reference) && canonicalJson(command) === canonicalJson(entry.reference.command));
        },
        async rejected(id) {
          const entry = [...entries.values()].find(entry => entry.viewId === viewId && sameScope(entry.reference.command.scope, scope) && entry.reference.command.clientCommandId === id);
          if (entry) await unavailable(entry);
        },
      };
    },
    async release(key: string): Promise<void> { const entry = entries.get(key); if (entry) await unavailable(entry); },
    storageFailed(viewId: string): void {
      failedViews.add(viewId);
      for (const [key, entry] of entries) if (entry.viewId === viewId) { entries.delete(key); entry.retained.release(); entry.borrow.release(); remember(viewId, entry.reference); }
      for (const [key, item] of provisional) if (item.viewId === viewId) { item.retained.release(); provisional.delete(key); }
      syncRows(); schedule();
    },
    async dispose(): Promise<void> {
      closed = true; become(null); recent.clear(); clearTimeout(timer); syncRows();
      for (const item of provisional.values()) item.retained.release();
      provisional.clear();
      await Promise.allSettled([...entries.values()].map(unavailable));
    },
  };
}
