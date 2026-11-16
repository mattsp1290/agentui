import type { ComponentType } from 'react';
import type { ConversationDocument, ConversationPermissions, ConversationScope, PermissionScope, SubmitResult } from '@agentui/contracts';
import type { Transcript } from '@agentui/contracts/conversation';
import { nonempty } from '@agentui/contracts/decode';
import type { UiExtensionContext } from './tool-contracts.js';
export type { FrontendToolContribution, FrontendToolContributions, UiExtensionContext } from './tool-contracts.js';
import { behaviour } from './extensions.js';
import type { EXTENSION_SDK_VERSION, ExtensionLifetime, FrontendPlatform } from './extensions.js';

export interface ConversationCommands {
  send(text: string): Promise<SubmitResult>;
  approve(pendingId: string, choiceId: string): Promise<SubmitResult>;
  revokePermission(permissionId: string, scope: PermissionScope): Promise<SubmitResult>;
  cancel(runId: string): Promise<SubmitResult>;
}
export interface ConversationModuleProps {
  readonly conversation: ConversationScope;
  readonly activity: ConversationDocument<Transcript>;
  readonly commands: ConversationCommands;
  readonly permissions: { read(): Promise<ConversationPermissions> };
}
export interface ModuleAction {
  readonly id: string;
  readonly label: string;
  run(context: ConversationModuleProps): Promise<SubmitResult>;
}
export interface ConversationModule {
  readonly id: string;
  readonly label: string;
  readonly component: ComponentType<ConversationModuleProps>;
  readonly children?: readonly ConversationModule[];
  readonly actions?: readonly ModuleAction[];
}

export interface UiExtensionContributions extends ExtensionLifetime {
  readonly modules: readonly ConversationModule[];
  readonly overrides?: { readonly transcript?: ComponentType<ConversationModuleProps> };
}
export interface UiExtensionEntry<K extends FrontendPlatform> {
  readonly kind: K;
  readonly sdkVersion: typeof EXTENSION_SDK_VERSION;
  activate(context: UiExtensionContext): UiExtensionContributions | Promise<UiExtensionContributions>;
}

export interface UiExtensionPresentation {
  readonly modules: readonly ConversationModule[];
  readonly transcript: ComponentType<ConversationModuleProps> | undefined;
}
export type UiExtensionCapture =
  | { readonly kind: 'invalid-lifetime'; readonly error: unknown }
  | { readonly kind: 'invalid-presentation'; readonly error: unknown; readonly dispose: () => Promise<void> }
  | { readonly kind: 'ready'; readonly presentation: UiExtensionPresentation; readonly dispose: () => Promise<void> };

function validateComponent(component: unknown): asserts component is ComponentType<ConversationModuleProps> {
  if (typeof component === 'function') return;
  const tag = typeof component === 'object' && component !== null && '$$typeof' in component ? component.$$typeof : undefined;
  if (tag !== Symbol.for('react.memo') && tag !== Symbol.for('react.forward_ref') && tag !== Symbol.for('react.lazy')) {
    throw new Error('Expected React component');
  }
}

function captureArray<T>(value: unknown, message: string, capture: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) throw new Error(message);
  const length = value.length;
  const result: T[] = [];
  for (let index = 0; index < length; index++) {
    const item: unknown = value[index];
    result.push(capture(item));
  }
  return result;
}

/** IDs are local to siblings. Action identity includes namespace and the entire module path. */
export function parseConversationModules(value: unknown): readonly ConversationModule[] {
  const ancestors = new Set<unknown>();
  function name(item: Record<string, unknown>, ids: Set<string>) {
    const id = nonempty(item.id), label = nonempty(item.label);
    if (!id.trim() || !label.trim()) throw new Error('Expected nonblank module or action name');
    if (ids.has(id)) throw new Error(`Duplicate module or action ID: ${id}`);
    ids.add(id);
    return { id, label };
  }
  function modules(value: unknown): readonly ConversationModule[] {
    const ids = new Set<string>();
    return captureArray(value, 'Expected module array', moduleValue => {
      if (ancestors.has(moduleValue)) throw new Error('Cyclic module tree');
      const module = behaviour(moduleValue);
      const named = name(module, ids);
      const component = module.component, actions = module.actions, children = module.children;
      validateComponent(component);
      const actionIds = new Set<string>();
      const capturedActions = actions === undefined ? undefined : captureArray(actions, 'Expected action array', value => {
        const action = behaviour(value), named = name(action, actionIds), run = action.run;
        if (typeof run !== 'function') throw new Error('Expected action function');
        return { ...named, run: (context: ConversationModuleProps) => run.call(action, context) };
      });
      ancestors.add(moduleValue);
      const capturedChildren = children === undefined ? undefined : modules(children);
      ancestors.delete(moduleValue);
      return { ...named, component, ...(capturedActions === undefined ? {} : { actions: capturedActions }),
        ...(capturedChildren === undefined ? {} : { children: capturedChildren }) };
    });
  }
  return modules(value);
}

function parseTranscript(value: unknown): UiExtensionPresentation['transcript'] {
  if (value === undefined) return undefined;
  const overrides = behaviour(value);
  for (let current: object | null = overrides; current !== null && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
    for (const key of Reflect.ownKeys(current)) {
      if (key === 'transcript') continue;
      if (current !== overrides && key === 'constructor') {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function' && descriptor.value.prototype === current) continue;
      }
      throw new Error(`Unknown override slot: ${String(key)}`);
    }
  }
  const transcript = overrides.transcript;
  if (transcript !== undefined) validateComponent(transcript);
  return transcript;
}

export function parseUiExtensionContributions(value: unknown): UiExtensionCapture {
  let contributions: Record<string, unknown>, dispose: () => Promise<void>;
  try {
    contributions = behaviour(value);
    const release = contributions.dispose;
    if (typeof release !== 'function') throw new Error('Expected extension disposal function');
    let completion: Promise<void> | undefined;
    dispose = () => completion ??= Promise.resolve().then(() => release.call(contributions));
  } catch (error) { return { kind: 'invalid-lifetime', error }; }
  try {
    const modules = contributions.modules, overrides = contributions.overrides;
    const presentation = { modules: parseConversationModules(modules), transcript: parseTranscript(overrides) };
    return { kind: 'ready', presentation, dispose };
  } catch (error) { return { kind: 'invalid-presentation', error, dispose }; }
}

export function validateConversationModules(value: unknown): asserts value is readonly ConversationModule[] {
  parseConversationModules(value);
}

export function validateUiExtensionContributions(value: unknown): asserts value is UiExtensionContributions {
  const result = parseUiExtensionContributions(value);
  if (result.kind !== 'ready') throw result.error;
}
