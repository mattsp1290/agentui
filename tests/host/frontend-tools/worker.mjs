import { frontendToolsFor } from '@agentui/host/frontend-tools';
import { appendFileSync } from 'node:fs';
import { openLocalHost, createRecordedDriver } from '@agentui/host';
import { createFrontendToolGeneration, pinFrontendTools } from '@agentui/sdk/tools';
import { projection, installed, scope, run } from '../fixture.mjs';
const [path, mode, id, extra] = process.argv.slice(2);
const driver = createRecordedDriver({ installation: installed, backendPath: path + '.recorded', decodeEvent: projection.decodeEvent });
const host = openLocalHost({ path, projection, driver, authorize: () => true });
const key = { threadId: 'thread', runId: 'run-a' };
const client = frontendToolsFor(host).client(scope, { id, platform: 'desktop', authorized: () => true });
if (mode === 'open') {
  process.stdout.write('opened\n'); host.close(); await host.drained;
} else if (mode === 'race') {
  process.stdout.write('ready\n');
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdout.write(JSON.stringify(client.claim(key, 'a', extra)) + '\n');
  host.close(); await host.drained;
} else {
  const { generation } = await createFrontendToolGeneration({ namespace: 'demo', generation: 'same', platform: 'desktop',
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'work', description: 'work' }, decodeInput: x => x,
      async execute() { appendFileSync(extra, 'effect\n'); return 'done'; } }); return { dispose() {} }; }, accept: x => x });
  const pin = pinFrontendTools({ generations: [generation], platform: 'desktop', run: run().identity, capabilities: { tools: { clientProvided: true } } });
  const binding = pin.bindings[0], producer = frontendToolsFor(host).producer(scope);
  producer.register({ identity: pin.run, threadId: key.threadId, platform: 'desktop', bindings: [{ ...binding, definition: pin.definitions[0] }] });
  const events = [{ type: 'RUN_STARTED', ...key }, { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: binding.name },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'a', delta: '{}' }, { type: 'TOOL_CALL_END', toolCallId: 'a' }, { type: 'RUN_FINISHED', ...key }];
  events.forEach((event, i) => { if (producer.observe(key, i + 1, event) !== 'accepted') throw new Error('Event refused'); });
  producer.decide(key, 'a', 'allow', binding.activationId, producer.inspect(key).calls[0].argumentsDigest);
  const permit = client.claim(key, 'a', binding.activationId);
  if (permit.kind !== 'permit') throw new Error('Permit refused');
  await pin.invoke(permit.name, permit.arguments, binding.activationId);
  process.stdout.write(JSON.stringify({ activationId: binding.activationId }) + '\n', () => process.exit(0));
}
