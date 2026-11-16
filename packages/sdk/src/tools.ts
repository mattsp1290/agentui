import { copyJson, parseRunIdentity, type ConversationScope } from '@agentui/contracts';
import { record } from '@agentui/contracts/decode';
import { behaviour, extensionNamespace, frontendPlatform, type ExtensionLifetime } from './extensions.js';
import { compileParameters } from './schema.js';
import type { FrontendTool, FrontendToolContribution, FrontendToolGeneration, FrontendToolGenerationOptions, FrontendToolActivation, FrontendToolOutcome, FrontendToolPin, FrontendToolPinOptions } from './tool-contracts.js';
export type * from './tool-contracts.js';

type Registered = { readonly definition: FrontendTool; call(args: unknown, conversation: ConversationScope): Promise<FrontendToolOutcome> };
const refused = (code: Extract<FrontendToolOutcome, { kind: 'refused' }>['code']): FrontendToolOutcome => ({ kind: 'refused', code });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function registerTool<Input>(namespace: string, tool: FrontendToolContribution<Input>): Registered {
  const input = record(tool.definition);
  const allowed = ['name', 'description', 'parameters', 'metadata'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Invalid tool definition field');
  const copied = record(copyJson(Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))));
  if (typeof copied.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(copied.name)) throw new Error('Invalid tool name');
  if (typeof copied.description !== 'string') throw new Error('Invalid tool description');
  const metadata = copied.metadata === undefined ? undefined : record(copied.metadata);
  if (metadata && 'ag-ui' in metadata) throw new Error('Reserved tool metadata');
  const name = `${namespace}__${copied.name}`;
  if (name.length > 64) throw new Error('Oversized tool name');
  const authored = copied.parameters;
  const parameters = authored === undefined ||
    (typeof authored === 'object' && authored !== null && !Array.isArray(authored) && Object.keys(authored).length === 0)
    ? { type: 'object' } : authored;
  const definition: FrontendTool = { name, description: copied.description, parameters,
    ...(metadata === undefined ? {} : { metadata }) };
  const decodeInput = tool.decodeInput; const handler = tool.execute;
  if (typeof decodeInput !== 'function' || typeof handler !== 'function') throw new Error('Tool requires decodeInput and execute functions');
  const validate = compileParameters(parameters);
  const decode = decodeInput.bind(tool); const execute = handler.bind(tool);
  return Object.freeze({ definition: freeze(definition), async call(args: unknown, conversation: ConversationScope): Promise<FrontendToolOutcome> {
    let value: unknown;
    try { value = copyJson(args); if (!validate(value)) return refused('invalid-arguments'); }
    catch { return refused('invalid-arguments'); }
    let decoded: Input;
    try { decoded = decode(value); }
    catch { return refused('decode-failed'); }
    const output: unknown = await execute(decoded, { conversation });
    if (typeof output !== 'string') throw new Error('Tool output must be a string');
    return { kind: 'completed', output };
  } });
}
interface Lifetime {
  readonly identity: Pick<FrontendToolGeneration, 'namespace' | 'generation' | 'platform' | 'activationId'>;
  tools: readonly Registered[];
  dispose: (() => Promise<void>) | undefined;
  refs: number;
  drained: (() => void) | undefined;
  completion: Promise<void> | undefined;
}
const lifetimes = new WeakMap<object, Lifetime>();
function live(value: unknown): Lifetime {
  const state = typeof value === 'object' && value !== null ? lifetimes.get(value) : undefined;
  if (!state || state.completion) throw new Error('Invalid or retired tool generation');
  return state;
}
function hold(state: Lifetime): void { state.refs++; }
function drop(state: Lifetime): void { if (--state.refs === 0) state.drained?.(); }
function generationHandle(identity: Lifetime['identity'], dispose: () => Promise<void>, tools: readonly Registered[]): FrontendToolGeneration {
  const state: Lifetime = { identity, tools, dispose, refs: 0, drained: undefined, completion: undefined };
  const retire = (): Promise<void> => state.completion ??= new Promise<void>(resolve => {
    state.drained = resolve;
    if (state.refs === 0) resolve();
  }).then(() => {
    const dispose = state.dispose;
    state.dispose = undefined;
    return dispose?.();
  }).finally(() => { state.tools = []; state.drained = undefined; });
  const handle = Object.freeze({ ...identity, retire });
  lifetimes.set(handle, state);
  return handle;
}
/**
 * Creation awaits activation and acceptance without cancellation. An owner that stops waiting
 * must observe the result and retire its generation. A pending acceptance retains captured resources.
 */
