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

export function harnessInstallScript({ id, packageName, version, executable, expectedVersion }) {
  return `harness_root="$root/tools/harnesses/"${shellQuote(`${id}-${version}`)}
mkdir -p "$root/tools/harnesses"
check_harness() {
  "$node" --input-type=commonjs -e 'const fs=require("node:fs"),cp=require("node:child_process"),path=require("node:path"); try { const [root,pkg,version,bin,expected]=process.argv.slice(1); const data=JSON.parse(fs.readFileSync(path.join(root,"node_modules",pkg,"package.json"),"utf8")); if(data.version!==version)process.exit(1); const actual=cp.execFileSync(path.join(root,"node_modules/.bin",bin),["--version"],{encoding:"utf8",timeout:10000,stdio:["ignore","pipe","ignore"]}).trim(); if(actual!==expected)process.exit(1); }catch{process.exit(1);}' "$1" ${[packageName, version, executable, expectedVersion].map(shellQuote).join(' ')}
}
if ! check_harness "$harness_root"; then
  work=$(mktemp -d "$root/tools/.harness-${id}-XXXXXX")
  trap 'if [ ! -f "$work/.ready" ]; then rm -rf "$work"; fi' EXIT
  trap 'exit 1' HUP INT TERM
  echo ${shellQuote(`Installing ${id} ${version} in AgentUI's private tools directory.`)} >&2
  : > "$work/user.npmrc"
  : > "$work/global.npmrc"
  npm install --prefix "$work" --ignore-scripts --no-audit --no-fund --userconfig "$work/user.npmrc" --globalconfig "$work/global.npmrc" --registry=https://registry.npmjs.org ${shellQuote(`${packageName}@${version}`)} >&2
${id === 'claude' ? `  "$node" --input-type=commonjs -e '
const fs = require("node:fs"), path = require("node:path");
const [root, version] = process.argv.slice(1);
const musl = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime;
const name = "@anthropic-ai/claude-code-" + process.platform + "-" + process.arch + (musl ? "-musl" : "");
const wrapper = JSON.parse(fs.readFileSync(path.join(root, "node_modules/@anthropic-ai/claude-code/package.json"), "utf8"));
const native = path.join(root, "node_modules", name);
const manifest = JSON.parse(fs.readFileSync(path.join(native, "package.json"), "utf8"));
if (wrapper.optionalDependencies?.[name] !== version || manifest.name !== name || manifest.version !== version) throw new Error("Claude native package does not match its pin.");
const executable = path.join(native, "claude"), link = path.join(root, "node_modules/.bin/claude");
fs.chmodSync(executable, 0o755);
fs.unlinkSync(link);
fs.symlinkSync(executable, link);
' "$work" ${shellQuote(version)}
` : ''}
  if ! check_harness "$work"; then echo 'Installed harness did not pass its version check.' >&2; exit 1; fi
  : > "$work/.ready"
  "$node" --input-type=commonjs -e 'const fs=require("node:fs"),path=require("node:path");const [work,target]=process.argv.slice(1);const link=path.join(work,"publish");fs.symlinkSync(work,link);fs.renameSync(link,target);' "$work" "$harness_root"
  trap - EXIT HUP INT TERM
fi
harness="$harness_root/node_modules/.bin/"${shellQuote(executable)}
`;
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
  trap 'rm -rf "$work"' EXIT
  trap 'exit 1' HUP INT TERM
  curl --fail --location --silent --show-error --retry 2 --connect-timeout 15 "https://nodejs.org/dist/v$node_version/node-v$node_version-$platform-$architecture.tar.gz" -o "$work/node.tar.gz"
  case "$node_version:$platform-$architecture" in
    24.22.3:darwin-arm64) checksum=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd ;;
    24.22.3:darwin-x64) checksum=977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7 ;;
    24.22.3:linux-arm64) checksum=261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8 ;;
    24.22.3:linux-x64) checksum=061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2 ;;
    *) echo 'No verified Node archive is configured for this runtime.' >&2; exit 1 ;;
  esac
  if command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$work/node.tar.gz"); else actual=$(sha256sum "$work/node.tar.gz"); fi
  if [ "\${actual%% *}" != "$checksum" ]; then echo 'Node archive checksum verification failed.' >&2; exit 1; fi
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
${agent === 'codex' ? `${harnessInstallScript({ id: 'codex', packageName: '@openai/codex', version: codexVersion, executable: 'codex', expectedVersion: `codex-cli ${codexVersion}` })}
codex="$harness"` : ''}
"$node" -e 'console.log("AGENTUI_SETUP " + JSON.stringify({home:process.env.HOME,root:process.argv[1],node:process.argv[2],codex:process.argv[3],os:process.argv[4],arch:process.argv[5]}))' "$root" "$node" "$codex" "$os" "$arch"
`;
}
