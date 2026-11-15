import { canonicalJson } from '@agentui/contracts';
import type { ConversationScope } from '@agentui/contracts';
import type { TranscriptEvent } from '@agentui/contracts/conversation';
import { createGenAiObserver, instrumentationScope } from '@agentui/host/observability';
import type { AgentHandle } from '@agentui/host/observability';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import type { TracerProvider } from '@opentelemetry/api';
import type { NativeProvider } from './agent-config.js';
import { OBSERVABILITY_BOUNDS } from './observability-bounds.js';

const PROVIDERS: Readonly<Record<NativeProvider['kind'], string>> = {
  codex: 'openai', 'codex-sdk': 'openai', 'claude-sdk': 'anthropic', pi: 'opencode-go',
};

export function createAgentObservations(provider: TracerProvider) {
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
        handle.finish(event.outcome === 'completed' ? { kind: 'success' }
          : event.outcome === 'failed' ? { kind: 'error', category: 'unknown-error' } : { kind: 'outcome-unknown' });
      }
    },
    close(): void { observer.close(); active.clear(); },
  };
}
