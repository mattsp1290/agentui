import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const directory = process.env.CLAUDE_CONFIG_DIR;
const args = process.argv.slice(2);
const model = args.find(arg => arg.startsWith('--model='))?.slice('--model='.length);
const resume = args.find(arg => arg.startsWith('--resume='))?.slice('--resume='.length);
const threadId = resume ?? '00000000-0000-4000-8000-000000000001';
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
    continue;
  }
  if (frame.type !== 'user') continue;
  const text = typeof frame.message.content === 'string' ? frame.message.content
    : frame.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
  appendFileSync(join(directory, 'calls.jsonl'), `${JSON.stringify({ args, text })}\n`);
  emit({ type: 'system', subtype: 'init', session_id: threadId, model: `claude-${model}-fixture`,
    apiKeySource: 'ANTHROPIC_API_KEY', tools: [], mcp_servers: [] });
  if (text === 'fail-before-admission' || (resume && (!existsSync(join(directory, 'native-thread')) ||
    readFileSync(join(directory, 'native-thread'), 'utf8') !== resume))) {
    emit({ type: 'assistant', session_id: threadId, parent_tool_use_id: null,
      error: 'authentication_failed', message: { id: 'message-1', model: `claude-${model}-fixture`, content: [{ type: 'text', text: process.env.ANTHROPIC_API_KEY }] } });
    continue;
  }
  if (!resume) writeFileSync(join(directory, 'native-thread'), threadId);
  const message = text => emit({ type: 'assistant', session_id: threadId, parent_tool_use_id: null,
    message: { id: 'message-1', model: `claude-${model}-fixture`, content: text ? [{ type: 'text', text }] : [] } });
  if (text === 'wait-without-output') { message(''); continue; }
  message(resume ? 'Resumed Claude reply' : 'First Claude reply');
  if (text === 'hold-after-output') {
    await new Promise(resolve => {
      const timer = setInterval(() => {
        if (!existsSync(join(directory, 'finish'))) return;
        clearInterval(timer);
        resolve();
      }, 10);
    });
  }
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: threadId });
}
