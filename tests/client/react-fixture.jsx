import React from 'react';
import { createRoot } from 'react-dom/client';
import { useConversation } from '@agentui/client/react';
import { fixture, snapshot, events } from './support.mjs';

const left = fixture();
const right = fixture();
function Conversation({ store, name }) {
  const view = useConversation(store);
  return <output data-testid={name}>{view.document.domain.text}|{view.draft}|{view.cursor}</output>;
}
const root = createRoot(document.getElementById('root'));
root.render(<><Conversation store={left.store} name="left" /><Conversation store={right.store} name="right" /></>);
window.clientFixture = {
  async start() {
    for (const fixture of [left, right]) {
      await fixture.store.connect();
      await fixture.port.watches[0].receive(snapshot());
    }
  },
  async update() {
    await left.store.setDraft('left draft');
    await right.store.setDraft('right draft');
    await left.port.watches[0].receive(events([1, 'shared host']));
    await right.port.watches[0].receive(events([1, 'shared host']));
  },
  unmount() { root.unmount(); left.store.disconnect(); right.store.disconnect(); },
};
