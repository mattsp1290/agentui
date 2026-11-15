import type { ComponentType } from 'react';
import type { ConversationDocument, ConversationScope, SubmitResult } from '@agentui/contracts';
import type { Transcript } from '@agentui/contracts/conversation';
import { nonempty } from '@agentui/contracts/decode';
import type { FrontendToolContributions } from './tool-contracts.js';
export type { FrontendToolContribution, FrontendToolContributions } from './tool-contracts.js';
import { behaviour, validateExtensionLifetime } from './extensions.js';
import type { EXTENSION_SDK_VERSION, ExtensionLifetime } from './extensions.js';

export interface ConversationCommands {
  send(text: string): Promise<SubmitResult>;
  approve(pendingId: string, choiceId: string): Promise<SubmitResult>;
  cancel(runId: string): Promise<SubmitResult>;
}
export interface ConversationModuleProps {
  readonly conversation: ConversationScope;
  readonly activity: ConversationDocument<Transcript>;
  readonly commands: ConversationCommands;
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

export interface UiExtensionContext {
  readonly namespace: string;
  readonly frontendTools: FrontendToolContributions;
}
export interface UiExtensionContributions extends ExtensionLifetime {
  readonly modules: readonly ConversationModule[];
}
export interface UiExtensionEntry<K extends 'desktop' | 'ios'> {
  readonly kind: K;
  readonly sdkVersion: typeof EXTENSION_SDK_VERSION;
  activate(context: UiExtensionContext): UiExtensionContributions | Promise<UiExtensionContributions>;
}

/** IDs are local to siblings. Action identity includes namespace and the entire module path. */
export function validateConversationModules(value: unknown): asserts value is readonly ConversationModule[] {
  const ancestors = new Set<unknown>();
  function named(value: unknown, ids: Set<string>): Record<string, unknown> {
    const item = behaviour(value);
    const id = nonempty(item.id);
    if (!id.trim() || !nonempty(item.label).trim()) throw new Error('Expected nonblank module or action name');
    if (ids.has(id)) throw new Error(`Duplicate module or action ID: ${id}`);
    ids.add(id);
    return item;
  }
  function modules(value: unknown): void {
    if (!Array.isArray(value)) throw new Error('Expected module array');
    const ids = new Set<string>();
    for (const moduleValue of value) {
      if (ancestors.has(moduleValue)) throw new Error('Cyclic module tree');
      const module = named(moduleValue, ids);
      const component = module.component;
      const wrapper = typeof component === 'object' && component !== null && '$$typeof' in component &&
        typeof component.$$typeof === 'symbol' && [Symbol.for('react.memo'), Symbol.for('react.forward_ref'), Symbol.for('react.lazy')].includes(component.$$typeof);
      if (typeof component !== 'function' && !wrapper) throw new Error('Expected module component');
      if (module.actions !== undefined) {
        if (!Array.isArray(module.actions)) throw new Error('Expected action array');
        const actions = new Set<string>();
        for (const value of module.actions) {
          if (typeof named(value, actions).run !== 'function') throw new Error('Expected action function');
        }
      }
      if (module.children !== undefined) {
        ancestors.add(moduleValue);
        modules(module.children);
        ancestors.delete(moduleValue);
      }
    }
  }
  modules(value);
}

export function validateUiExtensionContributions(value: unknown): asserts value is UiExtensionContributions {
  validateExtensionLifetime(value);
  validateConversationModules(behaviour(value).modules);
}
