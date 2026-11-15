import { canonicalJson } from '@agentui/contracts';

function copyData(value: unknown): unknown {
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) result.push(copyData(value[index]));
    return result;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).map(key => [key, copyData(Reflect.get(value, key))]));
  }
  return value;
}

export function copyToolJson<T>(value: T): T {
  canonicalJson(value);
  return copyData(value) as T;
}