export async function createFrontendToolGeneration<L extends ExtensionLifetime>(options: FrontendToolGenerationOptions<L>): Promise<FrontendToolActivation<L>> {
  let dispose: (() => Promise<void>) | undefined;
  try {
    const { generation, activate, accept } = options;
    const platform = frontendPlatform(options.platform);
    const namespace = extensionNamespace(options.namespace);
    if (typeof generation !== 'string' || !generation.trim()) throw new Error('Invalid generation');
    if (typeof activate !== 'function' || typeof accept !== 'function') throw new Error('Tool activation requires activate and accept functions');
    const tools = new Map<string, Registered>();
    let open = true; let failure: { error: unknown } | undefined;
    const registrationSink = Object.freeze({ add<Input>(tool: FrontendToolContribution<Input>): void {
      if (!open) throw new Error('Tool registration is closed');
      try {
        const registered = registerTool(namespace, tool);
        if (tools.has(registered.definition.name)) throw new Error('Duplicate tool name');
        tools.set(registered.definition.name, registered);
      } catch (error) { failure ??= { error }; throw error; }
    } });
    const context = Object.freeze({ namespace, frontendTools: registrationSink });
    let lifetime: unknown; let registered: Registered[];
    try { lifetime = await activate.call(options, context); }
    finally { open = false; registered = [...tools.values()]; tools.clear(); }
    const method = behaviour(lifetime).dispose;
    if (typeof method !== 'function') throw new Error('Expected extension disposal');
    dispose = async () => { await method.call(lifetime); };
    if (failure) throw failure.error;
    const contributions = await accept(lifetime);
    return { generation: generationHandle({ namespace, generation, platform, activationId: globalThis.crypto.randomUUID() }, dispose, registered), contributions };
  } catch (error) {
    let notification: Promise<void>;
    try { notification = Promise.resolve(options.onFailure?.(error)); }
    catch (observerError) { notification = Promise.reject(observerError); }
    const [notified, disposed] = await Promise.allSettled([notification, dispose?.()]);
    if (notified.status === 'rejected') {
      throw new AggregateError([error, notified.reason, ...(disposed.status === 'rejected' ? [disposed.reason] : [])],
        'Tool activation failed and its failure observer also failed');
    }
    if (disposed.status === 'rejected') throw new AggregateError([error, disposed.reason], 'Tool activation failed and its disposal also failed');
    throw error;
  }
}
function readPinOptions(options: FrontendToolPinOptions) {
  const platform = frontendPlatform(options.platform);
  const candidates = [...options.generations];
  const run = freeze(parseRunIdentity(copyJson(options.run)));
  const capabilityTools = options.capabilities?.tools;
  const clientProvided = capabilityTools?.clientProvided;
  const supported = capabilityTools?.supported;
  const agentNames = new Set(capabilityTools?.items?.map(tool => tool.name));
  return { platform, candidates, run, agentNames, enabled: clientProvided === true && supported !== false };
}
export function pinFrontendTools(options: FrontendToolPinOptions): FrontendToolPin {
  const { platform, candidates, run, agentNames, enabled } = readPinOptions(options);
  const selected: Lifetime[] = []; const namespaces = new Set<string>();
  for (const generation of candidates) {
    const state = live(generation);
    if (state.identity.platform !== platform) continue;
    if (namespaces.has(state.identity.namespace)) throw new Error('Duplicate tool namespace');
    namespaces.add(state.identity.namespace); selected.push(state);
  }
  if (enabled) for (const state of selected) for (const tool of state.tools) {
    if (agentNames.has(tool.definition.name)) throw new Error('Tool name collides with an agent-provided tool');
  }
  let held: Lifetime[] | undefined = enabled ? selected.filter(state => state.tools.length > 0) : [];
  const entries = new Map<string, { tool: Registered; state: Lifetime }>();
  for (const state of held) {
    hold(state);
    for (const tool of state.tools) entries.set(tool.definition.name, { tool, state });
  }
  const definitions = Object.freeze([...entries.values()].map(entry => entry.tool.definition));
  const bindings = Object.freeze([...entries].map(([name, entry]) => Object.freeze({ name, activationId: entry.state.identity.activationId })));
  return { run, definitions, bindings,
    async invoke(name, args, activationId): Promise<FrontendToolOutcome> {
      if (!held) return refused('released');
      const entry = entries.get(name);
      if (!entry) return refused('unknown-tool');
      if (activationId !== entry.state.identity.activationId) return refused('activation-mismatch');
      hold(entry.state);
      try { return await entry.tool.call(args, run.conversation); }
      finally { drop(entry.state); }
    },
    release() {
      const generations = held;
      held = undefined;
      entries.clear();
      for (const state of generations ?? []) drop(state);
    },
  };
}
