import type { Transcript } from '@agentui/contracts/conversation';

export function conversationResponding(agent: string, transcript: Transcript): boolean {
  const run = transcript.currentRun;
  return (agent === 'codex' || agent === 'pi') && (Boolean(run && run.kind !== 'ended') ||
    (!run && transcript.messages.some(message => message.role === 'assistant' && !message.complete)));
}
