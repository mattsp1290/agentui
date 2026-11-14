export function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected plain object');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('Expected plain object');
  if (Object.getOwnPropertySymbols(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some(property => !('value' in property))) {
    throw new Error('Expected plain data properties');
  }
  const input = value as Record<string, unknown>;
  if (keys !== undefined) exact(input, keys);
  return input;
}
export function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const fields = Object.keys(value);
  if (fields.length !== keys.length || fields.some(key => !keys.includes(key))) throw new Error('Unexpected or missing field');
}
export function nonempty(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Expected nonempty string');
  return value;
}
export function identifier(value: unknown, max = 1024): string {
  const text = nonempty(value);
  if (text.length > max) throw new Error('Identifier exceeds length limit');
  return text;
}
export function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid integer');
  return value;
}
export function hex(value: unknown, ...lengths: readonly number[]): string {
  if (typeof value !== 'string' || !lengths.includes(value.length) || !/^[a-f0-9]+$/.test(value)) throw new Error('Invalid hexadecimal digest');
  return value;
}
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const unit = character.charCodeAt(0);
    bytes += character.length === 2 ? 4 : unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
  }
  return bytes;
}
