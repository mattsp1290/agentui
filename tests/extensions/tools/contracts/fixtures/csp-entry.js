import { validateExtensionLifetime } from '@agentui/sdk';
import { createFrontendToolGeneration, pinFrontendTools } from '@agentui/sdk/tools';

const { generation } = await createFrontendToolGeneration({
  accept: validateExtensionLifetime,
  namespace: 'demo',
  generation: '1',
  platform: 'desktop',
  activate(tools) {
    tools.add({
      definition: {
        name: 'x',
        description: 'x',
        parameters: {
          type: 'object',
          definitions: { word: { type: 'string', pattern: '^\\p{L}+$', format: 'regex' } },
          properties: { v: { $ref: '#/definitions/word' } }, required: ['v'],
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
  outcome: await pin.invoke('demo__x', { v: 'ok' }),
  invalid: await pin.invoke('demo__x', { v: '1' }),
  blocked,
});
pin.release();
await generation.retire();
