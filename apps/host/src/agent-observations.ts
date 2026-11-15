import { canonicalJson } from '@agentui/contracts';
import type { ConversationScope } from '@agentui/contracts';
import type { RunOutcome, TranscriptEvent } from '@agentui/contracts/conversation';
import { createGenAiObserver, instrumentationScope } from '@agentui/host/observability';
import type { AgentHandle, TerminalOutcome } from '@agentui/host/observability';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import type { TracerProvider } from '@opentelemetry/api';
import type { NativeProvider } from './agent-config.js';
import { OBSERVABILITY_BOUNDS } from './observability-bounds.js';

const PROVIDERS: Readonly<Record<NativeProvider['kind'], string>> = {
  codex: 'openai', 'codex-sdk': 'openai', 'claude-sdk': 'anthropic', pi: 'opencode-go',
};

const OUTCOMES: Readonly<Record<RunOutcome, TerminalOutcome>> = {
  completed: { kind: 'success' },
  failed: { kind: 'error', category: 'unknown-error' },
  interrupted: { kind: 'outcome-unknown' },
  'connection-lost': { kind: 'outcome-unknown' },
};

export interface AgentObservations {
  recordOutput(source: NativeProvider['kind'], scope: ConversationScope, events: readonly TranscriptEvent[]): void;
  close(): void;
}

export function createAgentObservations(provider: TracerProvider): AgentObservations {
  const observer = createGenAiObserver({
    tracer: provider.getTracer(instrumentationScope.name, instrumentationScope.version),
    contentPolicy: { kind: 'none' }, allowedToolNames: [], bounds: { maxActiveSpans: OBSERVABILITY_BOUNDS.maxActiveSpans },
  });
  const active = new Map<string, AgentHandle>();
  return {
    recordOutput(source: NativeProvider['kind'], scope: ConversationScope, events: readonly TranscriptEvent[]): void {
      for (const event of events) {
        if (event.kind !== 'run-started' && event.kind !== 'run-ended') continue;
        const key = canonicalJson([source, scope.hostId, scope.conversationId, event.runId]);
        if (event.kind === 'run-started') {
          if (active.has(key)) continue;
          const result = observer.start({ kind: 'agent', provider: PROVIDERS[source], name: source }, ROOT_CONTEXT);
          if (result.kind === 'ok') active.set(key, result.value);
          continue;
        }
        const handle = active.get(key);
        if (!handle) continue;
        active.delete(key);
        handle.finish(OUTCOMES[event.outcome]);
      }
    },
    close(): void { observer.close(); active.clear(); },
  };
}
