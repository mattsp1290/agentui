import type { ConversationScope, RunIdentity } from './index.js';
import { copyJson, parseCommand, parseRunIdentity, sameScope } from './durable.js';
import { identifier, record } from './decode.js';

export type FrontendDefinition = ReturnType<typeof parseFrontendDefinition>;
export interface FrontendOffer {
  readonly platform: 'desktop';
  readonly tools: readonly { readonly definition: FrontendDefinition; readonly activationId: string }[];
}
export interface OfferedCommand {
  readonly version: 2;
  readonly scope: ConversationScope;
  readonly clientCommandId: string;
  readonly body: { readonly kind: 'send'; readonly text: string; readonly frontend: FrontendOffer };
}
export type FrontendEligibility = 'unsupported' | 'ag-ui-capture-and-bind';
export interface FrontendBindingRequest {
  readonly scope: ConversationScope;
  readonly id: string;
  readonly action: 'recover' | 'unavailable';
}
export type FrontendBinding =
  | { readonly kind: 'pending'; readonly id: string }
  | { readonly kind: 'bound'; readonly command: OfferedCommand; readonly hostOperationId: string; readonly run: RunIdentity; readonly threadId: string }
  | { readonly kind: 'unavailable'; readonly id: string; readonly reason: 'closures-unavailable' | 'not-dispatched' | 'provider-rejected' };

export function parseFrontendOffer(value: unknown): FrontendOffer {
  const input = record(copyJson(value), ['platform', 'tools']);
  if (input.platform !== 'desktop' || !Array.isArray(input.tools) || input.tools.length < 1 || input.tools.length > 128) throw new Error('Invalid frontend offer');
  const names = new Set<string>();
  const tools = input.tools.map(value => {
    const item = record(value, ['definition', 'activationId']), definition = parseFrontendDefinition(item.definition);
    if (names.has(definition.name)) throw new Error('Invalid frontend definition');
    names.add(definition.name);
    return { definition, activationId: identifier(item.activationId) };
  });
  return { platform: 'desktop', tools };
}
export function parseFrontendBinding(value: unknown): FrontendBinding {
  const input = record(value);
  if (input.kind === 'pending') { record(input, ['kind', 'id']); return { kind: 'pending', id: identifier(input.id) }; }
  if (input.kind === 'unavailable') {
    record(input, ['kind', 'id', 'reason']);
    if (input.reason !== 'closures-unavailable' && input.reason !== 'not-dispatched' && input.reason !== 'provider-rejected') throw new Error('Invalid frontend unavailability');
    return { kind: 'unavailable', id: identifier(input.id), reason: input.reason };
  }
  record(input, ['kind', 'command', 'hostOperationId', 'run', 'threadId']);
  const command = parseCommand(input.command), run = parseRunIdentity(input.run);
  if (input.kind !== 'bound' || command.version !== 2 || !sameScope(command.scope, run.conversation)) throw new Error('Invalid frontend binding');
  return { kind: 'bound', command, run, hostOperationId: identifier(input.hostOperationId), threadId: identifier(input.threadId) };
}

function parseFrontendDefinition(value: unknown) {
  const raw = record(value);
  record(raw, ['name', 'description', ...(['parameters', 'metadata'].filter(key => Object.hasOwn(raw, key)))]);
  const name = identifier(raw.name, 64);
  if (!/^[a-z][a-z0-9-]{0,31}__[A-Za-z][A-Za-z0-9_-]*$/u.test(name) || typeof raw.description !== 'string') throw new Error('Invalid frontend definition');
  const parameters = Object.hasOwn(raw, 'parameters') ? record(raw.parameters) : undefined;
  const metadata = Object.hasOwn(raw, 'metadata') ? record(raw.metadata) : undefined;
  if (metadata && Object.hasOwn(metadata, 'ag-ui')) throw new Error('Reserved tool metadata');
  return { name, description: raw.description, ...(parameters === undefined ? {} : { parameters }),
    ...(metadata === undefined ? {} : { metadata }) };
}
