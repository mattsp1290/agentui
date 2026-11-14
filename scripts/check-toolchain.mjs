import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const [manager, version] = pkg.packageManager.split('@');
assert.equal(manager, 'npm');
assert.equal(process.versions.node, readFileSync(new URL('.node-version', root), 'utf8').trim());
assert.equal(execFileSync(manager, ['--version'], { encoding: 'utf8' }).trim(), version);
