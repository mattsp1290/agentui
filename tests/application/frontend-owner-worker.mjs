import { openLocalHost } from '@agentui/host';
import { frontendToolsFor } from '@agentui/host/frontend-tools';
import { projection, scope } from '../host/fixture.mjs';
const [path, encodedKey, activationId] = process.argv.slice(2), key = JSON.parse(encodedKey);
const host = openLocalHost({ path, projection, driver: [], authorize: () => true });
const actor = { id: 'owner', platform: 'desktop', authorized: () => true };
const client = frontendToolsFor(host).client(scope, actor);
process.on('message', async request => {
  try {
    const value = request.action === 'withdraw'
      ? await host.frontendBinding({ scope, id: 'offered', action: 'unavailable' }, actor, () => { throw new Error('Unexpected producer callback'); })
      : request.action === 'claim' ? client.claim(key, request.callId, activationId)
      : client.receipt(key, request.permitId, request.result);
    process.send({ value });
  } catch (error) { process.send({ error: error.message }); }
});
process.on('SIGTERM', () => { host.close(); process.exit(0); });
process.send({ kind: 'ready' });
