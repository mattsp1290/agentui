import { canonicalJson, parseFrontendBinding, sameScope } from '@agentui/contracts';
import type { ConversationScope, FrontendBinding, FrontendEligibility, OfferedCommand } from '@agentui/contracts';
import type { ServiceConnection, ServiceMetadata } from '@agentui/contracts/service';
import type { FrontendAdmission, FrontendJournal, FrontendRecoveryReference } from '@agentui/client';
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
type Entry = { readonly key: string; readonly viewId: string; readonly reference: FrontendRecoveryReference; readonly journal: FrontendJournal;
  readonly retained: RetainedFrontendTools; state: { readonly status: 'waiting'; readonly binding: null } | Extract<CapturedState, { status: 'bound' }>; pending: boolean };
type ScopeHold = { readonly viewId: string; readonly scope: ConversationScope };
type Session = { readonly hostId: string; readonly principalId: string; readonly connection: ServiceConnection };
export function createFrontendSends(deps: { changed(): void; failed(viewId: string, error: unknown): void; unauthorized(): void }) {
  let token: object | null = null, generations: GenerationSnapshot = { kind: 'transitioning' };
  let session: Session | null = null, epoch = 0, closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let authorityLifetime = new AbortController();
  function advanceEpoch(): number {
    authorityLifetime.abort(); authorityLifetime = new AbortController();
    return ++epoch;
  }
  const failedViews = new Set<string>();
  const entries = new Map<string, Entry>(), provisional = new Map<object, ScopeHold & { retained: RetainedFrontendTools }>();
  const transitions = new Map<object, ScopeHold>();
  const recent = new Map<string, CapturedSend & { ownerId: string }>();
  const keyFor = (viewId: string, command: OfferedCommand) => canonicalJson([viewId, command.scope, command.clientCommandId]);
  const matches = (reference: FrontendRecoveryReference) => session !== null && reference.ownerId === session.principalId && reference.command.scope.hostId === session.hostId;
  const held = (viewId: string, scope: ConversationScope | undefined, item: ScopeHold) => item.viewId === viewId && (!scope || sameScope(scope, item.scope));
  const acquiring = (viewId: string, scope: ConversationScope) => [...provisional.values()].some(item => held(viewId, scope, item));
  function remember(viewId: string, reference: FrontendRecoveryReference): void {
    if (!matches(reference)) return;
    const key = keyFor(viewId, reference.command);
    recent.delete(key);
    recent.set(key, { key, viewId, command: reference.command, ownerId: reference.ownerId, status: 'unavailable', binding: null });
    const oldest = recent.keys().next();
    if (recent.size > 32 && !oldest.done) recent.delete(oldest.value);
    deps.changed();
  }
  function schedule(): void {
    clearTimeout(timer);
    if (!closed && session && [...entries.values()].some(entry => entry.state.status === 'waiting' && matches(entry.reference))) {
      timer = setTimeout(() => { void poll(); }, 2_000);
    }
  }
  function unavailable(entry: Entry): Promise<void> {
    const transition = {};
    transitions.set(transition, { viewId: entry.viewId, scope: entry.reference.command.scope });
    const task = entry.journal.unavailable(entry.reference.command.clientCommandId);
    entries.delete(entry.key);
    entry.retained.release();
    remember(entry.viewId, entry.reference);
    deps.changed();
    return task.catch(error => { deps.failed(entry.viewId, error); throw error; }).finally(() => {
      transitions.delete(transition); deps.changed(); schedule();
    });
  }
  async function recover({ viewId, journal, reference, current, signal }: {
    viewId: string; journal: FrontendJournal; reference: FrontendRecoveryReference; current: () => boolean; signal: AbortSignal;
  }): Promise<void> {
    const key = keyFor(viewId, reference.command), authority = session, version = epoch;
    const valid = () => !closed && !failedViews.has(viewId) && !signal.aborted && current() && authority === session && version === epoch;
    if (!valid() || entries.has(key) || acquiring(viewId, reference.command.scope)) return;
    if (reference.state === 'retained') {
      try { await journal.unavailable(reference.command.clientCommandId); }
      catch (error) { if (valid()) deps.failed(viewId, error); return; }
    }
    if (!valid()) return;
    remember(viewId, reference);
    if (!valid() || !authority || !matches(reference) || reference.state === 'unavailable-confirmed' || entries.has(key) || acquiring(viewId, reference.command.scope)) return;
    const signals = [authorityLifetime.signal, signal];
    if (signals.some(item => item.aborted)) return;
    let cancel = () => {};
    const cancelled = new Promise<null>(resolve => { cancel = () => resolve(null); for (const item of signals) item.addEventListener('abort', cancel, { once: true }); });
    try {
      const result = await Promise.race([authority.connection.frontendBinding({ scope: reference.command.scope, id: reference.command.clientCommandId, action: 'unavailable' }), cancelled]);
      if (result === null) return;
      const response = parseFrontendBinding(result);
      if (!valid() || !matches(reference) || entries.has(key)) return;
      if (response.kind !== 'unavailable' || response.id !== reference.command.clientCommandId) return;
      await journal.acknowledged(response.id);
    } catch (error) {
      if (valid() && error && typeof error === 'object' && 'kind' in error && error.kind === 'unauthorized') deps.unauthorized();
    } finally { for (const item of signals) item.removeEventListener('abort', cancel); }
  }
  async function read(entry: Entry): Promise<void> {
    if (entry.pending || !session || !matches(entry.reference) || entry.state.status !== 'waiting' || failedViews.has(entry.viewId)) return;
    entry.pending = true;
    const current = session, version = epoch;
    const valid = () => current === session && version === epoch && entries.get(entry.key) === entry && !failedViews.has(entry.viewId);
    try {
      const command = entry.reference.command;
      const response = parseFrontendBinding(await current.connection.frontendBinding({ scope: command.scope, id: command.clientCommandId, action: 'recover' }));
      if (!valid()) return;
      if (response.kind === 'bound') {
        if (!sameScope(response.run.conversation, command.scope) || canonicalJson(response.command) !== canonicalJson(command)) throw new Error('Captured command binding does not match its original owner.');
        entry.retained.bind(response.run);
        entry.state = { status: 'bound', binding: response };
      } else {
        if (response.id !== command.clientCommandId) throw new Error('Captured command response has the wrong identity.');
        if (response.kind === 'unavailable') await unavailable(entry);
      }
      deps.changed();
    } catch (error) {
      if (error && typeof error === 'object' && 'kind' in error && error.kind === 'unauthorized' && current === session) deps.unauthorized();
    } finally { entry.pending = false; }
  }
  async function poll(): Promise<void> { await Promise.all([...entries.values()].map(read)); schedule(); }
  return {
    recover,
    start(): void { closed = false; failedViews.clear(); },
    source: {
      begin(owner) { token = owner; generations = { kind: 'transitioning' }; },
      publish(owner, value) { if (token === owner) generations = value; },
      clear(owner) { if (token === owner) { token = null; generations = { kind: 'transitioning' }; } },
    } satisfies GenerationSink,
    snapshot(): readonly CapturedSend[] {
      return [...entries.values()].filter(entry => matches(entry.reference)).map<CapturedSend>(entry => ({ key: entry.key, command: entry.reference.command,
        viewId: entry.viewId, ...entry.state })).concat([...recent.values()].filter(row => session?.principalId === row.ownerId && session.hostId === row.command.scope.hostId));
    },
    forgetView(viewId: string): void { failedViews.delete(viewId); },
    holds(viewId: string, scope?: ConversationScope): boolean {
      return [...entries.values()].some(entry => held(viewId, scope, { viewId: entry.viewId, scope: entry.reference.command.scope })) ||
        [...provisional.values(), ...transitions.values()].some(entry => held(viewId, scope, entry));
    },
    async session(metadata: Pick<ServiceMetadata, 'hostId' | 'principalId'> | null, connection: ServiceConnection): Promise<void> {
      const same = metadata && session && metadata.hostId === session.hostId && metadata.principalId === session.principalId && session.connection === connection;
      if (same) { schedule(); return; }
      const transition = advanceEpoch(); session = null; recent.clear(); clearTimeout(timer);
      for (const item of provisional.values()) item.retained.release();
      provisional.clear();
      await Promise.allSettled([...entries.values()].map(unavailable));
      if (closed || transition !== epoch) return;
      session = metadata ? { ...metadata, connection } : null;
      deps.changed(); schedule();
    },
    forStore({ viewId, scope, eligibility }: { readonly viewId: string; readonly scope: ConversationScope; readonly eligibility: () => FrontendEligibility }): FrontendAdmission {
      return {
        get ownerId() { if (!session) throw new Error('Reconnect before sending.'); return session.principalId; },
        capture() {
          if (failedViews.has(viewId)) throw new Error('Local storage failed. Reload before capturing tools.');
          if (closed || !session || session.hostId !== scope.hostId) throw new Error('Reconnect before capturing tools.');
          if (eligibility() !== 'ag-ui-capture-and-bind') return null;
          if (generations.kind !== 'ready') throw new Error('Custom tools are changing. Wait for them to load, then send again.');
          const retained = retainFrontendTools({ generations: generations.generations, platform: 'desktop' });
          if (!retained.definitions.length) { retained.release(); return null; }
          if (provisional.size + entries.size >= 32) {
            retained.release();
            throw new Error('32 captured sends are still retained. Release captured tools or reconnect before sending.');
          }
          const captureToken = {}, current = session, version = epoch, ownerId = session.principalId;
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
              offer: { platform: 'desktop', tools },
              commit(command, journal) {
                const acquired = provisional.delete(captureToken);
                const valid = !closed && acquired && current === session && version === epoch && !failedViews.has(viewId);
                if (!valid) { retained.release(); deps.changed(); return false; }
                const reference: FrontendRecoveryReference = { command, ownerId, state: 'retained' };
                const key = keyFor(viewId, command);
                entries.set(key, { key, viewId, reference, journal, retained, state: { status: 'waiting', binding: null }, pending: false });
                deps.changed(); schedule(); return valid;
              },
              release() { provisional.delete(captureToken); retained.release(); deps.changed(); },
            };
          } catch (error) { provisional.delete(captureToken); retained.release(); throw error; }
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
      for (const [key, entry] of entries) if (entry.viewId === viewId) { entries.delete(key); entry.retained.release(); remember(viewId, entry.reference); }
      for (const [key, item] of provisional) if (item.viewId === viewId) { item.retained.release(); provisional.delete(key); }
      deps.changed(); schedule();
    },
    async dispose(): Promise<void> {
      closed = true; advanceEpoch(); session = null; recent.clear(); clearTimeout(timer);
      for (const item of provisional.values()) item.retained.release();
      provisional.clear();
      await Promise.allSettled([...entries.values()].map(unavailable));
      entries.clear();
    },
  };
}
