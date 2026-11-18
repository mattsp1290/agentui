import type { ComponentType, ReactNode } from 'react';
import type { ConversationDocument, ConversationPermissions, ConversationScope, Json, PermissionScope, SubmitResult } from '@agentui/contracts';
import type { AgentDescriptor, ExtensionCallValue } from '@agentui/contracts/service';
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
export interface ConversationActivityProps extends ConversationModuleProps {
  readonly updates: 'connected' | 'reconnecting' | 'paused';
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

export interface ConversationContentLayoutProps {
  readonly transcript: ReactNode;
  readonly modules: ReactNode;
}

export interface WorkspaceAgent {
  readonly id: string;
  readonly label: string;
  readonly installationId: string;
  readonly providerAgentId: string | null;
  readonly availability: AgentDescriptor['availability'];
}
export interface WorkspaceConversation {
  readonly scope: ConversationScope;
  readonly preview: string | null;
  readonly provider: { readonly installationId: string; readonly providerAgentId: string };
}
/** Props of a workspace view. Every list is limited to the extension's own namespace. */
export interface WorkspaceViewProps {
  readonly namespace: string;
  readonly installations: readonly { readonly installationId: string; readonly status: 'available' | 'unavailable' }[];
  readonly agents: readonly WorkspaceAgent[];
  readonly conversations: {
    /** Loaded pages in catalog order. The selected conversation is always included, after the pages when it is not on one yet. */
    readonly entries: readonly WorkspaceConversation[];
    /** The last page length equalled the page limit, so more may exist. Order is catalog order, not recency. */
    readonly hasMore: boolean;
    readonly loading: boolean;
    more(): void;
  };
  /** The application's single active conversation when it belongs to this namespace. */
  readonly selected: ConversationScope | null;
  /** The host-rendered conversation, composer and approvals for `selected`; `null` when nothing is selected. Render it once. */
  readonly conversation: ReactNode;
  /**
   * Opens a conversation from this namespace's list. It becomes the application's active conversation.
   * Rejects only for a scope outside this namespace. Otherwise it resolves once the attempt ends, also when the attempt
   * did not open the conversation, and `selected` stays unchanged. A host refusal is shown in the host status strip. While
   * the application is busy with another operation the attempt is ignored and nothing is shown, so disable or retry the
   * control yourself. Watch `selected`, not the promise, to learn what opened.
   */
  open(scope: ConversationScope): Promise<void>;
  /**
   * Creates a conversation with one of this namespace's agents and makes it the active conversation.
   * Rejects only for an agent outside this namespace. Like `open`, it resolves when the attempt ends, also without a new
   * conversation (busy, pending creation to recover, agent unavailable, host refusal); `selected` changes only on success.
   * As with `open`, a busy application ignores the attempt without a notice; the other reasons appear in the status strip.
   */
  create(agentId: string): Promise<void>;
  /** Calls one of this extension's server operations. It never rejects: transport failures resolve as `unavailable`. */
  call(installationId: string, operation: string, input: Json): Promise<ExtensionCallValue>;
  /** Re-reads host metadata and this namespace's conversation list. */
  refresh(): Promise<void>;
}
export interface WorkspaceContribution {
  /** 1–40 characters, shown in the Extensions list. */
  readonly label: string;
  readonly component: ComponentType<WorkspaceViewProps>;
  /** A transcript used only inside this workspace. */
  readonly transcript?: ComponentType<ConversationModuleProps>;
}
export interface UiExtensionContributions extends ExtensionLifetime {
  readonly modules: readonly ConversationModule[];
  readonly workspace?: WorkspaceContribution;
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
  readonly workspace: WorkspaceContribution | undefined;
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

function parseWorkspace(value: unknown): WorkspaceContribution | undefined {
  if (value === undefined) return undefined;
  const workspace = behaviour(value);
  for (const key of Reflect.ownKeys(workspace)) {
    if (key !== 'label' && key !== 'component' && key !== 'transcript') throw new Error(`Unknown workspace slot: ${String(key)}`);
  }
  const label = workspace.label, component = workspace.component, transcript = workspace.transcript;
  if (typeof label !== 'string' || !label.trim() || label.length > 40) throw new Error('Expected a workspace label of 1 to 40 characters');
  validateComponent<WorkspaceViewProps>(component);
  if (transcript !== undefined) validateComponent<ConversationModuleProps>(transcript);
  return { label, component, ...(transcript === undefined ? {} : { transcript }) };
}

/** Captures presentation without acquiring or inspecting disposal. */
export function parseUiExtensionPresentation(value: unknown): UiExtensionPresentation {
  const contributions = behaviour(value);
  const modules = contributions.modules, overrides = contributions.overrides, contentLayout = contributions.contentLayout;
  if (contentLayout !== undefined) validateComponent<ConversationContentLayoutProps>(contentLayout);
  return { modules: parseConversationModules(modules), ...parseOverrides(overrides), contentLayout, workspace: parseWorkspace(contributions.workspace) };
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
