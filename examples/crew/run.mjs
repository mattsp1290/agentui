import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { startBrowserHost } from '../../apps/host/build/tsc/server.js';
import { readAgentConfiguration } from '../../apps/host/build/tsc/agent-config.js';
import { readObservabilityConfiguration } from '../../apps/host/build/tsc/observability.js';
import { crewProvider } from './dist/provider.js';

const config = z.strictObject({ service: z.url(), memberId: z.uuid(), installationId: z.string().min(1),
  generation: z.string().min(1), credentialRevision: z.string().min(1), tokenFile: z.string().min(1),
  directory: z.string().min(1), port: z.int().min(0).max(65535).default(8787), nativeConfig: z.string().optional() })
  .parse(JSON.parse(await readFile(resolve(process.argv[2] ?? 'crew-provider.json'), 'utf8')));
const instance = { namespace: 'crew', installationId: config.installationId, generation: config.generation, protocolVersion: '1' };
const extension = crewProvider({ service: config.service, memberId: config.memberId, instance });
const running = await startBrowserHost({ directory: resolve(config.directory), port: config.port,
  observability: readObservabilityConfiguration(process.env),
  assetsDirectory: fileURLToPath(new URL('../../apps/desktop/web-dist-browser/', import.meta.url)),
  hostArtifactDirectory: fileURLToPath(new URL('../../apps/host/dist/', import.meta.url)),
  agentStartup: config.nativeConfig ? { kind: 'configured', configuration: readAgentConfiguration(resolve(config.nativeConfig)) } : { kind: 'extensions' },
  providerExtensions: [{ ...extension, installations: [{ id: 'member', instance, service: config.service,
    expectedAuthority: 'remote-provider', authentication: { kind: 'secret', revision: config.credentialRevision,
      resolve: async () => (await readFile(resolve(config.tokenFile), 'utf8')).trim() } }] }] });
process.stdout.write(`AgentUI with Crew is ready at ${running.origin}/browser.html\n`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void running.close().catch(() => { process.exitCode = 1; }); });
