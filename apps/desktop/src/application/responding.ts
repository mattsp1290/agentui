import type { Transcript } from '@agentui/contracts/conversation';
import { AGENT_PRESENTATION } from './agent-presentation.js';

const presentations = new Map(Object.entries(AGENT_PRESENTATION));

export function conversationResponding(agent: string, transcript: Transcript): boolean {
  const run = transcript.currentRun;
  return presentations.get(agent)?.live === true && (Boolean(run && run.kind !== 'ended') ||
    (!run && transcript.messages.some(message => message.role === 'assistant' && !message.complete)));
}
