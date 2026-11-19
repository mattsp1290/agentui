import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { UiExtensionEntry } from '@agentui/sdk/react';
import { CoworkersTranscript } from './CoworkersTranscript.js';
import { CoworkersWorkspace } from './CoworkersWorkspace.js';
import './styles.css';

const entry: UiExtensionEntry<'desktop'> = {
  kind: 'desktop',
  sdkVersion: EXTENSION_SDK_VERSION,
  activate() {
    return { modules: [], workspace: { label: 'Coworkers', component: CoworkersWorkspace, transcript: CoworkersTranscript }, dispose() {} };
  },
};
export default entry;
