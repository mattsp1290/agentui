import type { ComponentType, ReactNode } from 'react';
import type { ConversationDocument, ConversationPermissions, ConversationScope, PermissionScope, SubmitResult } from '@agentui/contracts';
import type { OutputId, OutputListing, OutputRead } from '@agentui/contracts/output';
import type { Transcript } from '@agentui/contracts/conversation';
import { nonempty } from '@agentui/contracts/decode';
import type { UiExtensionContext } from './tool-contracts.js';
export type { FrontendToolContribution, FrontendToolContributions, UiExtensionContext } from './tool-contracts.js';
import { behaviour } from './extensions.js';
import type { EXTENSION_SDK_VERSION, ExtensionLifetime, FrontendPlatform } from './extensions.js';

export type CommandAvailability = { readonly kind: 'available' } | { readonly kind: 'disabled'; readonly reason: string };
export interface ConversationCommand<Args extends unknown[]> {
  availability(...args: Args): CommandAvailability;
  run(...args: Args): Promise<SubmitResult>;
}
export interface ConversationCommands {
  readonly send: ConversationCommand<[text: string]>;
  readonly approve: ConversationCommand<[pendingId: string, choiceId: string]>;
  readonly revokePermission: ConversationCommand<[permissionId: string, scope: PermissionScope]>;
  readonly cancel: ConversationCommand<[runId: string]>;
}
export interface ConversationOutputReader {
  list(): Promise<OutputListing>;
  read(outputId: OutputId): Promise<OutputRead>;
}
export interface ConversationModuleProps {
  readonly conversation: ConversationScope;
  readonly activity: ConversationDocument<Transcript>;
  readonly outputs: ConversationOutputReader;
  readonly commands: ConversationCommands;
  readonly permissions: { read(): Promise<ConversationPermissions> };
}
export interface ConversationActivityProps extends ConversationModuleProps {
  readonly updates: 'connected' | 'reconnecting' | 'paused';
}
export interface ModuleAction {
  readonly id: string;
  readonly label: string;
  availability(context: ConversationModuleProps): CommandAvailability;
  run(context: ConversationModuleProps): Promise<SubmitResult>;
}
export interface ConversationModule {
  readonly id: string;
  readonly label: string;
  readonly component: ComponentType<ConversationModuleProps>;
  readonly children?: readonly ConversationModule[];
  readonly actions?: readonly ModuleAction[];
}

export interface ConversationContentLayoutProps {
  readonly transcript: ReactNode;
  readonly modules: ReactNode;
}

export interface UiExtensionContributions extends ExtensionLifetime {
  readonly modules: readonly ConversationModule[];
  readonly contentLayout?: ComponentType<ConversationContentLayoutProps>;
  readonly overrides?: {
    readonly transcript?: ComponentType<ConversationModuleProps>;
    readonly activity?: ComponentType<ConversationActivityProps>;
  };
}
export interface UiExtensionEntry<K extends FrontendPlatform> {
  readonly kind: K;
  readonly sdkVersion: typeof EXTENSION_SDK_VERSION;
  activate(context: UiExtensionContext): UiExtensionContributions | Promise<UiExtensionContributions>;
}

export interface UiExtensionPresentation {
  readonly modules: readonly ConversationModule[];
  readonly transcript: ComponentType<ConversationModuleProps> | undefined;
  readonly activity: ComponentType<ConversationActivityProps> | undefined;
  readonly contentLayout: ComponentType<ConversationContentLayoutProps> | undefined;
}
export type UiExtensionCapture =
  | { readonly kind: 'invalid-lifetime'; readonly error: unknown }
  | { readonly kind: 'invalid-presentation'; readonly error: unknown; readonly dispose: () => Promise<void> }
  | { readonly kind: 'ready'; readonly presentation: UiExtensionPresentation; readonly dispose: () => Promise<void> };

function validateComponent<Props>(component: unknown): asserts component is ComponentType<Props> {
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
      validateComponent<ConversationModuleProps>(component);
      const actionIds = new Set<string>();
      const capturedActions = actions === undefined ? undefined : captureArray(actions, 'Expected action array', value => {
        const action = behaviour(value), named = name(action, actionIds), run = action.run, availability = action.availability;
        if (typeof run !== 'function' || typeof availability !== 'function') throw new Error('Expected action functions');
        return { ...named, run: (context: ConversationModuleProps) => run.call(action, context),
          availability(context: ConversationModuleProps): CommandAvailability {
            const value: unknown = availability.call(action, context);
            if (value instanceof Promise) void value.catch(() => {});
            if (typeof value === 'object' && value !== null && 'kind' in value && !('then' in value)) {
              const kind = value.kind;
              if (kind === 'available') return { kind: 'available' };
              if (kind === 'disabled' && 'reason' in value) {
                const reason = value.reason;
                if (typeof reason === 'string' && reason.trim()) return { kind: 'disabled', reason };
              }
            }
            throw new Error('Expected synchronous command availability');
          } };
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

function parseOverrides(value: unknown): Pick<UiExtensionPresentation, 'transcript' | 'activity'> {
  if (value === undefined) return { transcript: undefined, activity: undefined };
  const overrides = behaviour(value);
  for (let current: object | null = overrides; current !== null && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
    for (const key of Reflect.ownKeys(current)) {
      if (key === 'transcript' || key === 'activity') continue;
      if (current !== overrides && key === 'constructor') {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function' && descriptor.value.prototype === current) continue;
      }
      throw new Error(`Unknown override slot: ${String(key)}`);
    }
  }
  const transcript = overrides.transcript, activity = overrides.activity;
  if (transcript !== undefined) validateComponent<ConversationModuleProps>(transcript);
  if (activity !== undefined) validateComponent<ConversationActivityProps>(activity);
  return { transcript, activity };
}

/** Captures presentation without acquiring or inspecting disposal. */
export function parseUiExtensionPresentation(value: unknown): UiExtensionPresentation {
  const contributions = behaviour(value);
  const modules = contributions.modules, overrides = contributions.overrides, contentLayout = contributions.contentLayout;
  if (contentLayout !== undefined) validateComponent<ConversationContentLayoutProps>(contentLayout);
  return { modules: parseConversationModules(modules), ...parseOverrides(overrides), contentLayout };
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
    const presentation = parseUiExtensionPresentation(contributions);
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
