import type { ConversationScope, RunIdentity } from '@agentui/contracts';
import type { AgentCapabilities, RunAgentInput } from '@agentui/protocol';
import type { ExtensionEntryKind, ExtensionLifetime } from './extensions.js';

export type FrontendPlatform = Exclude<ExtensionEntryKind, 'server'>;
export type FrontendTool = NonNullable<RunAgentInput['tools']>[number];
export interface FrontendToolContribution<Input> {
  readonly definition: FrontendTool;
  decodeInput(value: unknown): Input;
  execute(input: Input, context: { readonly conversation: ConversationScope }): Promise<string>;
}
export interface FrontendToolContributions { add<Input>(tool: FrontendToolContribution<Input>): void }
export interface FrontendToolGeneration {
  readonly namespace: string;
  /** Captured diagnostic and durable correlation label; uniqueness is not enforced. */
  readonly generation: string;
  readonly platform: FrontendPlatform;
  retire(): Promise<void>;
}
export interface FrontendToolPin {
  readonly run: RunIdentity;
  readonly definitions: readonly FrontendTool[];
  invoke(name: string, args: unknown): Promise<FrontendToolOutcome>;
  release(): void;
}
export type FrontendToolOutcome =
  | { readonly kind: 'completed'; readonly output: string }
  | { readonly kind: 'refused'; readonly code: 'released' | 'unknown-tool' | 'invalid-arguments' | 'decode-failed' };
export type Accepted<A> = A extends (value: unknown) => asserts value is infer L ? L : never;
export interface FrontendToolActivation<L> {
  readonly generation: FrontendToolGeneration;
  readonly contributions: L;
}
export interface FrontendToolGenerationOptions<A extends (value: unknown) => void> {
  readonly namespace: string;
  readonly generation: string;
  readonly platform: FrontendPlatform;
  activate(tools: FrontendToolContributions): unknown;
  readonly accept: A & (Accepted<A> extends ExtensionLifetime ? unknown : never);
}
export interface FrontendToolPinOptions {
  readonly generations: readonly FrontendToolGeneration[];
  readonly platform: FrontendPlatform;
  readonly run: RunIdentity;
  readonly capabilities: AgentCapabilities | undefined;
}
