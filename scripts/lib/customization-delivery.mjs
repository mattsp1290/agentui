// Delivers a ready build to the machine that runs the host. A local host reads it in place; an SSH host gets a copy under
// its own setup root, uploaded with the launcher's tar-over-ssh helper. Paths in the result are absolute on the host machine.
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { shellQuote } from '../agentui-runtime.mjs';

export class DeliveryFailed extends Error {}

function layout(root, record, joiner) {
  return { assets: record.desktopArtifactId ? joiner(root, 'desktop') : null,
    server: record.serverArtifactId ? { directory: joiner(root, 'server'), artifactId: record.serverArtifactId } : null, grants: record.grants ?? [] };
}

/**
 * `runner(args, lifecycle)` starts `ssh` with `args` and returns `{ child, exited }`, where `exited` resolves with standard
 * output; tests pass one that runs the remote script locally. `keep` names build keys whose remote copies stay.
 */
export async function deliverBuild({ buildsRoot, buildKey, target, keep = [], runner, lifecycle = {} }) {
  let record;
  try { record = JSON.parse(await readFile(join(buildsRoot, buildKey, 'build.json'), 'utf8')); } catch { throw new DeliveryFailed('The build record is unreadable.'); }
  if (record?.state !== 'ready' || record.buildKey !== buildKey) throw new DeliveryFailed('The build is not ready.');
  if (target.kind === 'local') return layout(join(buildsRoot, buildKey), record, join);

  const { sshOptions, uploadDirectory, sshRunner } = await import('../agentui-launch.mjs');
  const ssh = runner ?? sshRunner;
  const remoteRoot = posix.join(target.remoteSetupRoot, 'customization', 'builds');
  const remote = posix.join(remoteRoot, buildKey);
  const remoteCommand = async script => {
    const task = ssh([...sshOptions, target.destination, `sh -c ${shellQuote(script)}`], lifecycle);
    task.child.stdin?.end();
    return task.exited;
  };
  // A key can be rebuilt after a failure, so an existing remote copy is reused only when it holds the same artifacts.
  let existing = null;
  try { existing = JSON.parse(await remoteCommand(`cat ${shellQuote(posix.join(remote, 'build.json'))} 2>/dev/null || true`) || 'null'); } catch { existing = null; }
  if (existing?.desktopArtifactId !== record.desktopArtifactId || existing?.serverArtifactId !== record.serverArtifactId || existing?.state !== 'ready') {
    const script = `set -eu; umask 077; root=${shellQuote(remoteRoot)}; dest=${shellQuote(remote)}; mkdir -p "$root"; work=$(mktemp -d "$root/.upload-XXXXXX"); trap 'rm -rf "$work"' EXIT HUP INT TERM; tar -xzf - -C "$work"; rm -rf "$dest"; mv "$work" "$dest"; trap - EXIT HUP INT TERM`;
    try { await uploadDirectory(target.destination, join(buildsRoot, buildKey), script, lifecycle, ssh); } catch { throw new DeliveryFailed('The build could not be copied to the host.'); }
  }
  // Remote builds that neither the running host nor this apply uses are removed.
  const kept = [...new Set([buildKey, ...keep])].filter(key => /^[0-9a-f]{64}$/u.test(key ?? '')).join(' ');
  // Other profiles on the same remote machine keep the builds their own launch.json names.
  const launchFiles = shellQuote(posix.join(target.remoteSetupRoot, 'data')) + '/*/customization/launch.json';
  await remoteCommand(`others=$(cat ${launchFiles} 2>/dev/null | grep -o '[0-9a-f]\\{64\\}' || true); cd ${shellQuote(remoteRoot)} 2>/dev/null || exit 0; for entry in *; do [ -d "$entry" ] || continue; case " ${kept} $(echo $others) " in *" $entry "*) continue;; esac; rm -rf -- "$entry"; done`).catch(() => {});
  return layout(remote, record, posix.join);
}
