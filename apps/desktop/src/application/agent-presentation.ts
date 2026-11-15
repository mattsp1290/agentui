import { CLAUDE_SDK_CHAT_LABELS, CLAUDE_SDK_RUNTIMES, CODEX_SDK_CHAT_LABEL, PI_CHAT_LABEL } from '@agentui/contracts/compatibility';
import type { NativeRuntimeIdentity } from '@agentui/contracts/compatibility';

const savedConversations = 'The local host manages your saved conversations and approvals.';
export const AGENT_PRESENTATION = {
  codex: {
    assistant: 'Codex', placeholder: 'Write to Codex…', footer: 'Local Codex · Approvals required for changes',
    live: true, hostLabel: 'Codex', buildLabel: 'Local Codex host', settings: savedConversations,
  },
  'codex-sdk': {
    assistant: 'Codex', placeholder: 'Write to Codex…', footer: `${CODEX_SDK_CHAT_LABEL} · Read-only · No interactive approvals`,
    live: true, hostLabel: CODEX_SDK_CHAT_LABEL, buildLabel: CODEX_SDK_CHAT_LABEL,
    settings: 'The local host saves your conversations. Codex uses your ChatGPT subscription. Interactive approvals are unavailable in this mode.',
  },
  'claude-sdk-opus': {
    assistant: 'Claude', placeholder: 'Write to Claude…', footer: `${CLAUDE_SDK_CHAT_LABELS.opus} · Chat only · No tools`,
    live: true, hostLabel: CLAUDE_SDK_CHAT_LABELS.opus, buildLabel: CLAUDE_SDK_CHAT_LABELS.opus,
    settings: 'The local host saves your conversations. Claude Opus uses the API key configured on your host and provides text chat without tools.',
  },
  'claude-sdk-sonnet': {
    assistant: 'Claude', placeholder: 'Write to Claude…', footer: `${CLAUDE_SDK_CHAT_LABELS.sonnet} · Chat only · No tools`,
    live: true, hostLabel: CLAUDE_SDK_CHAT_LABELS.sonnet, buildLabel: CLAUDE_SDK_CHAT_LABELS.sonnet,
    settings: 'The local host saves your conversations. Claude Sonnet uses the API key configured on your host and provides text chat without tools.',
  },
  pi: {
    assistant: 'Pi', placeholder: 'Write to Pi…', footer: `${PI_CHAT_LABEL} · Chat only · No tools`,
    live: true, hostLabel: PI_CHAT_LABEL, buildLabel: PI_CHAT_LABEL,
    settings: 'The local host saves your conversations. Pi provides text chat without tools.',
  },
  recorded: {
    assistant: 'Recorded assistant', placeholder: 'Write to the recorded assistant…', footer: 'Recorded playback · No live model',
    live: false, hostLabel: 'Browser development · Recorded playback', buildLabel: 'Browser development · Recorded host', settings: savedConversations,
  },
  local: {
    assistant: 'Assistant', placeholder: 'Write a message…', footer: 'Local agent',
    live: false, hostLabel: 'Local agent', buildLabel: 'Local host', settings: savedConversations,
  },
};
export type Agent = keyof typeof AGENT_PRESENTATION;

export function agentPresentation(runtime: NativeRuntimeIdentity | null) {
  let agent: Agent;
  switch (runtime?.engine) {
    case 'codex': agent = 'codex'; break;
    case 'codex-sdk': agent = 'codex-sdk'; break;
    case 'claude-sdk':
      agent = runtime.format === CLAUDE_SDK_RUNTIMES.opus.format ? 'claude-sdk-opus'
        : runtime.format === CLAUDE_SDK_RUNTIMES.sonnet.format ? 'claude-sdk-sonnet' : 'local';
      break;
    case 'pi': agent = 'pi'; break;
    case 'agentui-recorded': agent = 'recorded'; break;
    default: agent = 'local';
  }
  const presentation = AGENT_PRESENTATION[agent];
  return { agent, presentation: runtime?.engine === 'codex'
    ? { ...presentation, hostLabel: `Codex · ${runtime.version}` } : presentation };
}
