import { createInterface } from 'node:readline';

const mode = process.argv[2];
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const held = [];
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  if (!('method' in message)) {
    send({ method: 'received', params: message });
    return;
  }
  if (message.method === 'notify') send({ method: 'notificationReceived', params: message });
  else if (message.method === 'echo') send({ id: message.id, result: message.params });
  else if (message.method === 'reorder') {
    held.push(message);
    if (held.length !== 2) return;
    const output = Buffer.from([
      JSON.stringify({ method: 'delta', params: { text: 'hello 🌍' } }),
      ...held.toReversed().map(request => JSON.stringify({ id: request.id, result: request.params })),
      '',
    ].join('\n'));
    const split = output.indexOf(Buffer.from('🌍')) + 2;
    process.stdout.write(output.subarray(0, split));
    setTimeout(() => process.stdout.write(output.subarray(split)), 5);
  } else if (message.method === 'serverRequests') {
    for (const id of message.params) send({ id, method: 'approval', params: { pid: process.pid } });
    send({ id: message.id, result: true });
  } else if (message.method === 'stringReply') {
    send({ id: String(message.id), result: 'wrong id type' });
    send({ id: message.id, result: 'numeric id' });
  } else if (message.method === 'remoteError') {
    send({ id: message.id, error: { code: -32602, message: 'Invalid fixture input' } });
  } else if (message.method === 'break') {
    send({ method: 'pid', params: process.pid });
    if (mode === 'exit') {
      process.stderr.write('credential-like-private-stderr\n');
      process.exit(23);
    } else if (mode === 'oversize') process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
    else if (mode === 'bad-id') send({ id: 1.5, result: true });
    else if (mode === 'bad-method') send({ method: 42 });
    else if (mode === 'bad-response') send({ id: message.id, result: true, error: { code: 1, message: 'bad' } });
    else if (mode === 'callback') send({ method: 'throw', params: null });
    else process.stdout.write('{ broken JSON\n');
  }
});
