import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { UiExtensionEntry, WorkspaceViewProps } from '@agentui/sdk/react';

function Placeholder({ installations }: WorkspaceViewProps) {
  return <section aria-label="Coworkers workspace">
    <h2>Coworkers</h2>
    <p>{installations.length ? 'The Coworkers workspace arrives in a later release.' : 'Coworkers is not configured on this host.'}</p>
  </section>;
}

const entry: UiExtensionEntry<'desktop'> = {
  kind: 'desktop',
  sdkVersion: EXTENSION_SDK_VERSION,
  activate() {
    return { modules: [], workspace: { label: 'Coworkers', component: Placeholder }, dispose() {} };
  },
};
export default entry;
