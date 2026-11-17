import { z } from 'zod';
import type { NativeAgentDescriptor } from '@agentui/contracts/service';

export type CodexModel = NonNullable<NativeAgentDescriptor['model']> & { readonly inputModalities?: readonly ('text' | 'image')[] };
interface CatalogModel {
  readonly model: CodexModel;
  readonly isDefault: boolean;
  readonly selectable: boolean;
}
interface Generation {
  readonly family: string;
  readonly version: readonly number[];
  readonly key: string;
}
const text = z.string().min(1).max(1024);
const page = z.object({
  data: z.array(z.object({ model: text, displayName: text, hidden: z.boolean(), isDefault: z.boolean().optional().default(false),
    inputModalities: z.array(z.string()).optional() })),
  nextCursor: text.nullable(),
});
function generation(id: string): Generation | null {
  const match = /^([a-z][a-z0-9]*)-(\d+(?:\.\d+)*)(?:-|$)/i.exec(id);
  if (!match?.[1] || !match[2]) return null;
  const version = match[2].split('.').map(Number);
  if (!version.every(Number.isSafeInteger)) return null;
  while (version.length > 1 && version.at(-1) === 0) version.pop();
  const family = match[1].toLowerCase();
  return { family, version, key: `${family}-${version.join('.')}` };
}
function newestFirst(a: Generation, b: Generation): number {
  for (let index = 0; index < Math.max(a.version.length, b.version.length); index++) {
    const difference = (b.version[index] ?? 0) - (a.version[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
function recentModels(models: readonly Omit<CatalogModel, 'selectable'>[]): readonly CatalogModel[] {
  const families = new Map<string, Map<string, Generation>>();
  for (const entry of models) {
    const value = generation(entry.model.id);
    if (!value) continue;
    let versions = families.get(value.family);
    if (!versions) { versions = new Map(); families.set(value.family, versions); }
    versions.set(value.key, value);
  }
  const recent = new Set([...families.values()].flatMap(versions => [...versions.values()].sort(newestFirst).slice(0, 3).map(value => value.key)));
  return models.map(entry => {
    const value = generation(entry.model.id);
    return { ...entry, selectable: value === null || recent.has(value.key) };
  });
}

export async function discoverCodexModels(request: (params: { readonly includeHidden: false; readonly cursor?: string }) => Promise<unknown>): Promise<readonly CatalogModel[]> {
  const models = new Map<string, Omit<CatalogModel, 'selectable'>>(), cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const parsed = page.safeParse(await request({ includeHidden: false, ...(cursor === undefined ? {} : { cursor }) }));
    if (!parsed.success) throw new Error('Codex returned an invalid model catalog.');
    for (const model of parsed.data.data) {
      const inputModalities = [...new Set(model.inputModalities?.filter(item => item === 'text' || item === 'image'))];
      if (!model.hidden && !models.has(model.model)) models.set(model.model, {
        model: { id: model.model, label: model.displayName.replace(/(\d)-(?=[a-z])/gi, '$1 '), ...(inputModalities.length ? { inputModalities } : {}) },
        isDefault: model.isDefault,
      });
    }
    const next = parsed.data.nextCursor;
    if (next === null) return recentModels([...models.values()]);
    if (cursors.has(next)) throw new Error('Codex repeated a model catalog cursor.');
    cursors.add(next);
    cursor = next;
  }
}
