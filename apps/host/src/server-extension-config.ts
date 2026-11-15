import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { identifier, record } from '@agentui/contracts/decode';
import { providerIdentity } from '@agentui/host';
import { EXTENSION_SDK_VERSION, parseExtensionManifest } from '@agentui/sdk';
import { normalizeProviderInstallations } from './provider-credentials.js';
import type { ProviderInstallation } from './provider-credentials.js';
import type { BrowserProviderExtension } from './provider-extensions.js';

function authentication(value: unknown, environment: Readonly<Record<string, string | undefined>>, variables: Set<string>): ProviderInstallation['authentication'] {
  const input = record(value);
  if (input.kind === 'unauthenticated') {
    record(value, ['kind']);
    return { kind: 'unauthenticated' };
  }
  record(value, ['kind', 'variable', 'revision']);
  const variable = identifier(input.variable);
  if (input.kind !== 'environment' || !/^AGENTUI_EXTENSION_[A-Za-z0-9_]+$/u.test(variable)) throw new Error('Invalid authentication');
  const secret = Object.hasOwn(environment, variable) ? environment[variable] : undefined;
  if (typeof secret !== 'string' || !secret.trim()) throw new Error('Missing authentication');
  const revision = identifier(input.revision);
  variables.add(variable);
  return { kind: 'secret', revision, resolve: async () => secret };
}

export function takeServerExtensionConfiguration(path: string, environment: Record<string, string | undefined>): readonly BrowserProviderExtension[] {
  try {
    const filename = resolve(path);
    const input = record(JSON.parse(readFileSync(filename, 'utf8')), ['version', 'extensions']);
    if (input.version !== 1 || !Array.isArray(input.extensions)) throw new Error('Invalid selection');
    const namespaces = new Set<string>();
    const variables = new Set<string>();
    const extensions = input.extensions.map((value: unknown): BrowserProviderExtension => {
      const selected = record(value, ['directory', 'installations']);
      const directoryName = identifier(selected.directory);
      if (!directoryName.trim() || !Array.isArray(selected.installations)) throw new Error('Invalid installation');
      const directory = resolve(dirname(filename), directoryName);
      const metadata = record(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')));
      const manifest = parseExtensionManifest(record(metadata.agentui).extension);
      if (manifest.sdkVersion !== EXTENSION_SDK_VERSION || !manifest.entries.some(entry => entry.kind === 'server') ||
        namespaces.has(manifest.namespace)) throw new Error('Invalid manifest selection');
      namespaces.add(manifest.namespace);
      const installations = selected.installations.map((value: unknown): ProviderInstallation => {
        const grant = record(value, ['id', 'instance', 'service', 'expectedAuthority', 'authentication']);
        if (grant.expectedAuthority !== 'agentui-host' && grant.expectedAuthority !== 'remote-provider') throw new Error('Invalid authority');
        return { id: identifier(grant.id), instance: providerIdentity(grant.instance), service: identifier(grant.service),
          expectedAuthority: grant.expectedAuthority, authentication: authentication(grant.authentication, environment, variables) };
      });
      return { kind: 'installed', directory, manifest, installations: normalizeProviderInstallations(manifest.namespace, installations) };
    });
    for (const variable of variables) delete environment[variable];
    return extensions;
  } catch { throw new Error('Invalid server extension configuration'); }
}
