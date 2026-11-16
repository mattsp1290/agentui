import type { ConversationScope, RunIdentity } from '@agentui/contracts';
import type { AgentCapabilities, RunAgentInput } from '@agentui/protocol';
import type { FrontendPlatform } from './extensions.js';

export type { FrontendPlatform } from './extensions.js';
export type FrontendTool = NonNullable<RunAgentInput['tools']>[number];
export interface FrontendToolContribution<Input> {
  readonly definition: FrontendTool;
  /** Decodes synchronously after schema validation. */
  decodeInput(value: unknown): Input;
  execute(input: Input, context: { readonly conversation: ConversationScope }): Promise<string>;
}
export interface FrontendToolContributions { add<Input>(tool: FrontendToolContribution<Input>): void }
export interface UiExtensionContext {
  readonly namespace: string;
  readonly frontendTools: FrontendToolContributions;
}
export interface FrontendToolGeneration {
  readonly namespace: string;
  readonly activationId: string;
  /** Captured diagnostic and owner correlation label; uniqueness is not enforced. */
  readonly generation: string;
  readonly platform: FrontendPlatform;
  /**
   * Remove this generation from the active list before awaiting retirement and observe the promise.
   * Disposal waits for every pin and call to drain. Handlers must not await retirement of a
   * generation held by their own run's pin, and disposers must not await their own retirement.
   */
  retire(): Promise<void>;
}
export interface FrontendToolPin {
  readonly run: RunIdentity;
  readonly definitions: readonly Readonly<FrontendTool>[];
  readonly bindings: readonly Readonly<{ name: string; activationId: string }>[];
  invoke(name: string, args: unknown, activationId: string): Promise<FrontendToolOutcome>;
  /** Release on every run outcome, including cancellation and failure. In-flight calls still drain. */
  release(): void;
}
export type FrontendToolOutcome =
  | { readonly kind: 'completed'; readonly output: string }
  | { readonly kind: 'refused'; readonly code: 'released' | 'unknown-tool' | 'activation-mismatch' | 'invalid-arguments' | 'decode-failed' };
export interface FrontendToolActivation<C> {
  readonly generation: FrontendToolGeneration;
  readonly contributions: C;
}
export interface FrontendToolGenerationOptions<C> {
  readonly namespace: string;
  readonly generation: string;
  readonly platform: FrontendPlatform;
  activate(context: UiExtensionContext): unknown;
  /** Captures presentation. The core acquires raw activation disposal before this runs. */
  capture(value: unknown): C | Promise<C>;
  /** Called once on creation failure before disposal starts. Creation awaits both observer and disposal completion. */
  onFailure?(error: unknown): void | Promise<void>;
}
export interface FrontendToolPinOptions {
  readonly generations: readonly FrontendToolGeneration[];
  readonly platform: FrontendPlatform;
  readonly run: RunIdentity;
  readonly capabilities: AgentCapabilities | undefined;
}
