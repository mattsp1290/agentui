import { createHash } from 'node:crypto';
import { canonicalJson } from '@agentui/contracts';
import { CLAUDE_SDK_CHAT_LABELS, CLAUDE_SDK_RUNTIMES, CODEX_RUNTIME, CODEX_SDK_CHAT_LABEL, CODEX_SDK_RUNTIME, PI_CHAT_LABEL, PI_RUNTIME, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
import type { AgentDescriptor } from '@agentui/contracts/service';
import type { Installation } from '@agentui/host';

export interface InstalledAgent {
  readonly name?: string;
  readonly installation: Installation;
  readonly availability: AgentDescriptor['availability'];
}
const nativeAgents = [
  { runtime: CODEX_RUNTIME, label: 'Codex', commands: ['send', 'cancel', 'approve'] },
  { runtime: CODEX_SDK_RUNTIME, label: CODEX_SDK_CHAT_LABEL, commands: ['send', 'cancel'] },
  { runtime: CLAUDE_SDK_RUNTIMES.opus, label: CLAUDE_SDK_CHAT_LABELS.opus, commands: ['send', 'cancel'] },
  { runtime: CLAUDE_SDK_RUNTIMES.sonnet, label: CLAUDE_SDK_CHAT_LABELS.sonnet, commands: ['send', 'cancel'] },
  { runtime: PI_RUNTIME, label: PI_CHAT_LABEL, commands: ['send', 'cancel'] },
  { runtime: RECORDED_RUNTIME, label: 'Recorded assistant', commands: ['send', 'approve'] },
] satisfies readonly Pick<AgentDescriptor, 'runtime' | 'label' | 'commands'>[];

export function describeAgent(installation: Installation, availability: AgentDescriptor['availability']): AgentDescriptor {
  const { binding } = installation;
  const runtime = { engine: binding.engine, version: binding.nativeVersion, format: binding.nativeFormat };
  const known = nativeAgents.find(agent => canonicalJson(agent.runtime) === canonicalJson(runtime));
  return { id: `agent-v1-${createHash('sha256').update(canonicalJson(installation)).digest('hex')}`, runtime,
    label: known?.label ?? 'Unavailable agent', commands: known?.commands ?? [],
    availability: known ? availability : { kind: 'unavailable', reason: 'This agent runtime is unsupported.' } };
}
