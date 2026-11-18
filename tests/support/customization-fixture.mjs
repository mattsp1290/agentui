import { EXTENSION_SDK_VERSION } from '@agentui/sdk';

/**
 * A small, dependency-free customization repository (npm inputs absent): a root package in `custom/` with same-repository
 * references to two tiny extensions, each with a desktop and a server entry, one grant each, and a settings file.
 */
export function customizationFixtureFiles({ enabled = { alpha: true, beta: true } } = {}) {
  const extension = namespace => ({
    [`ext/${namespace}/package.json`]: JSON.stringify({ name: `fixture-${namespace}`, version: '0.0.0', private: true, type: 'module', agentui: {
      extension: { namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './dist/server.js' }, { kind: 'desktop', module: './dist/desktop.js' }] },
      sources: { './dist/server.js': './server.ts', './dist/desktop.js': './desktop.tsx' } } }, null, 2) + '\n',
    [`ext/${namespace}/server.ts`]: `import { EXTENSION_SDK_VERSION } from '@agentui/sdk';\nexport default { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, activate() { return { dispose() {} }; } };\n`,
    [`ext/${namespace}/desktop.tsx`]: `export default { kind: 'desktop', sdkVersion: '${EXTENSION_SDK_VERSION}', activate() { return { modules: [], dispose() {} }; } };\n`,
  });
  const grant = namespace => ({ id: 'personal', instance: { namespace, installationId: 'personal', generation: '1', protocolVersion: '1' },
    service: 'http://127.0.0.1:9', expectedAuthority: 'remote-provider',
    authentication: { kind: 'environment', variable: `AGENTUI_EXTENSION_${namespace.toUpperCase()}_TOKEN`, revision: '1' } });
  return {
    'custom/package.json': `{
  "name": "fixture-customization",
  "version": "0.0.0",
  "private": true,
  "agentui": {
    "extensions": [
      { "subdirectory": "ext/alpha", "enabled": ${enabled.alpha} },
      { "subdirectory": "ext/beta", "enabled": ${enabled.beta} }
    ],
    "installations": ${JSON.stringify([grant('alpha'), grant('beta')])}
  }
}
`,
    'custom/agentui-settings.json': '{\n  "version": 1,\n  "appearance": "system",\n  "showExtensionViews": true\n}\n',
    ...extension('alpha'), ...extension('beta'),
  };
}
export const fixtureConnection = remote => ({ location: remote, branch: 'customization', subdirectory: 'custom' });
