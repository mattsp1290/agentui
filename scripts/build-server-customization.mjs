import { parseArgs } from 'node:util';
import { CustomizationError } from '@agentui/host/customization';
import { buildServerCustomization } from './server-customization.mjs';

try {
  const { values } = parseArgs({ options: { repository: { type: 'string' }, commit: { type: 'string' }, subdirectory: { type: 'string' }, out: { type: 'string' } } });
  if (!values.repository || !values.commit || !values.out) throw new Error();
  const result = await buildServerCustomization({ reference: { repository: values.repository, commit: values.commit,
    ...(values.subdirectory ? { subdirectory: values.subdirectory } : {}) }, out: values.out });
  console.log(JSON.stringify({ directory: result.directory, artifactId: result.manifest.artifactId, root: result.manifest.root }));
} catch (error) {
  console.error(error instanceof CustomizationError ? error.message : 'Usage: build-server-customization.mjs --repository PATH --commit FULL_COMMIT --out FRESH_DIRECTORY [--subdirectory PATH]');
  process.exitCode = 1;
}
