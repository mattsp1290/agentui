import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.env.CODEX_HOME;
const args = process.argv.slice(2);
if (args[0] === '--version') {
  const version = existsSync(join(directory, 'wrong-version')) ? '0.0.0' : '0.169.0';
  process.stdout.write(`codex-cli ${version}\n`);
  process.exit(0);
}
if (args[0] === 'login') {
  if (existsSync(join(directory, 'signed-out'))) process.exit(1);
  process.stderr.write('Logged in using ChatGPT\n');
  process.exit(0);
}
if (args[0] === 'mcp') {
  process.stdout.write('[]\n');
  process.exit(0);
}
let text = '';
for await (const chunk of process.stdin) text += chunk;
const resume = args.indexOf('resume');
const threadId = resume === -1 ? '00000000-0000-4000-8000-000000000001' : args[resume + 1];
appendFileSync(join(directory, 'calls.jsonl'), `${JSON.stringify({ args, text })}\n`);
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
if (text === 'fail-before-admission' || threadId === 'missing-thread') {
  emit({ type: 'error', message: 'Controlled failure before turn start' });
  process.exit(1);
}
if (resume === -1) writeFileSync(join(directory, 'native-thread'), threadId);
if (resume !== -1 && (!existsSync(join(directory, 'native-thread')) || readFileSync(join(directory, 'native-thread'), 'utf8') !== threadId)) {
  emit({ type: 'error', message: 'Missing native thread' });
  process.exit(1);
}
emit({ type: 'thread.started', thread_id: threadId });
emit({ type: 'turn.started' });
if (text === 'wait-without-output') await new Promise(() => { setInterval(() => {}, 1000); });
const response = text === 'multipart-output' ? 'a'.repeat(24_000) + 'b'.repeat(24_000) + 'c'.repeat(2000)
  : resume === -1 ? 'First SDK reply' : 'Resumed SDK reply';
emit({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: response } });
if (text === 'multipart-output') {
  await new Promise(resolve => {
    const timer = setInterval(() => {
      if (!existsSync(join(directory, 'next-output'))) return;
      clearInterval(timer);
      resolve();
    }, 10);
  });
  emit({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message',
    text: 'd'.repeat(24_000) + 'e'.repeat(24_000) + 'f'.repeat(2000) } });
  await new Promise(() => { setInterval(() => {}, 1000); });
}
if (text === 'hold-after-output') {
  await new Promise(resolve => {
    const timer = setInterval(() => {
      if (!existsSync(join(directory, 'finish'))) return;
      clearInterval(timer);
      resolve();
    }, 10);
  });
}
emit({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
