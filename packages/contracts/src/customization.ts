import { record, utf8Bytes } from './decode.js';

export const CUSTOMIZATION_SETTINGS_BYTES = 16_384;
export const CUSTOMIZATION_APPEARANCES = ['system', 'light', 'dark'] as const;
export type CustomizationAppearance = typeof CUSTOMIZATION_APPEARANCES[number];
/** A portable agent selector. It names an agent by what it is, not by a host-local agent ID. */
export type CustomizationDefaultAgent =
  | { readonly kind: 'native'; readonly harness: string; readonly model?: string }
  | { readonly kind: 'provider'; readonly namespace: string; readonly installationId: string; readonly providerAgentId: string };
/** The connected repository's `agentui-settings.json`, with defaults applied. */
export interface CustomizationSettings {
  readonly version: 1;
  readonly appearance: CustomizationAppearance;
  readonly showExtensionViews: boolean;
  readonly defaultAgent?: CustomizationDefaultAgent;
}

function bounded(value: unknown, bytes: number): string {
  if (typeof value !== 'string' || !value.trim() || utf8Bytes(value) > bytes || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('Invalid settings string');
  }
  return value;
}
function defaultAgent(value: unknown): CustomizationDefaultAgent {
  const input = record(value);
  if (input.kind === 'native') {
    record(value, input.model === undefined ? ['kind', 'harness'] : ['kind', 'harness', 'model']);
    return { kind: 'native', harness: bounded(input.harness, 64), ...(input.model === undefined ? {} : { model: bounded(input.model, 128) }) };
  }
  if (input.kind !== 'provider') throw new Error('Invalid default agent');
  record(value, ['kind', 'namespace', 'installationId', 'providerAgentId']);
  return { kind: 'provider', namespace: bounded(input.namespace, 64), installationId: bounded(input.installationId, 1024),
    providerAgentId: bounded(input.providerAgentId, 1024) };
}
/** Parses a settings value. Absent members take their defaults; unknown members and other versions are refused. */
export function parseCustomizationSettings(value: unknown): CustomizationSettings {
  const input = record(value);
  const allowed = ['version', 'appearance', 'showExtensionViews', 'defaultAgent'];
  if (Object.keys(input).some(key => !allowed.includes(key)) || input.version !== 1) throw new Error('Invalid settings');
  const appearance = input.appearance ?? 'system';
  if (!CUSTOMIZATION_APPEARANCES.includes(appearance as CustomizationAppearance)) throw new Error('Invalid appearance');
  if (input.showExtensionViews !== undefined && typeof input.showExtensionViews !== 'boolean') throw new Error('Invalid extension views');
  return { version: 1, appearance: appearance as CustomizationAppearance, showExtensionViews: input.showExtensionViews ?? true,
    ...(input.defaultAgent === undefined ? {} : { defaultAgent: defaultAgent(input.defaultAgent) }) };
}
/** Two-space JSON with keys in a fixed order and a trailing newline, so each settings commit is a small, stable diff. */
export function serializeCustomizationSettings(settings: CustomizationSettings): string {
  const value = parseCustomizationSettings(settings);
  const agent = value.defaultAgent === undefined ? undefined : value.defaultAgent.kind === 'native'
    ? { kind: 'native', harness: value.defaultAgent.harness, ...(value.defaultAgent.model === undefined ? {} : { model: value.defaultAgent.model }) }
    : { kind: 'provider', namespace: value.defaultAgent.namespace, installationId: value.defaultAgent.installationId, providerAgentId: value.defaultAgent.providerAgentId };
  const text = JSON.stringify({ version: 1, appearance: value.appearance, showExtensionViews: value.showExtensionViews,
    ...(agent === undefined ? {} : { defaultAgent: agent }) }, null, 2) + '\n';
  if (utf8Bytes(text) > CUSTOMIZATION_SETTINGS_BYTES) throw new Error('Settings too large');
  return text;
}
