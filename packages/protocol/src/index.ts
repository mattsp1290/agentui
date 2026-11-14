export type { AgentCapabilities, Event, RunAgentInput } from '@ag-ui/core';

export type BackendAvailability =
  | { readonly kind: 'undeclared' }
  | { readonly kind: 'supported' }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string };
