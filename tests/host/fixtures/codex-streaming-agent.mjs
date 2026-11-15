import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [logPath, mode] = process.argv.slice(2);
const longText = '🙂汉"\\\n\u0000'.repeat(8_000);
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const turns = new Map();
let threadCount = 0, turnCount = 0, rejected = false;

function finish(turn, status = 'completed') {
  clearInterval(turn.timer);
  notify('turn/completed', { threadId: turn.threadId, turn: { id: turn.id, status } });
  turns.delete(turn.id);
}
function completedItem(turn, text) {
  notify('item/completed', { threadId: turn.threadId, turnId: turn.id,
    item: { type: 'agentMessage', id: 'answer', text } });
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  appendFileSync(logPath, `${line}\n`);
  if (!('method' in message)) {
    const turn = [...turns.values()].find(turn => turn.requestId === message.id);
    if (!turn) return;
    if (mode === 'pending-disconnect') { process.exit(0); return; }
    if (mode === 'pending-complete') { finish(turn); return; }
    notify('serverRequest/resolved', { threadId: turn.threadId, requestId: message.id });
    completedItem(turn, 'Approved.');
    finish(turn);
    return;
  }
  const reply = result => send({ id: message.id, result });
  if (mode === `reject-${message.method}` && !rejected) {
    rejected = true;
    send({ id: message.id, error: { code: -32000, message: 'Fixture denied this request' } });
    return;
  }
  switch (message.method) {
    case 'initialize': reply({}); break;
    case 'initialized': break;
    case 'thread/start': reply({ thread: { id: `thread-${++threadCount}` } }); break;
    case 'thread/resume': reply({ thread: { id: message.params.threadId } }); break;
    case 'turn/start': {
      const turn = { id: `turn-${++turnCount}`, threadId: message.params.threadId };
      turns.set(turn.id, turn);
      if (mode === 'lost-start') { process.exit(0); return; }
      reply({ turn: { id: turn.id } });
      notify('turn/started', { threadId: turn.threadId, turn: { id: turn.id } });
      setTimeout(() => {
        if (mode === 'long' || mode === 'short-correction') {
          for (let offset = 0; offset < longText.length; offset += 80) {
            notify('item/agentMessage/delta', { threadId: turn.threadId, turnId: turn.id, itemId: 'answer', delta: longText.slice(offset, offset + 80) });
          }
        } else if (mode.includes('approval') || mode.startsWith('pending-') || mode.startsWith('expire-')) {
          turn.requestId = 0;
          const file = mode === 'file-approval';
          if (file) notify('item/started', { threadId: turn.threadId, turnId: turn.id,
            item: { id: 'tool', type: 'fileChange', changes: [
              { path: '/workspace/src/main.ts', kind: { type: 'update', move_path: null }, diff: '-old\n+new' },
              { path: '/workspace/new.txt', kind: { type: 'add' }, diff: '+created' },
            ] } });
          send({ id: turn.requestId, method: file ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
            params: { threadId: turn.threadId, turnId: turn.id, itemId: 'tool', reason: 'Fixture permission',
              ...(file ? { grantRoot: '/workspace' } : { cwd: '/workspace/subdirectory', ...(mode === 'fallback-approval' ? {} : { command: 'printf hello' }) }) } });
        } else {
          completedItem(turn, 'Hello');
          finish(turn);
          return;
        }
        turn.timer = setInterval(() => {
          if (existsSync(`${logPath}.item`) && !turn.itemDone) {
            turn.itemDone = true;
            completedItem(turn, mode === 'short-correction' ? 'Corrected shorter reply 🙂' : `${longText} Final correction.`);
          }
          if (!existsSync(`${logPath}.finish`)) return;
          if (mode === 'expire-disconnect') process.exit(0);
          if (mode === 'expire-resolved') {
            notify('serverRequest/resolved', { threadId: turn.threadId, requestId: turn.requestId });
            clearInterval(turn.timer);
          } else finish(turn);
        }, 5);
      }, 10);
      break;
    }
    case 'turn/interrupt': {
      reply({});
      const turn = turns.get(message.params.turnId);
      if (turn) finish(turn, 'interrupted');
      break;
    }
    default: throw new Error(`Unexpected method ${message.method}`);
  }
});
