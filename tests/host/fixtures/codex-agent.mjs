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
let previous;

function finish(turn, status = 'completed', text = 'Hello from the fixture.') {
  if (active !== turn) return;
  clearInterval(turn.timer);
  if (status === 'completed') notify('item/completed', {
    threadId, turnId: turn.id, item: { id: turn.itemId, type: 'agentMessage', text },
  });
  notify('turn/completed', { threadId, turn: { id: turn.id, status, error: null, items: [] } });
  previous = turn;
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
    case 'model/list': {
      if (mode === 'models-error') { send({ id: message.id, error: { code: -32000, message: 'Fixture model catalog unavailable' } }); break; }
      if (mode === 'models-malformed') { reply({ data: [{ model: 3 }], nextCursor: null }); break; }
      const sol = { id: 'sol-choice', model: 'gpt-9.2-sol', displayName: 'GPT-9.2-Sol', hidden: false, isDefault: false,
        ...(mode === 'images' ? { inputModalities: ['text', 'audio', 'image', 'text'] } : {}) };
      const astra = { id: 'astra-choice', model: 'gpt-9.1-astra', displayName: 'GPT-9.1-Astra', hidden: false, isDefault: true };
      reply(message.params.cursor ? { data: [sol, astra], nextCursor: mode === 'models-repeat' ? 'next-model-page' : null }
        : { data: [sol, { ...astra, model: 'hidden-model', hidden: true }], nextCursor: 'next-model-page' });
      break;
    }
    case 'thread/start':
    case 'thread/resume': reply({ thread: { id: threadId, turns: [] } }); break;
    case 'turn/start': {
      const turn = { id: `fixture-turn-${process.pid}-${++sequence}`, itemId: `message-${process.pid}-${sequence}` };
      active = turn;
      reply({ turn: { id: turn.id, status: 'inProgress', error: null, items: [] } });
      if (mode === 'before-text') {
        turn.timer = setInterval(() => {
          if (!existsSync(`${logPath}.release-start`)) return;
          clearInterval(turn.timer);
          notify('turn/started', { threadId, turn: { id: turn.id, status: 'inProgress', error: null, items: [] } });
          notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: turn.itemId, delta: 'Hello' });
        }, 5);
        break;
      }
      notify('turn/started', { threadId, turn: { id: turn.id, status: 'inProgress', error: null, items: [] } });
      if (previous) {
        notify('turn/started', { threadId, turn: { id: previous.id } });
        notify('turn/completed', { threadId, turn: { id: previous.id, status: 'interrupted' } });
      }
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
      if (mode === 'reject-stop') {
        send({ id: message.id, error: { code: -32000, message: 'Cannot interrupt now' } });
        break;
      }
      reply({});
      if (mode === 'delayed-stop' || mode === 'natural-race') {
        const turn = active;
        setTimeout(() => finish(turn, mode === 'natural-race' ? 'completed' : 'interrupted'), 300);
      } else finish(active, 'interrupted');
      break;
    }
    default: throw new Error(`Unexpected fixture method ${message.method}`);
  }
});
