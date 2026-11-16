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
type Notification = { readonly kind: 'needed' | 'saved' | 'confirmed' | 'failed' } | { readonly kind: 'saving'; readonly task: Promise<void> };
type Entry = { readonly key: string; readonly viewId: string; readonly reference: FrontendRecoveryReference; readonly journal: FrontendJournal;
  readonly retained: RetainedFrontendTools | null; state: CapturedState;
  notification: Notification; pending: boolean };
type Session = { readonly hostId: string; readonly principalId: string; readonly connection: ServiceConnection };
export function createFrontendSends(deps: { changed(): void; failed(viewId: string, error: unknown): void; unauthorized(): void }) {
  let token: object | null = null, generations: GenerationSnapshot = { kind: 'transitioning' };
  let session: Session | null = null, epoch = 0, closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failedViews = new Set<string>();
  const entries = new Map<string, Entry>(), provisional = new Map<object, { viewId: string; retained: RetainedFrontendTools }>();
  const keyFor = (viewId: string, command: OfferedCommand) => canonicalJson([viewId, command.scope, command.clientCommandId]);
  const matches = (reference: FrontendRecoveryReference) => session !== null && reference.ownerId === session.principalId && reference.command.scope.hostId === session.hostId;
  const outstanding = (entry: Entry) => entry.notification.kind !== 'confirmed';
  function changed(): void {
    for (const [key, entry] of entries) if (entries.size > 32 && !outstanding(entry)) entries.delete(key);
    deps.changed();
  }
  function schedule(): void {
    clearTimeout(timer);
    if (!closed && session && [...entries.values()].some(entry => outstanding(entry) && entry.state.status !== 'bound' && entry.notification.kind !== 'failed' && matches(entry.reference))) {
      timer = setTimeout(() => { void poll(); }, 2_000);
    }
  }
  async function unavailable(entry: Entry): Promise<void> {
    if (entry.state.status !== 'unavailable') {
      entry.state = { status: 'unavailable', binding: null }; entry.retained?.release(); changed();
    }
    if (entry.notification.kind === 'saving') return entry.notification.task;
    if (entry.notification.kind !== 'needed') return;
    const task = entry.journal.unavailable(entry.reference.command.clientCommandId).then(() => {
      if (!failed(entry)) entry.notification = { kind: 'saved' };
    }, error => {
      entry.notification = { kind: 'failed' }; deps.failed(entry.viewId, error); throw error;
    }).finally(() => { changed(); schedule(); });
    entry.notification = { kind: 'saving', task };
    return task;
  }
  function failed(entry: Entry): boolean { return entry.notification.kind === 'failed'; }

  async function read(entry: Entry): Promise<void> {
    if (entry.pending || !session || !matches(entry.reference) || entry.notification.kind === 'confirmed' || entry.notification.kind === 'failed' || entry.state.status === 'bound') return;
    entry.pending = true;
    const current = session, version = epoch;
    try {
      if (entry.state.status === 'unavailable') await unavailable(entry);
      if (current !== session || version !== epoch || failed(entry)) return;
      const command = entry.reference.command;
      const response = parseFrontendBinding(await current.connection.frontendBinding({ scope: command.scope, id: command.clientCommandId,
        action: entry.state.status === 'unavailable' ? 'unavailable' : 'recover' }));
      if (current !== session || version !== epoch || failed(entry) || !matches(entry.reference)) return;
      if (response.kind === 'bound') {
        if (entry.state.status !== 'waiting') return;
        if (!sameScope(response.run.conversation, command.scope) || canonicalJson(response.command) !== canonicalJson(command) || !entry.retained) throw new Error('Captured command binding does not match its original owner.');
        entry.retained.bind(response.run);
        entry.state = { status: 'bound', binding: response };
      } else {
        if (response.id !== command.clientCommandId) throw new Error('Captured command response has the wrong identity.');
        if (response.kind === 'unavailable') {
          await unavailable(entry);
          if (current !== session || version !== epoch || failed(entry)) return;
          await entry.journal.acknowledged(command.clientCommandId);
          if (!failed(entry)) entry.notification = { kind: 'confirmed' };
        }
      }
      changed();
    } catch (error) {
      if (error && typeof error === 'object' && 'kind' in error && error.kind === 'unauthorized' && current === session) deps.unauthorized();
    } finally { entry.pending = false; }
  }
  async function poll(): Promise<void> { await Promise.all([...entries.values()].map(read)); schedule(); }
  return {
    start(): void { closed = false; failedViews.clear(); },
    source: {
      begin(owner) { token = owner; generations = { kind: 'transitioning' }; },
      publish(owner, value) { if (token === owner) generations = value; },
      clear(owner) { if (token === owner) { token = null; generations = { kind: 'transitioning' }; } },
    } satisfies GenerationSink,
    snapshot(): readonly CapturedSend[] {
      return [...entries.values()].filter(entry => matches(entry.reference)).map(entry => ({ key: entry.key, command: entry.reference.command,
        viewId: entry.viewId, ...entry.state }));
    },
    forgetView(viewId: string): void {
      for (const [key, entry] of entries) if (entry.viewId === viewId && !outstanding(entry)) entries.delete(key);
      changed();
    },
    holds(viewId: string): boolean { return [...entries.values()].some(entry => entry.viewId === viewId && outstanding(entry)) || [...provisional.values()].some(entry => entry.viewId === viewId); },
    async session(metadata: Pick<ServiceMetadata, 'hostId' | 'principalId'> | null, connection: ServiceConnection): Promise<void> {
      const same = metadata && session && metadata.hostId === session.hostId && metadata.principalId === session.principalId && session.connection === connection;
      if (same) { schedule(); return; }
      const transition = ++epoch; session = null; clearTimeout(timer);
      for (const item of provisional.values()) item.retained.release();
      provisional.clear();
      await Promise.allSettled([...entries.values()].filter(outstanding).map(unavailable));
      if (closed || transition !== epoch) return;
      session = metadata ? { ...metadata, connection } : null;
      changed(); schedule();
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
          if (provisional.size + [...entries.values()].filter(outstanding).length >= 32) {
            retained.release();
            throw new Error('32 captured sends are still retained. Release captured tools or reconnect before sending.');
          }
          const captureToken = {}, current = session, version = epoch, ownerId = session.principalId;
          provisional.set(captureToken, { viewId, retained });
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
                if (closed) { retained.release(); return false; }
                const valid = acquired && current === session && version === epoch;
                const reference: FrontendRecoveryReference = { command, ownerId, state: 'retained' };
                const key = keyFor(viewId, command);
                entries.set(key, { key, viewId, reference, journal, retained, state: { status: valid ? 'waiting' : 'unavailable', binding: null }, notification: { kind: failedViews.has(viewId) ? 'failed' : 'needed' }, pending: false });
                if (!valid) retained.release();
                changed(); schedule(); return valid;
              },
              release() { provisional.delete(captureToken); retained.release(); changed(); },
            };
          } catch (error) { provisional.delete(captureToken); retained.release(); throw error; }
        },
        restore(journal) {
          const references = journal.read();
          const incoming = references.filter(reference => reference.state !== 'unavailable-confirmed' && !entries.has(keyFor(viewId, reference.command))).length;
          if (incoming + provisional.size + [...entries.values()].filter(outstanding).length > 32) throw new Error('This saved view exceeds the 32 captured-send limit. Release captured tools, then reload to open it.');
          for (const reference of references) {
            const key = keyFor(viewId, reference.command);
            if (entries.has(key)) continue;
            const entry: Entry = { key, viewId, reference, journal, retained: null, state: { status: 'unavailable', binding: null },
              notification: { kind: reference.state === 'unavailable-confirmed' ? 'confirmed' : reference.state === 'unavailable-pending' ? 'saved' : 'needed' }, pending: false };
            entries.set(key, entry);
            if (entry.notification.kind === 'needed') void unavailable(entry).catch(() => {});
          }
          changed(); schedule();
        },
        canRetry(command) {
          const entry = entries.get(keyFor(viewId, command));
          return Boolean(!closed && entry && entry.state.status !== 'unavailable' && matches(entry.reference) && canonicalJson(command) === canonicalJson(entry.reference.command));
        },
        async rejected(id) {
          const entry = [...entries.values()].find(entry => entry.viewId === viewId && sameScope(entry.reference.command.scope, scope) && entry.reference.command.clientCommandId === id);
          if (entry) { await unavailable(entry); void read(entry).finally(schedule); }
        },
      };
    },
    async release(key: string): Promise<void> { const entry = entries.get(key); if (entry) { await unavailable(entry); void read(entry).finally(schedule); } },
    storageFailed(viewId: string): void {
      failedViews.add(viewId);
      for (const entry of entries.values()) if (entry.viewId === viewId) { entry.state = { status: 'unavailable', binding: null }; entry.notification = { kind: 'failed' }; entry.retained?.release(); }
      for (const [key, item] of provisional) if (item.viewId === viewId) { item.retained.release(); provisional.delete(key); }
      changed(); schedule();
    },
    async dispose(): Promise<void> {
      closed = true; epoch++; session = null; clearTimeout(timer);
      for (const item of provisional.values()) item.retained.release();
      provisional.clear();
      await Promise.allSettled([...entries.values()].filter(outstanding).map(unavailable));
      entries.clear();
    },
  };
}
