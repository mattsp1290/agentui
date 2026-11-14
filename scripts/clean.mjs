import { readFile, rm } from 'node:fs/promises';
const { workspaces } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await Promise.all(workspaces.map((workspace) => rm(new URL(`../${workspace}/dist/`, import.meta.url), { recursive: true, force: true })));
