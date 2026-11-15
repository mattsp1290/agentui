import { randomUUID, createHash } from 'node:crypto';
import { EventSchema, ToolSchema } from '@ag-ui/core/schemas';
import { z } from 'zod';
import { canonicalJson, parseRunIdentity, sameScope } from '@agentui/contracts';
import type { ConversationScope, Json, RunIdentity } from '@agentui/contracts';
import type { FrontendPlatform, FrontendTool, FrontendToolOutcome } from '@agentui/sdk/tools';
import type { LocalHost } from '../local-host.js';
import { frontendToolsContext } from '../frontend-tools-context.js';
import { nonempty } from '../codec.js';

type Binding = { readonly name: string; readonly activationId: string; readonly definition: FrontendTool };
type StoredBinding = Omit<Binding, 'definition'> & { readonly definition: z.output<typeof ToolSchema> };
type Result = FrontendToolOutcome | { readonly kind: 'refused'; readonly code: 'denied' };
type Call = { readonly id: string; readonly name: string; state: CallState };
type CallState =
  | { kind: 'collecting'; fragments: string }
  | { kind: 'sealed'; fragments: string; answered: boolean }
  | { kind: 'ready'; args: Json; digest: string; decision: 'pending' | 'allow' }
  | { kind: 'permitted'; args: Json; permitId: string; actorId: string; activationId: string }
  | { kind: 'resolved'; permitId: string | null; actorId: string | null };
type Run = { identity: RunIdentity; threadId: string; platform: FrontendPlatform; bindings: readonly StoredBinding[];
  cursor: number; eventBytes: number; status: 'collecting' | 'ready' | 'blocked' | 'faulted'; calls: Call[]; pending: string[] };
