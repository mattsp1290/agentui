import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [logPath, mode] = process.argv.slice(2);
const longText = '🙂汉"\\\n\u0000'.repeat(8_000);
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const turns = new Map();
let threadCount = 0, turnCount = 0, rejected = false;

const commandItem = { id: 'tool', type: 'commandExecution', status: 'inProgress', command: 'printf from-item', cwd: '/workspace/item' };
const standardApproval = { requestId: 0, file: false, items: [], params: { cwd: '/workspace/subdirectory', command: 'printf hello' } };
const scopedFirstApproval = { requestId: 'other-command-request', file: false, items: [commandItem], params: {} };
const approvalScenarios = {
  'item-command-approval': { requestId: 'command-request', file: false, items: [commandItem], params: {} },
  'scoped-command-approval': { requestId: 'command-request', file: false, items: [], params: {} },
  'file-approval': { requestId: 0, file: true, items: [{ id: 'tool', type: 'fileChange', changes: [
    { path: '/workspace/src/main.ts', kind: { type: 'update', move_path: null }, diff: '-old\n+new' },
    { path: '/workspace/new.txt', kind: { type: 'add' }, diff: '+created' },
  ] }], params: { grantRoot: '/workspace' } },
  'malformed-file-approval': { requestId: '0', file: true,
    items: [{ id: 'tool', type: 'fileChange', changes: [{ path: null, kind: null }] }], params: { grantRoot: '/workspace' } },
  'pending-complete': standardApproval,
  'pending-disconnect': standardApproval,
  'expire-complete': standardApproval,
  'expire-resolved': standardApproval,
  'expire-disconnect': standardApproval,
  'expire-close': standardApproval,
};

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
  const rejectFollowup = mode === 'reject-followup' && message.method === 'turn/start' && turnCount === 1;
  if ((mode === `reject-${message.method}` || rejectFollowup) && !rejected) {
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
      const approval = mode === 'scoped-command-approval' && turn.threadId === 'thread-1' ? scopedFirstApproval : approvalScenarios[mode];
      setTimeout(() => {
        if (mode === 'activity-late-context') {
          const params = { threadId: turn.threadId, turnId: turn.id };
          if (turn.id !== 'turn-1') {
            completedItem(turn, 'Current turn remains live');
            return;
          }
          notify('item/started', { ...params, item: { ...commandItem, id: 'late' } });
          turn.timer = setInterval(() => {
            if (!existsSync(`${logPath}.finish`)) return;
            finish(turn);
            const late = setInterval(() => {
              if (!existsSync(`${logPath}.late`)) return;
              clearInterval(late);
              notify('item/completed', { ...params, item: { ...commandItem, id: 'late', status: 'completed', aggregatedOutput: 'Late final output', exitCode: 0 } });
              notify('item/commandExecution/outputDelta', { ...params, itemId: 'late', delta: 'ignored' });
              completedItem(turn, 'Old assistant text must not reach current turn');
            }, 5);
          }, 5);
          return;
        } else if (mode.startsWith('activity-')) {
          const params = { threadId: turn.threadId, turnId: turn.id };
          const full = (id, status, output = null, exitCode = null) => ({ ...commandItem, id, status, aggregatedOutput: output, exitCode });
          notify('item/commandExecution/outputDelta', { ...params, itemId: 'early', delta: 'early🙂' });
          notify('item/started', { ...params, item: full('early', 'inProgress') });
          notify('item/commandExecution/outputDelta', { ...params, itemId: 'early', delta: 'delta' });
          notify('item/commandExecution/outputDelta', { ...params, turnId: 'foreign', itemId: 'early', delta: 'FOREIGN' });
          turn.timer = setInterval(() => {
            if (!existsSync(`${logPath}.finish`)) return;
            notify('item/completed', { ...params, item: full('early', 'completed', mode === 'activity-empty' ? '' : null, 3) });
            notify('item/commandExecution/outputDelta', { ...params, itemId: 'early', delta: 'late' });
            notify('item/completed', { ...params, item: full('missing-start', 'failed', longText, 7) });
            notify('item/started', { ...params, item: full('late-terminal', 'inProgress') });
            finish(turn);
            setTimeout(() => {
              notify('item/completed', { ...params, item: full('late-terminal', 'declined') });
              notify('item/commandExecution/outputDelta', { ...params, itemId: 'early', delta: 'after-close' });
            }, 15);
          }, 5);
          return;
        } else if (mode === 'long' || mode === 'short-correction') {
          for (let offset = 0; offset < longText.length; offset += 80) {
            notify('item/agentMessage/delta', { threadId: turn.threadId, turnId: turn.id, itemId: 'answer', delta: longText.slice(offset, offset + 80) });
          }
        } else if (approval) {
          turn.requestId = approval.requestId;
          for (const item of approval.items) notify('item/started', { threadId: turn.threadId, turnId: turn.id, item });
          send({ id: turn.requestId, method: approval.file ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
            params: { threadId: turn.threadId, turnId: turn.id, itemId: 'tool', reason: 'Fixture permission', ...approval.params } });
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
