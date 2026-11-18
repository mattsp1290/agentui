import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ServerExtensionEntry } from '@agentui/sdk';
import { registerCrewProvider } from './provider.js';

/** The installed server entry. It serves every configured installation, each under its own grant id. */
const entry: ServerExtensionEntry = {
  kind: 'server',
  sdkVersion: EXTENSION_SDK_VERSION,
  activate(context) {
    for (const installation of context.installations) {
      registerCrewProvider(context, installation.id, { service: installation.service, instance: installation.instance });
    }
    return { dispose() {} };
  },
};
export default entry;
