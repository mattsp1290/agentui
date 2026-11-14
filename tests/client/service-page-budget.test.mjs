import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '@agentui/contracts';
import { parseServicePull, SERVICE_EVENT_PAGE } from '@agentui/contracts/service';

const scope = { hostId: 'host', conversationId: 'conversation' };
const page = events => ({ kind: 'page', page: 1, item: { kind: 'events', events } });

test('service event pages use the same envelope byte budget as the host journal', () => {
  const events = Array.from({ length: 4 }, (_, index) => {
    const envelope = { scope, sequence: index + 1, event: { kind: 'domain', event: {
      kind: 'message-updated', messageId: `message-${index}`, revision: 1, role: 'user', text: '', complete: true,
    } } };
    envelope.event.event.text = 'x'.repeat(SERVICE_EVENT_PAGE.bytes / 4 - Buffer.byteLength(canonicalJson(envelope)));
    return envelope;
  });
  assert.equal(events.reduce((bytes, event) => bytes + Buffer.byteLength(canonicalJson(event)), 0), SERVICE_EVENT_PAGE.bytes);
  assert.deepEqual(parseServicePull(page(events)), page(events));
  events[0].event.event.text += 'x';
  assert.throws(() => parseServicePull(page(events)), /byte limit/);
  assert.throws(() => parseServicePull(page(Array(SERVICE_EVENT_PAGE.events + 1).fill(events[0]))), /Invalid service feed item/);
});
