import { createFrontendToolGeneration, pinFrontendTools } from '@agentui/sdk/tools';

const { generation } = await createFrontendToolGeneration({
  capture: () => undefined,
  namespace: 'demo',
  generation: '1',
  platform: 'desktop',
  activate({ frontendTools: tools }) {
    tools.add({
      definition: {
        name: 'x',
        description: 'x',
        parameters: {
          type: 'object',
          properties: { v: { type: 'string', pattern: '^\\p{L}+$', format: 'regex' } }, required: ['v'],
        },
      },
      decodeInput(value) {
        return value.v;
      },
      async execute(value) {
        return value;
      },
    });
    return { dispose() {} };
  },
});
const pin = pinFrontendTools({
  generations: [generation],
  platform: 'desktop',
  run: {
    conversation: { hostId: 'h', conversationId: 'c' },
    runId: 'r',
    authority: {
      kind: 'agentui-host',
      hostId: 'h',
      binding: { namespace: 'n', installationId: 'i', opaqueSessionId: 's' },
    },
  },
  capabilities: { tools: { clientProvided: true } },
});
let blocked = false;
try {
  new Function('return 1')();
} catch {
  blocked = true;
}
document.body.textContent = JSON.stringify({
  outcome: await pin.invoke('demo__x', { v: 'ok' }, pin.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? ''),
  invalid: await pin.invoke('demo__x', { v: '1' }, pin.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? ''),
  blocked,
});
pin.release();
await generation.retire();
