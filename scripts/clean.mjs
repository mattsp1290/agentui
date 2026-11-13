import { rm } from 'node:fs/promises';
const workspaces = ["packages/contracts","packages/sdk","packages/host","packages/adapter-tests","apps/desktop","apps/ios"];
await Promise.all(workspaces.map((workspace) => rm(new URL(`../${workspace}/dist/`, import.meta.url), { recursive: true, force: true })));
