import { parseScope } from '@agentui/contracts';
import { nonempty, record } from '@agentui/contracts/decode';
import { behaviour, extensionNamespace } from './extensions.js';
import { compileParameters } from './schema.js';
import { copyToolJson as copy } from './tool-json.js';
import type { FrontendTool, FrontendToolContribution, FrontendToolGeneration, FrontendToolGenerationOptions, FrontendToolActivation, Accepted, FrontendToolOutcome, FrontendToolPin, FrontendToolPinOptions } from './tool-contracts.js';
export type * from './tool-contracts.js';

type Registered = { definition: FrontendTool; validate(value: unknown): boolean; decode(value: unknown): unknown; execute(value: unknown, context: { readonly conversation: import('@agentui/contracts').ConversationScope }): Promise<string> };
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function registerTool<Input>(namespace: string, tool: FrontendToolContribution<Input>): Registered {
  const input = record(tool.definition);
  if (Object.keys(input).some(key => !['name', 'description', 'parameters', 'metadata'].includes(key)) || typeof input.name !== 'string' || typeof input.description !== 'string') throw new Error('Invalid tool definition');
  const metadata = input.metadata === undefined ? undefined : record(input.metadata);
  if (metadata && 'ag-ui' in metadata) throw new Error('Reserved tool metadata');
  const definition: FrontendTool = copy({ name: input.name, description: input.description,
    ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
    ...(metadata === undefined ? {} : { metadata }) });
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(definition.name)) throw new Error('Invalid tool name');
  const name = `${namespace}__${definition.name}`;
  if (name.length > 64) throw new Error('Oversized tool name');
  const validate = compileParameters(definition.parameters);
  const decode = tool.decodeInput.bind(tool); const execute = tool.execute.bind(tool);
  return { definition: freeze({ ...definition, name }), validate, decode, execute: (value, context) => execute(value as Input, context) };
}
function prepare(tool: Registered, args: unknown): FrontendToolOutcome | { decoded: unknown } {
  let value: unknown;
  try { value = copy(args); if (!tool.validate(value)) return { kind: 'refused', code: 'invalid-arguments' }; }
  catch { return { kind: 'refused', code: 'invalid-arguments' }; }
  try { return { decoded: tool.decode(value) }; }
  catch { return { kind: 'refused', code: 'decode-failed' }; }
}
class Generation implements FrontendToolGeneration {
  readonly namespace: string;
  readonly generation: string;
  readonly platform: FrontendToolGeneration['platform'];
  #tools: readonly Registered[];
  #dispose: (() => void | Promise<void>) | undefined;
  #refs = 0;
  #drained: (() => void) | undefined;
  #completion: Promise<void> | undefined;
  constructor(options: Pick<FrontendToolGeneration, 'namespace' | 'generation' | 'platform'>, dispose: () => void | Promise<void>, tools: Registered[]) {
    this.namespace = options.namespace; this.generation = options.generation; this.platform = options.platform;
    this.#dispose = dispose; this.#tools = Object.freeze(tools);
    Object.freeze(this);
  }
  static live(value: FrontendToolGeneration): value is Generation {
    return typeof value === 'object' && value !== null && #refs in value && !value.#completion;
  }
  static acquire(value: Generation): readonly Registered[] { value.#refs++; return value.#tools; }
  static release(value: Generation): void { if (--value.#refs === 0) value.#drained?.(); }
  readonly retire = (): Promise<void> => {
    return this.#completion ??= new Promise<void>(resolve => {
      this.#drained = resolve;
      if (this.#refs === 0) resolve();
    }).then(() => {
      const dispose = this.#dispose;
      this.#dispose = undefined;
      return dispose?.();
    }).finally(() => { this.#tools = []; this.#drained = undefined; });
  };
}
export async function createFrontendToolGeneration<A extends (value: unknown) => void>(options: FrontendToolGenerationOptions<A>): Promise<FrontendToolActivation<Accepted<A>>> {
  const { generation, platform, activate, accept } = options;
  const namespace = extensionNamespace(options.namespace);
  if (typeof generation !== 'string' || !generation.trim()) throw new Error('Invalid generation');
  if (platform !== 'desktop' && platform !== 'ios') throw new Error('Invalid platform');
  const tools: Registered[] = [];
  const names = new Set<string>();
  let open = true; let failure: { error: unknown } | undefined;
  const contributions = { add<Input>(tool: FrontendToolContribution<Input>): void {
    if (!open) throw new Error('Tool registration is closed');
    try {
      const registered = registerTool(namespace, tool);
      if (names.has(registered.definition.name)) throw new Error('Duplicate tool name');
      names.add(registered.definition.name);
      tools.push(registered);
    } catch (error) { failure ??= { error }; throw error; }
  } };
  let lifetime: unknown;
  try { lifetime = await activate.call(options, contributions); } finally { open = false; }
  let dispose: (() => void | Promise<void>) | undefined;
  try {
    const object = behaviour(lifetime);
    const method = object.dispose;
    if (typeof method === 'function') dispose = async () => { await method.call(lifetime); };
    if (!dispose) throw new Error('Expected extension disposal');
    const validate: (value: unknown) => asserts value is Accepted<A> = accept;
    validate(lifetime);
    if (failure) throw failure.error;
    return { generation: new Generation({ namespace, generation, platform }, dispose, tools), contributions: lifetime };
  } catch (error) {
    if (dispose) {
      try { await dispose(); }
      catch (disposeError) { throw new AggregateError([error, disposeError], 'Tool activation failed and its disposal also failed'); }
    }
    throw error;
  }
}
function parseRun(value: unknown): import('@agentui/contracts').RunIdentity {
  const input = record(value, ['conversation', 'runId', 'authority']);
  const authority = record(input.authority);
  const binding = record(authority.binding, ['namespace', 'installationId', 'opaqueSessionId']);
  const parsedBinding = { namespace: nonempty(binding.namespace), installationId: nonempty(binding.installationId), opaqueSessionId: nonempty(binding.opaqueSessionId) };
  const conversation = parseScope(input.conversation);
  const runId = nonempty(input.runId);
  if (authority.kind === 'agentui-host') {
    record(authority, ['kind', 'hostId', 'binding']);
    return { conversation, runId, authority: { kind: 'agentui-host', hostId: nonempty(authority.hostId), binding: parsedBinding } };
  }
  if (authority.kind === 'remote-provider') {
    record(authority, ['kind', 'binding']);
    return { conversation, runId, authority: { kind: 'remote-provider', binding: parsedBinding } };
  }
  throw new Error('Invalid run authority');
}

export function pinFrontendTools(options: FrontendToolPinOptions): FrontendToolPin {
  if (options.platform !== 'desktop' && options.platform !== 'ios') throw new Error('Invalid platform');
  const selected: Generation[] = []; const namespaces = new Set<string>();
  for (const generation of options.generations) {
    if (!Generation.live(generation)) throw new Error('Invalid or retired tool generation');
    if (generation.platform !== options.platform) continue;
    if (namespaces.has(generation.namespace)) throw new Error('Duplicate tool namespace');
    namespaces.add(generation.namespace); selected.push(generation);
  }
  const run = freeze(parseRun(copy(options.run)));
  const enabled = options.capabilities?.tools?.clientProvided === true && options.capabilities.tools.supported !== false;
  let generations = enabled ? selected : [];
  const entries = new Map<string, { tool: Registered; generation: Generation }>();
  for (const generation of generations) {
    for (const tool of Generation.acquire(generation)) entries.set(tool.definition.name, { tool, generation });
  }
  const definitions = Object.freeze([...entries.values()].map(entry => entry.tool.definition));
  let released = false;
  return { run, definitions,
    async invoke(name, args): Promise<FrontendToolOutcome> {
      if (released) return { kind: 'refused', code: 'released' };
      const entry = entries.get(name);
      if (!entry) return { kind: 'refused', code: 'unknown-tool' };
      Generation.acquire(entry.generation);
      try {
        const prepared = prepare(entry.tool, args);
        if ('kind' in prepared) return prepared;
        const output = await entry.tool.execute(prepared.decoded, { conversation: run.conversation });
        if (typeof output !== 'string') throw new Error('Tool output must be a string');
        return { kind: 'completed', output };
      } finally { Generation.release(entry.generation); }
    },
    release() { if (!released) { released = true; entries.clear(); const held = generations; generations = []; for (const generation of held) Generation.release(generation); } },
  };
}
