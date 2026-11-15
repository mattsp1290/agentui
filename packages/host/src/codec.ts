import { canonicalJson } from '@agentui/contracts';
import type { Json } from '@agentui/contracts';

export function copyCanonicalJson(value: unknown): Json { return JSON.parse(canonicalJson(value)); }
export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid integer');
  return value;
}
export function positiveInteger(value: unknown): number {
  const parsed = integer(value);
  if (parsed === 0) throw new Error('Expected positive integer');
  return parsed;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected array');
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}
export function nonempty(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Expected nonempty string');
  return value;
}
