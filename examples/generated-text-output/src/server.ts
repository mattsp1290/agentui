import { isAbsolute } from 'node:path';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ServerExtensionEntry } from '@agentui/sdk';
import { reportProvider } from './provider.js';

export default {
  kind: 'server', sdkVersion: EXTENSION_SDK_VERSION,
  activate(context) {
    const path = process.env.AGENTUI_REPORT_DATABASE;
    if (!path || !isAbsolute(path) || context.namespace !== 'reports') throw new Error('Configure an absolute AGENTUI_REPORT_DATABASE path');
    const provider = reportProvider(path);
    try { context.providers.add('reports', provider.backend, provider.presentation); }
    catch (error) { provider.close(); throw error; }
    return { dispose() { provider.close(); } };
  },
} satisfies ServerExtensionEntry;
