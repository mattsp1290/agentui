import { registerServerCatalogHooks } from './server-catalog-loader.mjs';

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { catalog, imports, allowed, manifests } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  registerServerCatalogHooks({ imports, allowed });
  const { checkExtensionEntrypoint } = await import('@agentui/sdk');
  const { entries } = await import(catalog);
  if (!Array.isArray(entries) || entries.length !== manifests.length) process.exit(1);
  for (let index = 0; index < manifests.length; index++) {
    if (checkExtensionEntrypoint(manifests[index], 'server', entries[index]).kind !== 'compatible') process.exit(1);
  }
  process.stdout.write('agentui-catalog-qualified');
  process.exit(0);
} catch { process.exit(1); }
