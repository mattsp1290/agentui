import { createHash } from 'node:crypto';

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function distribution(os, arch) {
  const platforms = { Darwin: 'darwin', Linux: 'linux' };
  const architectures = { arm64: 'arm64', aarch64: 'arm64', x86_64: 'x64', x64: 'x64' };
  if (!Object.hasOwn(platforms, os) || !Object.hasOwn(architectures, arch)) {
    throw new Error(`Unsupported server architecture ${os} ${arch}. Use macOS or Linux on ARM64 or x64.`);
  }
  return `${platforms[os]}-${architectures[arch]}`;
}

export function profileFor(target, workspace, agent) {
  const identity = createHash('sha256').update(JSON.stringify({ target, workspace, agent })).digest('hex');
  return { id: identity.slice(0, 12), port: 18000 + Number.parseInt(identity.slice(0, 7), 16) % 22000 };
}

export function bootstrapScript(nodeVersion, agent, codexVersion) {
  return `set -eu
umask 077
root="$HOME/.local/share/agentui"
mkdir -p "$root/tools" "$root/data" "$root/releases"
os=$(uname -s)
arch=$(uname -m)
case "$os" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) echo "Unsupported server OS: $os" >&2; exit 1 ;; esac
case "$arch" in arm64|aarch64) architecture=arm64 ;; x86_64|x64) architecture=x64 ;; *) echo "Unsupported server architecture: $arch" >&2; exit 1 ;; esac
node_version=${shellQuote(nodeVersion)}
node_root="$root/tools/node-v$node_version-$platform-$architecture"
node="$node_root/bin/node"
for candidate in "$node" "$HOME/.nvm/versions/node/v$node_version/bin/node" "$(command -v node || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && [ "$("$candidate" --version 2>/dev/null)" = "v$node_version" ]; then node="$candidate"; break; fi
done
if [ ! -x "$node" ] || [ "$("$node" --version 2>/dev/null || true)" != "v$node_version" ]; then
  echo "Installing Node $node_version for $platform-$architecture in AgentUI's private tools directory." >&2
  work=$(mktemp -d "$root/tools/.node-XXXXXX")
  trap 'rm -rf "$work"' EXIT HUP INT TERM
  curl --fail --location --silent --show-error --retry 2 --connect-timeout 15 "https://nodejs.org/dist/v$node_version/node-v$node_version-$platform-$architecture.tar.gz" -o "$work/node.tar.gz"
  tar -xzf "$work/node.tar.gz" -C "$work"
  if [ -d "$node_root" ]; then
    if [ ! -x "$node_root/bin/node" ] || [ "$("$node_root/bin/node" --version 2>/dev/null || true)" != "v$node_version" ]; then echo "Incomplete Node installation at $node_root. Remove it and retry." >&2; exit 1; fi
  else
    mv "$work/node-v$node_version-$platform-$architecture" "$node_root"
  fi
  rm -rf "$work"
  trap - EXIT HUP INT TERM
  node="$node_root/bin/node"
fi
export PATH="$(dirname "$node"):$PATH"
codex=''
${agent === 'codex' ? `codex_root="$root/tools/codex-${codexVersion}"
codex="$codex_root/node_modules/.bin/codex"
if [ ! -x "$codex" ] || [ "$("$codex" --version 2>/dev/null || true)" != "codex-cli ${codexVersion}" ]; then
  echo "Installing Codex ${codexVersion} in AgentUI's private tools directory." >&2
  npm install --prefix "$codex_root" --no-audit --no-fund '@openai/codex@${codexVersion}' >&2
fi
if ! "$codex" login status >&2; then
  echo "Codex login is required on this server. Run $codex login there, then rerun AgentUI." >&2
  exit 1
fi` : ''}
"$node" -e 'console.log("AGENTUI_SETUP " + JSON.stringify({home:process.env.HOME,root:process.argv[1],node:process.argv[2],codex:process.argv[3],os:process.argv[4],arch:process.argv[5]}))' "$root" "$node" "$codex" "$os" "$arch"
`;
}
