import { Validator, dereference, schemaKeyword, schemaArrayKeyword, schemaMapKeyword, type Schema as LibrarySchema } from '@cfworker/json-schema';
import { draft7 } from './draft-07.js';
import { copyToolJson as copy } from './tool-json.js';
type Schema = boolean | LibrarySchema;
let meta: Validator | undefined;
function metaValidator(): Validator {
  try { return meta ??= new Validator(draft7, '7', false); }
  catch (cause) { throw new Error('Tool schema validation requires a standards-compliant URL implementation', { cause }); }
}
const keywords = new Set('$schema $ref $comment title description default examples readOnly writeOnly type enum const multipleOf maximum exclusiveMaximum minimum exclusiveMinimum maxLength minLength pattern items additionalItems maxItems minItems uniqueItems contains maxProperties minProperties required properties patternProperties additionalProperties dependencies propertyNames definitions allOf anyOf oneOf not if then else format contentMediaType contentEncoding'.split(' '));
const formats = new Set('date time date-time uri uri-reference uri-template email hostname ipv4 ipv6 regex json-pointer relative-json-pointer'.split(' '));
const refKeys = new Set('$ref $comment title description default examples readOnly writeOnly'.split(' '));
export function compileParameters(input: unknown): (value: unknown) => boolean {
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
      if (key === '$schema' && (!isRoot || (value !== 'http://json-schema.org/draft-07/schema#' && value !== 'http://json-schema.org/draft-07/schema'))) throw new Error('Unsupported schema dialect');
      if (key === 'format' && (typeof value !== 'string' || !formats.has(value))) throw new Error('Unsupported schema format');
      if (key === '$ref') {
        if (typeof value !== 'string' || !(value === '#' || value.startsWith('#/'))) throw new Error('Only local schema references are supported');
        refs.push([schema, value]);
      }
      if (Array.isArray(value) && schemaArrayKeyword[key]) children.push(...value as Schema[]);
      else if (schemaMapKeyword[key]) children.push(...Object.values(value as Record<string, Schema>));
      else if (schemaKeyword[key]) children.push(value as Schema);
      else if (key === 'dependencies') for (const dep of Object.values(value as Record<string, unknown>)) if (!Array.isArray(dep)) children.push(dep as Schema);
    }
    for (const child of children) walk(child);
  }
  walk(root, true);
  const lookup = dereference(root);
  for (const [node] of refs) {
    const absolute = (node as LibrarySchema).__absolute_ref__;
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
