import { canonicalJson } from '@agentui/contracts';
import { record } from '@agentui/contracts/decode';
import { Validator, dereference } from '@cfworker/json-schema';
import { extensionNamespace, validateExtensionLifetime } from './extensions.js';
import { draft7 } from './draft-07.js';
import type { FrontendTool, FrontendToolContribution, FrontendToolGeneration, FrontendToolGenerationOptions, FrontendToolOutcome, FrontendToolPin, FrontendToolPinOptions } from './tool-contracts.js';
export type * from './tool-contracts.js';

type Schema = boolean | Record<string, unknown>;
type Registered = { definition: FrontendTool; validate(value: unknown): boolean; decode(value: unknown): unknown; execute(value: unknown, context: { readonly conversation: FrontendToolPin['run']['conversation'] }): Promise<string> };
let meta: Validator | undefined;
function metaValidator(): Validator { return meta ??= new Validator(draft7, '7', false); }
const keywords = new Set('$schema $ref $comment title description default examples readOnly writeOnly type enum const multipleOf maximum exclusiveMaximum minimum exclusiveMinimum maxLength minLength pattern items additionalItems maxItems minItems uniqueItems contains maxProperties minProperties required properties patternProperties additionalProperties dependencies propertyNames definitions allOf anyOf oneOf not if then else format contentMediaType contentEncoding'.split(' '));
const formats = new Set('date time date-time uri uri-reference uri-template email hostname ipv4 ipv6 regex json-pointer relative-json-pointer'.split(' '));
const refKeys = new Set('$ref $comment title description default examples readOnly writeOnly'.split(' '));
const single = new Set('additionalItems contains additionalProperties propertyNames not if then else'.split(' '));
const maps = new Set('properties patternProperties definitions'.split(' '));
const arrays = new Set('allOf anyOf oneOf'.split(' '));
function copy<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function schemaValidator(input: unknown): (value: unknown) => boolean {
  const parameters = copy(input === undefined ? {} : input);
  const root = (typeof parameters === 'object' && parameters !== null && !Array.isArray(parameters) && Object.keys(parameters).length === 0 ? { type: 'object' } : parameters) as Schema;
  if (typeof root !== 'object' || root === null || root.type !== 'object') throw new Error('Tool parameters must have object type');
  if (!metaValidator().validate(root).valid) throw new Error('Invalid draft-07 schema');
  const edges = new Map<object, Schema[]>();
  const refs: [object, string][] = [];
  function walk(schema: Schema, isRoot = false): void {
    if (typeof schema === 'boolean') return;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Invalid schema node');
    if (edges.has(schema)) return;
    if ('$ref' in schema && Object.keys(schema).some(key => !refKeys.has(key))) throw new Error('Schema references cannot have sibling assertions');
    const children: Schema[] = [];
    edges.set(schema, children);
    for (const [key, value] of Object.entries(schema)) {
      if (!keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
      if (key === '$schema' && (!isRoot || value !== 'http://json-schema.org/draft-07/schema#' && value !== 'http://json-schema.org/draft-07/schema')) throw new Error('Unsupported schema dialect');
      if (key === 'format' && (typeof value !== 'string' || !formats.has(value))) throw new Error('Unsupported schema format');
      if (key === '$ref') {
        if (typeof value !== 'string' || !(value === '#' || value.startsWith('#/'))) throw new Error('Only local schema references are supported');
        refs.push([schema, value]);
      }
      if (single.has(key)) children.push(value as Schema);
      if (maps.has(key)) children.push(...Object.values(value as Record<string, Schema>));
      if (arrays.has(key)) children.push(...value as Schema[]);
      if (key === 'items') children.push(...(Array.isArray(value) ? value : [value]) as Schema[]);
      if (key === 'dependencies') for (const dep of Object.values(value as Record<string, unknown>)) if (!Array.isArray(dep)) children.push(dep as Schema);
    }
    for (const child of children) walk(child);
  }
  walk(root, true);
  const lookup = dereference(root);
  for (const [node] of refs) {
    const absolute = (node as Record<string, unknown>).__absolute_ref__;
    const target = typeof absolute === 'string' ? lookup[absolute] : undefined;
    if (target === undefined || typeof target === 'boolean' || !edges.has(target)) throw new Error('Unresolved schema reference');
    edges.get(node)!.push(target as Schema);
  }
  const visiting = new Set<object>();
  const visited = new Set<object>();
  function visit(node: Schema): void {
    if (typeof node === 'boolean' || visited.has(node)) return;
    if (visiting.has(node)) throw new Error('Recursive schema references are unsupported');
    visiting.add(node);
    for (const child of edges.get(node)!) visit(child);
    visiting.delete(node); visited.add(node);
  }
  visit(root);
  const validator = new Validator(root, '7', false);
  return value => validator.validate(value).valid;
}
const generationTools = new WeakMap<FrontendToolGeneration, readonly Registered[]>();
const generationState = new WeakMap<FrontendToolGeneration, { retired(): boolean; retain(): void; drop(): void }>();
class Generation implements FrontendToolGeneration {
  readonly namespace: string;
  readonly generation: string;
  readonly platform: FrontendToolGeneration['platform'];
  #lifetime: { dispose(): void | Promise<void> };
  #refs = 0;
  #retired = false;
  #completion: Promise<void> | undefined;
  #resolve: (() => void) | undefined;
  #reject!: (error: unknown) => void;
  constructor(options: Pick<FrontendToolGeneration, 'namespace' | 'generation' | 'platform'>, lifetime: { dispose(): void | Promise<void> }, tools: Registered[]) {
    this.namespace = options.namespace; this.generation = options.generation; this.platform = options.platform;
    this.#lifetime = lifetime; generationTools.set(this, Object.freeze(tools));
    generationState.set(this, { retired: () => this.#retired, retain: () => this.#retain(), drop: () => this.#drop() });
    Object.freeze(this);
  }
  #retain(): void { this.#refs++; }
  #drop(): void { this.#refs--; this.#drain(); }
  retire(): Promise<void> {
    if (!this.#completion) {
      this.#retired = true;
      this.#completion = new Promise<void>((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
      this.#drain();
    }
    return this.#completion;
  }
  #drain(): void {
    if (this.#retired && this.#refs === 0 && this.#resolve) {
      const resolve = this.#resolve; const reject = this.#reject;
      this.#resolve = undefined;
      Promise.resolve().then(() => this.#lifetime.dispose()).finally(() => generationTools.delete(this)).then(resolve, reject);
    }
  }
}
export async function createFrontendToolGeneration(options: FrontendToolGenerationOptions): Promise<FrontendToolGeneration> {
  const { generation, platform, activate } = options;
  const namespace = extensionNamespace(options.namespace);
  if (typeof generation !== 'string' || !generation.trim()) throw new Error('Invalid generation');
  if (platform !== 'desktop' && platform !== 'ios') throw new Error('Invalid platform');
  const tools: Registered[] = [];
  const names = new Set<string>();
  let open = true; let poisoned = false; let poison: unknown;
  const contributions = { add<Input>(tool: FrontendToolContribution<Input>): void {
    if (!open) throw new Error('Tool registration is closed');
    try {
      const input = record(tool.definition);
      if (Object.keys(input).some(key => !['name', 'description', 'parameters', 'metadata'].includes(key)) || typeof input.name !== 'string' || typeof input.description !== 'string') throw new Error('Invalid tool definition');
      const metadata = input.metadata === undefined ? undefined : record(input.metadata);
      const definition: FrontendTool = copy({ name: input.name, description: input.description,
        ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
        ...(metadata === undefined ? {} : { metadata }) });
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(definition.name)) throw new Error('Invalid tool name');
      const name = `${namespace}__${definition.name}`;
      if (name.length > 64 || names.has(name)) throw new Error('Duplicate or oversized tool name');
      const validate = schemaValidator(definition.parameters);
      const decode = tool.decodeInput.bind(tool); const execute = tool.execute.bind(tool);
      names.add(name);
      tools.push({ definition: freeze({ ...definition, name }), validate, decode, execute: (value, context) => execute(value as Input, context) });
    } catch (error) { if (!poisoned) poison = error; poisoned = true; throw error; }
  } };
  let lifetime;
  try { lifetime = await activate.call(options, contributions); } finally { open = false; }
  try {
    validateExtensionLifetime(lifetime);
    if (poisoned) throw poison;
    return new Generation({ namespace, generation, platform }, { dispose: lifetime.dispose.bind(lifetime) }, tools);
  } catch (error) {
    if (lifetime && typeof lifetime.dispose === 'function') {
      try { await lifetime.dispose(); }
      catch (disposeError) { throw new AggregateError([error, disposeError], 'Tool activation failed and its disposal also failed'); }
    }
    throw error;
  }
}
export function pinFrontendTools(options: FrontendToolPinOptions): FrontendToolPin {
  const selected: FrontendToolGeneration[] = []; const namespaces = new Set<string>();
  for (const generation of options.generations) {
    const state = generationState.get(generation);
    if (!state || state.retired()) throw new Error('Invalid or retired tool generation');
    if (generation.platform !== options.platform) continue;
    if (namespaces.has(generation.namespace)) throw new Error('Duplicate tool namespace');
    namespaces.add(generation.namespace); selected.push(generation);
  }
  const run = freeze(copy(options.run));
  const enabled = options.capabilities?.tools?.clientProvided === true && options.capabilities.tools.supported !== false;
  const generations = enabled ? selected : [];
  const entries = new Map<string, { tool: Registered; generation: FrontendToolGeneration }>();
  for (const generation of generations) {
    generationState.get(generation)!.retain();
    for (const tool of generationTools.get(generation)!) entries.set(tool.definition.name, { tool, generation });
  }
  const definitions = Object.freeze([...entries.values()].map(entry => entry.tool.definition));
  let released = false;
  return { run, definitions,
    async invoke(name, args): Promise<FrontendToolOutcome> {
      if (released) return { kind: 'refused', code: 'released' };
      const entry = entries.get(name);
      if (!entry) return { kind: 'refused', code: 'unknown-tool' };
      generationState.get(entry.generation)!.retain();
      try {
        let value: unknown;
        try { value = copy(args); if (!entry.tool.validate(value)) return { kind: 'refused', code: 'invalid-arguments' }; }
        catch { return { kind: 'refused', code: 'invalid-arguments' }; }
        let decoded: unknown;
        try { decoded = entry.tool.decode(value); } catch { return { kind: 'refused', code: 'decode-failed' }; }
        const output = await entry.tool.execute(decoded, { conversation: run.conversation });
        if (typeof output !== 'string') throw new Error('Tool output must be a string');
        return { kind: 'completed', output };
      } finally { generationState.get(entry.generation)!.drop(); }
    },
    release() { if (!released) { released = true; entries.clear(); for (const generation of generations) generationState.get(generation)!.drop(); } },
  };
}
