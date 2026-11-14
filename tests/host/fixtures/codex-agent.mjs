import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [logPath, mode = 'stream'] = process.argv.slice(2);
const record = (direction, message) => appendFileSync(logPath, `${JSON.stringify({ direction, pid: process.pid, ...message })}\n`);
const send = message => {
  record('out', message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const notify = (method, params) => send({ method, params });
const threadId = 'fixture-thread';
let sequence = 0;
let active;

function finish(turn, status = 'completed', text = 'Hello from the fixture.') {
  if (active !== turn) return;
  clearInterval(turn.timer);
  if (status === 'completed') notify('item/completed', {
    threadId, turnId: turn.id, item: { id: turn.itemId, type: 'agentMessage', text },
  });
  notify('turn/completed', { threadId, turn: { id: turn.id, status, error: null, items: [] } });
  active = undefined;
}

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  record('in', message);
  if (!('method' in message)) {
    if (!active || message.id !== active.requestId) throw new Error('Unexpected approval response');
    notify('serverRequest/resolved', { threadId, requestId: message.id });
    finish(active, 'completed', `Approval ${message.result.decision}.`);
    return;
  }
  const reply = result => send({ id: message.id, result });
  switch (message.method) {
    case 'initialize': reply({ userAgent: 'agentui-codex-fixture', platformFamily: 'unix' }); break;
    case 'initialized': break;
    case 'thread/start':
    case 'thread/resume': reply({ thread: { id: threadId, turns: [] } }); break;
    case 'turn/start': {
      const turn = { id: `fixture-turn-${process.pid}-${++sequence}`, itemId: `message-${process.pid}-${sequence}` };
      active = turn;
      reply({ turn: { id: turn.id, status: 'inProgress', error: null, items: [] } });
      notify('turn/started', { threadId, turn: { id: turn.id, status: 'inProgress', error: null, items: [] } });
      setTimeout(() => {
        notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: turn.itemId, delta: 'Hello' });
        if (mode === 'exit') { process.exit(23); return; }
        if (mode === 'command-approval' || mode === 'file-approval') {
          turn.requestId = mode === 'command-approval' ? 0 : 'file-request';
          send({ id: turn.requestId,
            method: mode === 'command-approval' ? 'item/commandExecution/requestApproval' : 'item/fileChange/requestApproval',
            params: { threadId, turnId: turn.id, itemId: 'tool-item',
              reason: 'The fixture needs a decision.',
              ...(mode === 'command-approval'
                ? { command: 'printf hello', cwd: process.cwd(), commandActions: [{ type: 'unknown', command: 'printf hello' }] }
                : { grantRoot: process.cwd() }),
            },
          });
          return;
        }
        turn.timer = setInterval(() => {
          if (!turn.messageFinished && existsSync(`${logPath}.item-${turn.id}`)) {
            turn.messageFinished = true;
            notify('item/completed', { threadId, turnId: turn.id, item: { id: turn.itemId, type: 'agentMessage', text: 'Hello from the fixture.' } });
          }
          if (existsSync(`${logPath}.complete-${turn.id}`)) finish(turn);
        }, 5);
      }, 10);
      break;
    }
    case 'turn/interrupt': {
      reply({});
      finish(active, 'interrupted');
      break;
    }
    default: throw new Error(`Unexpected fixture method ${message.method}`);
  }
});
