import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { UiExtensionEntry, WorkspaceViewProps } from '@agentui/sdk/react';

function Placeholder({ installations }: WorkspaceViewProps) {
  return <section aria-label="Crew workspace">
    <h2>Crew</h2>
    <p>{installations.length ? 'The Crew workspace arrives in a later release.' : 'Crew is not configured on this host.'}</p>
  </section>;
}

const entry: UiExtensionEntry<'desktop'> = {
  kind: 'desktop',
  sdkVersion: EXTENSION_SDK_VERSION,
  activate() {
    return { modules: [], workspace: { label: 'Crew', component: Placeholder }, dispose() {} };
  },
};
export default entry;
