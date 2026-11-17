import type { ConversationScope, RunIdentity } from './index.js';
import { parseCommand, parseRunIdentity, sameScope } from './durable.js';
import type { OfferedCommand } from './durable.js';
import { identifier, record } from './decode.js';

export type FrontendEligibility = 'unsupported' | 'ag-ui-capture-and-bind';
export interface FrontendBindingRequest {
  readonly scope: ConversationScope;
  readonly id: string;
  readonly action: 'recover' | 'unavailable';
}
export type FrontendBinding =
  /** No confirmed binding yet, including a command not admitted by the host. Retain and retry the exact saved command ID and body. */
  | { readonly kind: 'pending'; readonly id: string }
  | { readonly kind: 'bound'; readonly command: OfferedCommand; readonly hostOperationId: string; readonly run: RunIdentity; readonly threadId: string }
  | { readonly kind: 'unavailable'; readonly id: string; readonly reason: 'closures-unavailable' | 'not-dispatched' | 'provider-rejected' };

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
