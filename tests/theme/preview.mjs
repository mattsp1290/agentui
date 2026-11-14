import { createPreview } from './server.mjs';
const preview = await createPreview(Number(process.env.PORT ?? 4173));
console.log(`Theme workbench at ${preview.url}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await preview.close(); process.exit(0); });
}
