import { canonicalJson } from '@agentui/contracts';
import type { ConversationScope } from '@agentui/contracts';
import type { TranscriptEvent } from '@agentui/contracts/conversation';
import { createGenAiObserver, instrumentationScope } from '@agentui/host/observability';
import type { AgentHandle } from '@agentui/host/observability';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import type { TracerProvider } from '@opentelemetry/api';
import type { NativeProvider } from './agent-config.js';

type RunEvent = Extract<TranscriptEvent, { readonly kind: 'run-started' | 'run-ended' }>;
const PROVIDERS: Readonly<Record<NativeProvider['kind'], string>> = {
  codex: 'openai', 'codex-sdk': 'openai', 'claude-sdk': 'anthropic', pi: 'opencode-go',
};

export function createAgentObservations(provider: TracerProvider) {
  const observer = createGenAiObserver({
    tracer: provider.getTracer(instrumentationScope.name, instrumentationScope.version),
    contentPolicy: { kind: 'none' }, allowedToolNames: [], bounds: { maxActiveSpans: 128 },
  });
  const active = new Map<string, AgentHandle>();
  return {
    record(source: NativeProvider['kind'], scope: ConversationScope, event: RunEvent): void {
      const key = canonicalJson([source, scope.hostId, scope.conversationId, event.runId]);
      if (event.kind === 'run-started') {
        if (active.has(key)) return;
        const result = observer.start({ kind: 'agent', provider: PROVIDERS[source], name: source }, ROOT_CONTEXT);
        if (result.kind === 'ok') active.set(key, result.value);
        return;
      }
      const handle = active.get(key);
      if (!handle) return;
      active.delete(key);
      handle.finish(event.outcome === 'completed' ? { kind: 'success' }
        : event.outcome === 'failed' ? { kind: 'error', category: 'unknown-error' } : { kind: 'outcome-unknown' });
    },
    close(): void { observer.close(); active.clear(); },
  };
}
