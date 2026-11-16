import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHostBundle } from './host-bundle.mjs';
import { serverCustomizationAbi } from './server-customization-abi.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const result = await buildHostBundle({ abi: await serverCustomizationAbi() });
for (const file of result.outputFiles) {
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, file.contents);
}
writeFileSync(join(root, 'apps/host/dist/runtime-graph.json'), `${JSON.stringify(result.metafile, null, 2)}\n`);
