import { Validator, schemaKeyword, schemaArrayKeyword, schemaMapKeyword, type Schema as LibrarySchema } from '@cfworker/json-schema';
import { draft7 } from './draft-07.js';
import { copyJson } from '@agentui/contracts';
type Schema = boolean | LibrarySchema;
let meta: Validator | undefined;
function metaValidator(): Validator {
  try { return meta ??= new Validator(draft7, '7'); }
  catch (cause) { throw new Error('Tool schema validation requires a standards-compliant URL implementation', { cause }); }
}
const keywords = new Set(Object.keys(draft7.properties).filter(key => !['$ref', 'definitions', '$id'].includes(key)));
const formats = new Set('date time date-time uri uri-reference uri-template email hostname ipv4 ipv6 regex json-pointer relative-json-pointer'.split(' '));
const dialects = new Set(['http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-07/schema']);
export function compileParameters(input: unknown): (value: unknown) => boolean {
  // cfworker adds hidden reference metadata, so it must own a mutable copy of the wire schema.
  const parameters = copyJson(input === undefined ? {} : input);
  const empty = typeof parameters === 'object' && parameters !== null && !Array.isArray(parameters) && Object.keys(parameters).length === 0;
  const root = (empty ? { type: 'object' } : parameters) as Schema;
  if (typeof root !== 'object' || root === null || root.type !== 'object') throw new Error('Tool parameters must have object type');
  if (!metaValidator().validate(root).valid) throw new Error('Invalid draft-07 schema');
  function walk(schema: Schema): void {
    if (typeof schema === 'boolean') return;
    const children: Schema[] = [];
    for (const [key, value] of Object.entries(schema)) {
      if (!keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
      if (key === '$schema' && (schema !== root || typeof value !== 'string' || !dialects.has(value))) throw new Error('Unsupported schema dialect');
      if (key === 'format' && (typeof value !== 'string' || !formats.has(value))) throw new Error('Unsupported schema format');
      if (Array.isArray(value) && schemaArrayKeyword[key]) children.push(...value as Schema[]);
      else if (schemaMapKeyword[key]) children.push(...Object.values(value as Record<string, Schema>));
      else if (schemaKeyword[key]) children.push(value as Schema);
      else if (key === 'dependencies') for (const dep of Object.values(value as Record<string, unknown>)) if (!Array.isArray(dep)) children.push(dep as Schema);
    }
    for (const child of children) walk(child);
  }
  walk(root);
  let validator: Validator;
  try { validator = new Validator(root, '7'); }
  catch (cause) { throw new Error('Unsupported tool schema', { cause }); }
  return value => validator.validate(value).valid;
}
