import { parseArgs } from 'node:util';

if (process.argv.includes('--refresh-ipc') && process.send) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    process.on('SIGTERM', () => {});
    try { process.kill(-process.pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } }, 500);
  };
  process.on('disconnect', stop);
  process.on('SIGTERM', stop);
  let used = false;
  try {
    const { buildServerCustomization, qualifyServerCustomizationToolchain } = await import('./server-customization.mjs');
    const { canonicalJson } = await import('@agentui/contracts');
    const { record } = await import('@agentui/contracts/decode');
    const { parseGitExtensionReference } = await import('@agentui/host/customization');
    const qualified = await qualifyServerCustomizationToolchain();
    process.on('message', async value => {
      if (used || stopping) { stop(); return; }
      used = true;
      try {
        if (Buffer.byteLength(JSON.stringify(value)) > 65_536) throw new Error();
        const message = record(value, ['kind', 'expected', 'command']);
        const command = record(message.command, ['id', 'requestId', 'source', 'directory', 'toolchain']);
        if (message.kind !== 'build' || canonicalJson(message.expected) !== canonicalJson(qualified) ||
          canonicalJson(command.toolchain) !== canonicalJson(qualified.identity)) throw new Error();
        const result = await buildServerCustomization({ reference: parseGitExtensionReference(command.source), out: command.directory,
          expectedToolchain: qualified, attempt: command.id });
        const current = await qualifyServerCustomizationToolchain();
        if (canonicalJson(current) !== canonicalJson(qualified)) throw new Error();
        if (!stopping && process.connected) process.send({ kind: 'built', artifactId: result.manifest.artifactId, qualification: current });
      } catch (error) {
        const failures = { 'toolchain-mismatch': 'incompatible', 'resource-limit': 'resource-limit', 'entry-validation': 'qualification',
          'publication-failed': 'publication', 'output-exists': 'publication', 'build-failed': 'build' };
        if (!stopping && process.connected) process.send({ kind: 'failed', failure: failures[error?.code] ?? 'source' });
      }
    });
    if (!stopping && process.connected) process.send({ kind: 'qualified', qualification: qualified });
  } catch { stop(); }
} else {
  const { CustomizationError } = await import('@agentui/host/customization');
  const { buildServerCustomization } = await import('./server-customization.mjs');
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
}
