const { CodexAgentAdapter } = require('@ag-ui/codex-sdk');
const assert = require('node:assert/strict');

(async () => {
  const agent = new CodexAgentAdapter({
    codexOptions: { codexPathOverride: process.env.AGUI49_CODEX_FIXTURE },
  });
  agent.addMessage({ id: 'user-1', role: 'user', content: 'My name is Alice' });
  await agent.runAgent();
  assert(agent.messages.some(message => message.role === 'assistant' && message.content.includes('Alice')));
  agent.addMessage({ id: 'user-2', role: 'user', content: 'What is my name?' });
  await agent.runAgent();
  const replies = agent.messages.filter(message => message.role === 'assistant');
  assert.equal(replies.length, 2);
  assert(replies.at(-1).content.includes('Alice'), 'Continuation retains the name');
  console.log('PASS exact-fork packed Codex SDK fixture first turn and continuation');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