export interface FrontendRunKey { readonly threadId: string; readonly runId: string }
export interface FrontendActor { readonly id: string; readonly platform: FrontendPlatform; authorized(request: { readonly scope: ConversationScope; readonly key: FrontendRunKey; readonly action: 'inspect' | 'claim' | 'receipt'; readonly callId: string | null; readonly activationId: string | null }): boolean }
export interface FrontendRegistration { readonly identity: RunIdentity; readonly threadId: string; readonly platform: FrontendPlatform; readonly bindings: readonly Binding[] }
export type FrontendReceipt = FrontendToolOutcome | { readonly kind: 'uncertain' };
export interface FrontendRunView { readonly status: Run['status']; readonly calls: readonly { readonly id: string; readonly name: string; readonly status: 'collecting' | 'sealed' | 'pending' | 'claimable' | 'uncertain' | 'resolved'; readonly activationId: string | null; readonly argumentsDigest: string | null }[] }
export interface FrontendToolProducer {
  inspect(key: FrontendRunKey): FrontendRunView;
  register(registration: FrontendRegistration): void;
  observe(key: FrontendRunKey, cursor: number, event: unknown): 'accepted' | 'duplicate' | 'faulted';
  decide(key: FrontendRunKey, callId: string, decision: 'allow' | 'deny', activationId: string, argumentsDigest: string): void;
  cancel(key: FrontendRunKey): void;
  results(key: FrontendRunKey): { kind: 'ready'; identity: RunIdentity; threadId: string; batch: readonly { toolCallId: string; result: Result }[] } | { kind: 'waiting' | 'blocked' };
}
export interface FrontendToolClient {
  inspect(key: FrontendRunKey): FrontendRunView;
  claim(key: FrontendRunKey, callId: string, activationId: string):
    | { kind: 'permit'; permitId: string; name: string; arguments: Json }
    | { kind: 'unavailable' | 'uncertain' };
  receipt(key: FrontendRunKey, permitId: string, result: FrontendReceipt): 'recorded' | 'duplicate' | 'uncertain';
}
export interface FrontendTools {
  producer(scope: ConversationScope): FrontendToolProducer;
  client(scope: ConversationScope, actor: FrontendActor): FrontendToolClient;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const copy = <T>(value: T): T => JSON.parse(canonicalJson(value));
const refused = (code: Extract<Result, { kind: 'refused' }>['code']): Result => ({ kind: 'refused', code });
const receiptSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed'), output: z.string().refine(value => Buffer.byteLength(value) <= 64000) }).strict(),
  z.object({ kind: z.literal('refused'), code: z.enum(['released', 'unknown-tool', 'activation-mismatch', 'invalid-arguments', 'decode-failed', 'denied']) }).strict(),
]);
const stateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('collecting'), fragments: z.string() }).strict(),
  z.object({ kind: z.literal('sealed'), fragments: z.string(), answered: z.boolean() }).strict(),
  z.object({ kind: z.literal('ready'), args: z.json(), digest: z.string(), decision: z.enum(['pending', 'allow']) }).strict(),
  z.object({ kind: z.literal('permitted'), args: z.json(), permitId: z.string(), actorId: z.string(), activationId: z.string() }).strict(),
  z.object({ kind: z.literal('resolved'), permitId: z.string().nullable(), actorId: z.string().nullable() }).strict(),
]);
const runSchema = z.object({
  identity: z.unknown().transform(parseRunIdentity), threadId: z.string().min(1), platform: z.enum(['desktop', 'ios']),
  bindings: z.array(z.object({ name: z.string().min(1), activationId: z.string().min(1), definition: z.unknown().transform(value => ToolSchema.parse(value)) }).strict()),
  cursor: z.number().int().nonnegative(), eventBytes: z.number().int().nonnegative(), status: z.enum(['collecting', 'ready', 'blocked', 'faulted']),
  calls: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), state: stateSchema }).strict()), pending: z.array(z.string()),
}).strict();
function platform(value: FrontendPlatform): FrontendPlatform {
  if (value !== 'desktop' && value !== 'ios') throw new Error('Invalid platform');
  return value;
}
function validResult(value: FrontendReceipt): FrontendReceipt {
  if (value.kind === 'uncertain') return { kind: 'uncertain' };
  if (value.kind === 'completed' && typeof value.output === 'string' && Buffer.byteLength(value.output) <= 64000) return { kind: 'completed', output: value.output };
  if (value.kind === 'refused' && ['released', 'unknown-tool', 'activation-mismatch', 'invalid-arguments', 'decode-failed'].includes(value.code)) return { kind: 'refused', code: value.code };
  throw new Error('Invalid frontend receipt');
}
export function frontendToolsFor<E, P>(host: LocalHost<E, P>): FrontendTools {
  const store = frontendToolsContext(host), authorized = store.authorized;
  const keyParts = (scope: ConversationScope, key: FrontendRunKey) => [scope.hostId, scope.conversationId, nonempty(key.threadId), nonempty(key.runId)] as const;
  const writeReceipt = (scope: ConversationScope, key: FrontendRunKey, callId: string, result: Result) => {
    store.db.prepare('INSERT INTO frontend_receipts(host, conversation, thread, run, call, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(...keyParts(scope, key), callId, canonicalJson(result));
  };
  const readReceipt = (scope: ConversationScope, key: FrontendRunKey, callId: string): Result => {
    const row = store.db.prepare('SELECT data FROM frontend_receipts WHERE host=? AND conversation=? AND thread=? AND run=? AND call=?')
      .get(...keyParts(scope, key), callId);
    if (!row || typeof row.data !== 'string') throw new Error('Missing frontend receipt');
    return receiptSchema.parse(JSON.parse(row.data));
  };
  const load = (scope: ConversationScope, key: FrontendRunKey): Run => {
    const row = store.db.prepare('SELECT data FROM frontend_runs WHERE host=? AND conversation=? AND thread=? AND run=?').get(...keyParts(scope, key));
    if (!row || typeof row.data !== 'string') throw new Error('Unknown frontend run');
    const run: Run = runSchema.parse(JSON.parse(row.data));
    if (!sameScope(run.identity.conversation, scope) || run.threadId !== key.threadId || run.identity.runId !== key.runId) throw new Error('Corrupt frontend run identity');
    if (run.calls.length > 128 || run.bindings.length > 128 || run.eventBytes > 1000000 || run.cursor > 4096 ||
      new Set(run.calls.map(call => call.id)).size !== run.calls.length || new Set(run.bindings.map(binding => binding.name)).size !== run.bindings.length ||
      new Set(run.pending).size !== run.pending.length || run.bindings.some(binding => binding.name !== binding.definition.name)) throw new Error('Corrupt frontend run');
    for (const call of run.calls) {
      const binding = run.bindings.find(item => item.name === call.name);
      if ((call.state.kind === 'ready' || call.state.kind === 'permitted' || call.state.kind === 'resolved') && !run.pending.includes(call.id)) throw new Error('Corrupt frontend call');
      if (call.state.kind === 'ready' && (!binding || digest(canonicalJson(call.state.args)) !== call.state.digest)) throw new Error('Corrupt frontend arguments');
      if (call.state.kind === 'permitted' && (!binding || binding.activationId !== call.state.activationId || !call.state.actorId || !call.state.permitId)) throw new Error('Corrupt frontend permit');
      if (call.state.kind === 'resolved' && ((call.state.permitId === null) !== (call.state.actorId === null))) throw new Error('Corrupt frontend receipt');
    }
    if (run.pending.some(id => !run.calls.some(call => call.id === id))) throw new Error('Corrupt frontend pending set');
    return run;
  };
  const save = (scope: ConversationScope, run: Run) => {
    if (Buffer.byteLength(canonicalJson(run)) > 1000000) throw new Error('Frontend run capacity exceeded');
    store.db.prepare('UPDATE frontend_runs SET data=? WHERE host=? AND conversation=? AND thread=? AND run=?')
      .run(canonicalJson(run), ...keyParts(scope, { threadId: run.threadId, runId: run.identity.runId }));
  };
  const check = (scope: ConversationScope) => { authorized(scope); if (!store.findInstallation(scope)) throw new Error('Unknown conversation'); };
  const mutate = <T>(scope: ConversationScope, key: FrontendRunKey, fn: (run: Run) => T): T => store.transaction(() => {
    check(scope); const run = load(scope, key); const result = fn(run); save(scope, run); return result;
  });
  const frontendView = (run: Run): FrontendRunView => ({ status: run.status, calls: run.calls.map(call => ({ id: call.id, name: call.name,
    status: call.state.kind === 'ready' ? (call.state.decision === 'allow' ? 'claimable' : 'pending') : call.state.kind === 'permitted' ? 'uncertain' : call.state.kind,
    activationId: run.bindings.find(binding => binding.name === call.name)?.activationId ?? null,
    argumentsDigest: call.state.kind === 'ready' ? call.state.digest : null })) });
  return {
    producer(value) {
      const scope = authorized(value); check(scope);
      const inspect = (key: FrontendRunKey): FrontendRunView => { check(scope); return frontendView(load(scope, key)); };
      return {
        inspect,
        register(input) {
          check(scope);
          const identity = parseRunIdentity(input.identity), threadId = nonempty(input.threadId), selectedPlatform = platform(input.platform);
          if (!sameScope(identity.conversation, scope) || input.bindings.length > 128) throw new Error('Invalid frontend registration');
          const names = new Set<string>();
          const bindings = input.bindings.map(binding => {
            const definition = copy(ToolSchema.parse(binding.definition));
            if (definition.name !== binding.name || names.has(binding.name)) throw new Error('Invalid frontend binding');
            names.add(binding.name);
            return { name: nonempty(binding.name), activationId: nonempty(binding.activationId), definition };
          });
          const run: Run = { identity, threadId, platform: selectedPlatform, bindings, cursor: 0, eventBytes: 0, status: 'collecting', calls: [], pending: [] };
          if (Buffer.byteLength(canonicalJson(run)) > 128000) throw new Error('Frontend registration too large');
          store.transaction(() => {
            check(scope);
            const parts = keyParts(scope, { threadId, runId: identity.runId });
            const row = store.db.prepare('SELECT data FROM frontend_runs WHERE host=? AND conversation=? AND thread=? AND run=?').get(...parts);
            if (row) {
              const old = load(scope, { threadId, runId: identity.runId });
              if (canonicalJson([old.identity, old.threadId, old.platform, old.bindings]) !== canonicalJson([identity, threadId, selectedPlatform, bindings])) throw new Error('Conflicting frontend registration');
            } else store.db.prepare('INSERT INTO frontend_runs(host, conversation, thread, run, data) VALUES (?, ?, ?, ?, ?)').run(...parts, canonicalJson(run));
          });
        },
        observe(key, cursor, input) {
          if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Error('Invalid cursor');
          let encoded: string;
          try { encoded = canonicalJson(input); if (Buffer.byteLength(encoded) > 64000) throw new Error('Event too large'); }
          catch { return mutate(scope, key, run => { run.status = 'faulted'; return 'faulted'; }); }
          return store.transaction(() => {
            check(scope); const run = load(scope, key); const parts = keyParts(scope, key);
            const previous = store.db.prepare('SELECT data FROM frontend_events WHERE host=? AND conversation=? AND thread=? AND run=? AND cursor=?').get(...parts, cursor);
            if (previous && previous.data === encoded) return 'duplicate';
            if (previous || cursor !== run.cursor + 1 || run.status !== 'collecting' || cursor > 4096) { run.status = 'faulted'; save(scope, run); return 'faulted'; }
            const original = copy(run);
            const receipts: { callId: string; result: Result }[] = [];
            try {
              const event = EventSchema.parse(input);
              if ((cursor === 1) !== (event.type === 'RUN_STARTED')) throw new Error('Invalid run start');
              if (run.eventBytes + Buffer.byteLength(encoded) > 1000000) throw new Error('Event capacity exceeded');
              if ('subagentRunId' in event && event.subagentRunId && event.type.startsWith('TOOL_CALL_')) throw new Error('Unsupported subagent tool call');
              switch (event.type) {
                case 'RUN_STARTED':
                  if (event.threadId !== run.threadId || event.runId !== run.identity.runId) throw new Error('Run mismatch');
                  break;
                case 'TOOL_CALL_START':
                  if (run.calls.some(call => call.id === event.toolCallId) || run.calls.length >= 128) throw new Error('Duplicate call');
                  run.calls.push({ id: nonempty(event.toolCallId), name: nonempty(event.toolCallName), state: { kind: 'collecting', fragments: '' } }); break;
                case 'TOOL_CALL_ARGS': {
                  const call = run.calls.find(call => call.id === event.toolCallId);
                  if (!call || call.state.kind !== 'collecting') throw new Error('Unexpected arguments');
                  call.state.fragments += event.delta;
                  if (Buffer.byteLength(call.state.fragments) > 64000) throw new Error('Arguments too large');
                  break;
                }
                case 'TOOL_CALL_END': {
                  const call = run.calls.find(call => call.id === event.toolCallId);
                  if (!call || call.state.kind !== 'collecting') throw new Error('Unexpected end');
                  call.state = { kind: 'sealed', fragments: call.state.fragments, answered: false }; break;
                }
                case 'TOOL_CALL_RESULT': {
                  const call = run.calls.find(call => call.id === event.toolCallId);
                  if (!call || call.state.kind !== 'sealed' || call.state.answered) throw new Error('Unexpected result');
                  call.state.answered = true; break;
                }
                case 'TOOL_CALL_CHUNK': throw new Error('Unsupported chunk stream');
                case 'RUN_ERROR': run.status = 'blocked'; break;
                case 'RUN_FINISHED': {
                  if (event.threadId !== run.threadId || event.runId !== run.identity.runId) throw new Error('Run mismatch');
                  if (event.outcome && event.outcome.type !== 'success') { run.status = 'blocked'; break; }
                  if (run.calls.some(call => call.state.kind !== 'sealed')) throw new Error('Incomplete calls');
                  const pending = run.calls.filter(call => call.state.kind === 'sealed' && !call.state.answered);
                  const ids = event.outcome?.pendingToolCallIds ?? [];
                  if (ids.length && (ids.length !== pending.length || new Set(ids).size !== ids.length || ids.some((id, i) => pending[i]?.id !== id))) throw new Error('Pending mismatch');
                  run.pending = pending.map(call => call.id);
                  for (const call of pending) {
                    const binding = run.bindings.find(item => item.name === call.name);
                    if (!binding || call.state.kind !== 'sealed') throw new Error('Unknown frontend tool');
                    try {
                      const args: Json = JSON.parse(canonicalJson(JSON.parse(call.state.fragments)));
                      call.state = { kind: 'ready', args, digest: digest(canonicalJson(args)), decision: 'pending' };
                    } catch {
                      call.state = { kind: 'resolved', permitId: null, actorId: null };
                      receipts.push({ callId: call.id, result: refused('invalid-arguments') });
                    }
                  }
                  run.status = 'ready'; break;
                }
              }
            } catch {
              original.status = 'faulted'; save(scope, original); return 'faulted';
            }
            run.cursor = cursor; run.eventBytes += Buffer.byteLength(encoded);
            store.db.prepare('INSERT INTO frontend_events(host, conversation, thread, run, cursor, data) VALUES (?, ?, ?, ?, ?, ?)').run(...parts, cursor, encoded);
            for (const receipt of receipts) writeReceipt(scope, key, receipt.callId, receipt.result);
            save(scope, run); return 'accepted';
          });
        },
        decide(key, callId, decision, activationId, argumentsDigest) {
          mutate(scope, key, run => {
            const call = run.calls.find(call => call.id === callId), binding = run.bindings.find(item => item.name === call?.name);
            if (run.status !== 'ready' || !call || call.state.kind !== 'ready' || !binding || binding.activationId !== activationId || call.state.digest !== argumentsDigest) throw new Error('Invalid decision');
            if (decision === 'allow') call.state.decision = 'allow';
            else if (decision === 'deny') {
              writeReceipt(scope, key, call.id, refused('denied'));
              call.state = { kind: 'resolved', permitId: null, actorId: null };
            }
            else throw new Error('Invalid decision');
          });
        },
        cancel(key) { mutate(scope, key, run => { run.status = 'blocked'; }); },
        results(key) {
          check(scope); const run = load(scope, key);
          if (run.status !== 'ready') return { kind: 'blocked' };
          const calls = run.pending.map(id => run.calls.find(call => call.id === id));
          if (calls.some(call => !call || call.state.kind !== 'resolved')) return { kind: 'waiting' };
          return { kind: 'ready', identity: copy(run.identity), threadId: run.threadId, batch: calls.map(call => {
            if (!call || call.state.kind !== 'resolved') throw new Error('Invalid call state');
            return { toolCallId: call.id, result: readReceipt(scope, key, call.id) };
          }) };
        },
      };
    },
    client(value, binding) {
      const scope = authorized(value), actorId = nonempty(binding.id), actorPlatform = platform(binding.platform), auth = binding.authorized;
      if (typeof auth !== 'function') throw new Error('Missing actor authorization');
      const checkActor = (key: FrontendRunKey, action: 'inspect' | 'claim' | 'receipt', callId: string | null, activationId: string | null) => {
        check(scope); if (!auth.call(binding, { scope, key, action, callId, activationId })) throw new Error('Unauthorized actor');
      };
      return {
        inspect(key) { checkActor(key, 'inspect', null, null); return frontendView(load(scope, key)); },
        claim(key, callId, activationId) {
          checkActor(key, 'claim', callId, activationId);
          return mutate(scope, key, run => {
            checkActor(key, 'claim', callId, activationId);
            const call = run.calls.find(call => call.id === callId), tool = run.bindings.find(item => item.name === call?.name);
            if (!call || !tool || tool.activationId !== activationId || run.platform !== actorPlatform) return { kind: 'unavailable' };
            if (call.state.kind === 'permitted' || (call.state.kind === 'resolved' && call.state.permitId)) return { kind: 'uncertain' };
            if (run.status !== 'ready' || call.state.kind !== 'ready' || call.state.decision !== 'allow') return { kind: 'unavailable' };
            const args = call.state.args, permitId = randomUUID();
            call.state = { kind: 'permitted', args, permitId, actorId, activationId };
            return { kind: 'permit', permitId, name: call.name, arguments: copy(args) };
          });
        },
        receipt(key, permitId, input) {
          check(scope); const result = validResult(input);
          return mutate(scope, key, run => {
            const call = run.calls.find(call => (call.state.kind === 'permitted' || call.state.kind === 'resolved') && call.state.permitId === permitId);
            if (!call || (call.state.kind !== 'permitted' && call.state.kind !== 'resolved') || call.state.actorId !== actorId) throw new Error('Invalid permit');
            const activationId = run.bindings.find(item => item.name === call.name)?.activationId ?? null;
            checkActor(key, 'receipt', call.id, activationId);
            if (call.state.kind === 'resolved') {
              if (result.kind === 'uncertain' || canonicalJson(result) !== canonicalJson(readReceipt(scope, key, call.id))) throw new Error('Conflicting receipt');
              return 'duplicate';
            }
            if (result.kind === 'uncertain') return 'uncertain';
            writeReceipt(scope, key, call.id, result);
            call.state = { kind: 'resolved', permitId, actorId }; return 'recorded';
          });
        },
      };
    },
  };
}
