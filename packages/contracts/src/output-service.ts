import { record, exact } from './decode.js';
import { parseScope, sameScope } from './durable.js';
import type { ConversationScope } from './index.js';
import { parseOutputId, parseTextMetadata, OUTPUT_MAX_COUNT } from './output.js';
import type { OutputId, OutputListing, OutputRead, OutputFailure, TextOutput } from './output.js';
export type OutputListValue = { readonly scope: ConversationScope; readonly result: OutputListing };
export type OutputReadValue = { readonly scope: ConversationScope; readonly outputId: OutputId; readonly result:
  Exclude<OutputRead, { readonly kind: 'available' }> | { readonly kind: 'available'; readonly output: TextOutput; readonly base64: string } };
function descriptor(value: unknown): TextOutput {
  const input = record(value, ['outputId', 'name', 'mediaType', 'byteLength', 'sha256', 'lifetime']);
  if (input.lifetime !== 'provider-retained') throw new Error('Invalid output lifetime');
  return { ...parseTextMetadata({ name: input.name, mediaType: input.mediaType, byteLength: input.byteLength, sha256: input.sha256 }),
    outputId: parseOutputId(input.outputId), lifetime: input.lifetime };
}
function failure(value: unknown): OutputFailure {
  const input = record(value, ['kind', 'reason']);
  if (input.kind === 'unsupported' && input.reason === 'outputs-unsupported') return { kind: input.kind, reason: input.reason };
  if (input.kind === 'unavailable' && input.reason === 'outputs-unavailable') return { kind: input.kind, reason: input.reason };
  if (input.kind === 'invalid' && input.reason === 'outputs-invalid') return { kind: input.kind, reason: input.reason };
  throw new Error('Invalid output outcome');
}
function correlatedScope(expected: ConversationScope, value: unknown): ConversationScope {
  const scope = parseScope(value);
  if (!sameScope(expected, scope)) throw new Error('Foreign output scope');
  return scope;
}
export function parseOutputList(request: { readonly scope: ConversationScope }, value: unknown): OutputListValue {
  const input = record(value, ['scope', 'result']), scope = correlatedScope(request.scope, input.scope), result = record(input.result);
  if (result.kind !== 'available') return { scope, result: failure(result) };
  exact(result, ['kind', 'outputs']);
  if (!Array.isArray(result.outputs) || result.outputs.length > OUTPUT_MAX_COUNT) throw new Error('Invalid output list');
  const outputs = result.outputs.map(descriptor);
  if (new Set(outputs.map(output => output.outputId)).size !== outputs.length) throw new Error('Duplicate output');
  return { scope, result: { kind: 'available', outputs } };
}
function canonicalBase64(value: unknown, length: number): string {
  if (typeof value !== 'string' || value.length !== 4 * Math.ceil(length / 3)) throw new Error('Invalid base64 length');
  const padding = length % 3 === 1 ? 2 : length % 3 === 2 ? 1 : 0;
  const content = value.slice(0, value.length - padding);
  if (!/^[A-Za-z0-9+/]*$/u.test(content) || value.slice(content.length) !== '='.repeat(padding)) throw new Error('Invalid base64 alphabet');
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(content.at(-1) ?? 'A');
  if (padding === 2 && last % 16 !== 0 || padding === 1 && last % 4 !== 0) throw new Error('Noncanonical base64');
  return value;
}
export function parseOutputRead(request: { readonly scope: ConversationScope; readonly outputId: OutputId }, value: unknown): OutputReadValue {
  const input = record(value, ['scope', 'outputId', 'result']), scope = correlatedScope(request.scope, input.scope), outputId = parseOutputId(input.outputId);
  if (outputId !== request.outputId) throw new Error('Foreign output ID');
  const result = record(input.result);
  if (result.kind === 'available') {
    exact(result, ['kind', 'output', 'base64']);
    const output = descriptor(result.output);
    if (output.outputId !== outputId) throw new Error('Foreign descriptor ID');
    return { scope, outputId, result: { kind: 'available', output, base64: canonicalBase64(result.base64, output.byteLength) } };
  }
  if (result.kind === 'missing') {
    exact(result, ['kind', 'reason']);
    if (result.reason !== 'output-missing') throw new Error('Invalid missing outcome');
    return { scope, outputId, result: { kind: 'missing', reason: result.reason } };
  }
  return { scope, outputId, result: failure(result) };
}
