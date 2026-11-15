import { Validator, dereference, schemaKeyword, schemaArrayKeyword, schemaMapKeyword, type Schema as LibrarySchema } from '@cfworker/json-schema';
import { draft7 } from './draft-07.js';
import { copyJson } from '@agentui/contracts';
type Schema = boolean | LibrarySchema;
let meta: Validator | undefined;
function metaValidator(): Validator {
  try { return meta ??= new Validator(draft7, '7'); }
  catch (cause) { throw new Error('Tool schema validation requires a standards-compliant URL implementation', { cause }); }
}
const keywords = new Set([
  '$schema', '$ref', '$comment',
  'type', 'enum', 'const', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum',
  'maxLength', 'minLength', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'maxProperties', 'minProperties', 'required',
  'items', 'additionalItems', 'contains', 'properties', 'patternProperties', 'additionalProperties', 'dependencies',
  'propertyNames', 'definitions', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
  'title', 'description', 'default', 'examples', 'readOnly', 'writeOnly', 'format', 'contentMediaType', 'contentEncoding',
]);
const formats = new Set('date time date-time uri uri-reference uri-template email hostname ipv4 ipv6 regex json-pointer relative-json-pointer'.split(' '));
const dialects = new Set(['http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-07/schema']);
const refKeys = new Set('$ref $comment title description default examples readOnly writeOnly'.split(' '));
// cfworker 4.1.6 writes these URI fields; dependencies named id or $id can incorrectly rebase them.
function localTarget(lookup: ReturnType<typeof dereference>, root: LibrarySchema, node: LibrarySchema): Schema | undefined {
  const base = root.__absolute_uri__, absolute = node.__absolute_ref__;
  if (typeof base !== 'string' || typeof absolute !== 'string') return undefined;
  return absolute === base || absolute.startsWith(`${base}#`) ? lookup[absolute] : undefined;
}
export function compileParameters(input: unknown): (value: unknown) => boolean {
  // cfworker adds hidden reference metadata, so it must own a mutable copy of the wire schema.
  const parameters = copyJson(input === undefined ? {} : input);
  const empty = typeof parameters === 'object' && parameters !== null && !Array.isArray(parameters) && Object.keys(parameters).length === 0;
  const root = (empty ? { type: 'object' } : parameters) as Schema;
  if (typeof root !== 'object' || root === null || root.type !== 'object') throw new Error('Tool parameters must have object type');
  if (!metaValidator().validate(root).valid) throw new Error('Invalid draft-07 schema');
  const edges = new Map<object, Schema[]>();
  const refs: LibrarySchema[] = [];
  function walk(schema: Schema): void {
    if (typeof schema === 'boolean') return;
    if ('$ref' in schema && Object.keys(schema).some(key => !refKeys.has(key))) throw new Error('Schema references cannot have sibling assertions');
    const children: Schema[] = [];
    edges.set(schema, children);
    for (const [key, value] of Object.entries(schema)) {
      if (!keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
      if (key === '$schema' && (schema !== root || typeof value !== 'string' || !dialects.has(value))) throw new Error('Unsupported schema dialect');
      if (key === 'format' && (typeof value !== 'string' || !formats.has(value))) throw new Error('Unsupported schema format');
      if (key === '$ref') {
        if (typeof value !== 'string' || !(value === '#' || value.startsWith('#/'))) throw new Error('Only local schema references are supported');
        refs.push(schema);
      }
      if (Array.isArray(value) && schemaArrayKeyword[key]) children.push(...value as Schema[]);
      else if (schemaMapKeyword[key]) children.push(...Object.values(value as Record<string, Schema>));
      else if (schemaKeyword[key]) children.push(value as Schema);
      else if (key === 'dependencies') for (const dep of Object.values(value as Record<string, unknown>)) if (!Array.isArray(dep)) children.push(dep as Schema);
    }
    for (const child of children) walk(child);
  }
  walk(root);
  const lookup = dereference(root);
  for (const node of refs) {
    const target = localTarget(lookup, root, node);
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
  const validator = new Validator(root, '7');
  return value => validator.validate(value).valid;
}
