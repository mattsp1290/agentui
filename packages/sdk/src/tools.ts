import { copyJson, parseRunIdentity, type ConversationScope } from '@agentui/contracts';
import { record } from '@agentui/contracts/decode';
import { behaviour, extensionNamespace, frontendPlatform } from './extensions.js';
import { compileParameters } from './schema.js';
import type { FrontendTool, FrontendToolContribution, FrontendToolGeneration, FrontendToolGenerationOptions, FrontendToolActivation, AcceptedContributions, FrontendToolOutcome, FrontendToolPin, FrontendToolPinOptions } from './tool-contracts.js';
export type * from './tool-contracts.js';

type Registered = { definition: FrontendTool; validate(value: unknown): boolean; decode(value: unknown): unknown; execute(value: unknown, context: { readonly conversation: ConversationScope }): Promise<string> };
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
  const copied = record(copyJson({ name: input.name, description: input.description,
    ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }) }));
  if (typeof copied.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(copied.name)) throw new Error('Invalid tool name');
  if (typeof copied.description !== 'string') throw new Error('Invalid tool description');
  const metadata = copied.metadata === undefined ? undefined : record(copied.metadata);
  if (metadata && 'ag-ui' in metadata) throw new Error('Reserved tool metadata');
  const name = `${namespace}__${copied.name}`;
  if (name.length > 64) throw new Error('Oversized tool name');
  const definition: FrontendTool = { name, description: copied.description,
    ...(copied.parameters === undefined ? {} : { parameters: copied.parameters }),
    ...(metadata === undefined ? {} : { metadata }) };
  const validate = compileParameters(definition.parameters);
  if (typeof tool.decodeInput !== 'function' || typeof tool.execute !== 'function') throw new Error('Tool requires decodeInput and execute functions');
  const decode = tool.decodeInput.bind(tool); const execute = tool.execute.bind(tool);
  return { definition: freeze(definition), validate, decode, execute: (value, context) => execute(value as Input, context) };
}
function prepare(tool: Registered, args: unknown): FrontendToolOutcome | { decoded: unknown } {
  let value: unknown;
  try { value = copyJson(args); if (!tool.validate(value)) return { kind: 'refused', code: 'invalid-arguments' }; }
  catch { return { kind: 'refused', code: 'invalid-arguments' }; }
  try { return { decoded: tool.decode(value) }; }
  catch { return { kind: 'refused', code: 'decode-failed' }; }
}
const construct = Symbol('Generation');
let isLive: (value: unknown) => value is Generation;
let acquire: (generation: Generation) => readonly Registered[];
let release: (generation: Generation) => void;
class Generation implements FrontendToolGeneration {
  readonly namespace: string;
  readonly generation: string;
  readonly platform: FrontendToolGeneration['platform'];
  #tools: readonly Registered[];
  #dispose: (() => void | Promise<void>) | undefined;
  #refs = 0;
  #drained: (() => void) | undefined;
  #completion: Promise<void> | undefined;
  constructor(key: typeof construct, options: Pick<FrontendToolGeneration, 'namespace' | 'generation' | 'platform'>, dispose: () => void | Promise<void>, tools: Registered[]) {
    if (key !== construct) throw new TypeError('Illegal constructor');
    this.namespace = options.namespace; this.generation = options.generation; this.platform = options.platform;
    this.#dispose = dispose; this.#tools = Object.freeze(tools.map(tool => Object.freeze(tool)));
    Object.freeze(this);
  }
  static {
    isLive = (value): value is Generation => typeof value === 'object' && value !== null && #refs in value && !value.#completion;
    acquire = generation => { generation.#refs++; return generation.#tools; };
    release = generation => { if (--generation.#refs === 0) generation.#drained?.(); };
  }
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
export async function createFrontendToolGeneration<A extends (value: unknown) => void>(options: FrontendToolGenerationOptions<A>): Promise<FrontendToolActivation<AcceptedContributions<A>>> {
  const { generation, activate, accept } = options;
  const platform = frontendPlatform(options.platform);
  const namespace = extensionNamespace(options.namespace);
  if (typeof generation !== 'string' || !generation.trim()) throw new Error('Invalid generation');
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
    const method = behaviour(lifetime).dispose;
    if (typeof method !== 'function') throw new Error('Expected extension disposal');
    dispose = async () => { await method.call(lifetime); };
    if (failure) throw failure.error;
    const validate: (value: unknown) => asserts value is AcceptedContributions<A> = accept;
    validate(lifetime);
    return { generation: new Generation(construct, { namespace, generation, platform }, dispose, tools), contributions: lifetime };
  } catch (error) {
    if (dispose) {
      try { await dispose(); }
      catch (disposeError) { throw new AggregateError([error, disposeError], 'Tool activation failed and its disposal also failed'); }
    }
    throw error;
  }
}
export function pinFrontendTools(options: FrontendToolPinOptions): FrontendToolPin {
  const platform = frontendPlatform(options.platform);
  const selected: Generation[] = []; const namespaces = new Set<string>();
  for (const generation of options.generations) {
    if (!isLive(generation)) throw new Error('Invalid or retired tool generation');
    if (generation.platform !== platform) continue;
    if (namespaces.has(generation.namespace)) throw new Error('Duplicate tool namespace');
    namespaces.add(generation.namespace); selected.push(generation);
  }
  const run = freeze(parseRunIdentity(copyJson(options.run)));
  const enabled = options.capabilities?.tools?.clientProvided === true && options.capabilities.tools.supported !== false;
  let held: Generation[] | undefined = enabled ? selected : [];
  const entries = new Map<string, { tool: Registered; generation: Generation }>();
  for (const generation of held) {
    for (const tool of acquire(generation)) entries.set(tool.definition.name, { tool, generation });
  }
  const definitions = Object.freeze([...entries.values()].map(entry => entry.tool.definition));
  return { run, definitions,
    async invoke(name, args): Promise<FrontendToolOutcome> {
      if (!held) return { kind: 'refused', code: 'released' };
      const entry = entries.get(name);
      if (!entry) return { kind: 'refused', code: 'unknown-tool' };
      acquire(entry.generation);
      try {
        const prepared = prepare(entry.tool, args);
        if ('kind' in prepared) return prepared;
        const output = await entry.tool.execute(prepared.decoded, { conversation: run.conversation });
        if (typeof output !== 'string') throw new Error('Tool output must be a string');
        return { kind: 'completed', output };
      } finally { release(entry.generation); }
    },
    release() {
      const generations = held;
      held = undefined;
      entries.clear();
      for (const generation of generations ?? []) release(generation);
    },
  };
}
