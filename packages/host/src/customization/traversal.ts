import { CustomizationError } from './contract.js';

export function customizationPreorder<T>(root: T, identity: (node: T) => string, children: (node: T) => readonly T[]): readonly T[] {
  const ordered: T[] = [], active = new Set<string>(), seen = new Set<string>();
  const visit = (node: T): void => {
    const id = identity(node);
    if (active.has(id)) throw CustomizationError.fixed('invalid-graph');
    if (seen.has(id)) return;
    seen.add(id); active.add(id); ordered.push(node);
    for (const child of children(node)) visit(child);
    active.delete(id);
  };
  visit(root);
  return ordered;
}
