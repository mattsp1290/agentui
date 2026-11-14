import { writeSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = new URL('../../../', import.meta.url);
const sourceFiles = new Set();
registerHooks({ resolve(specifier, context, next) {
  const value = next(specifier, context);
  if (value.url.startsWith(root.href) && !value.url.includes('/node_modules/')) {
    sourceFiles.add(relative(fileURLToPath(root), fileURLToPath(value.url)));
  }
  return value;
} });
process.on('exit', () => writeSync(1, `${JSON.stringify({ type: 'fork-import-graph', sourceFiles: [...sourceFiles].sort() })}\n`));
