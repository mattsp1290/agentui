import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { crewService } from '../../extensions/crew/tests/support/crew-service.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const token = 'PRIVATE_DESKTOP_EXTENSION_TOKEN_31';
const instance = { namespace: 'crew', installationId: 'personal', generation: '1', protocolVersion: '1' };

/** Risk R1: the built `desktop` command accepts --extensions, keeps the native default and lists provider agents beside it. */
test('built desktop host loads the installed Crew extension from a version 2 file beside native agents', { timeout: 30_000 }, async t => {
  const memberId = randomUUID();
  const remote = await crewService(t, { memberId, token, instance });
  const directory = await mkdtemp(join(tmpdir(), 'agentui-desktop-extensions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'extensions.json');
  await writeFile(file, JSON.stringify({ version: 2, ownership: 'transient', extensions: [{ directory: join(root, 'extensions/crew'), installations: [{
    id: 'personal', instance, service: remote.origin, expectedAuthority: 'remote-provider',
    authentication: { kind: 'environment', variable: 'AGENTUI_EXTENSION_CREW_TOKEN', revision: '1' } }] }] }));
  const child = spawn(process.execPath, ['apps/host/dist/main.js', 'desktop', '--preferred', 'pi', '--workspace', directory,
    '--data-dir', join(directory, 'data'), '--port', '0', '--extensions', file], { cwd: root,
    env: { ...process.env, OPENCODE_GO_API_KEY: '', AGENTUI_SETUP_CAPABILITY: 'cd'.repeat(32), AGENTUI_EXTENSION_CREW_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await exited; } });
  const lines = createInterface({ input: child.stdout });
  const info = await new Promise((resolve, reject) => {
    lines.once('line', line => resolve(JSON.parse(line)));
    exited.then(() => reject(new Error(`Host stopped before readiness. ${stderr}`)));
  });
  lines.close();
  assert.equal(info.mode, 'desktop');
  const response = await fetch(`${info.origin}/api/v1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: info.origin }, body: JSON.stringify({ op: 'metadata' }) });
  const metadata = (await response.json()).value;
  const native = metadata.agents.filter(agent => !('kind' in agent));
  const provider = metadata.agents.filter(agent => agent.kind === 'provider');
  assert.ok(native.some(agent => agent.runtime.engine === 'pi'), 'the native Pi agent stays listed');
  assert.equal(metadata.defaultAgentId, native.find(agent => agent.runtime.engine === 'pi').id, 'the native default stays selected');
  assert.deepEqual(provider.map(agent => [agent.namespace, agent.installationId, agent.providerAgentId, agent.label]), [['crew', 'personal', memberId, 'codex · test']]);
  assert.deepEqual(metadata.extensions, [{ namespace: 'crew', state: 'active', operations: [], installations: [{ installationId: 'personal', status: 'available' }] }]);
  assert.equal(JSON.stringify(metadata).includes(token), false);
  assert.equal(JSON.stringify(metadata).includes(remote.origin), false);
  child.kill('SIGTERM');
  assert.equal(await exited, 0, stderr);
});
