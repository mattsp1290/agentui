import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const json = (path) => JSON.parse(read(path));

test('iOS type declarations and native package use the same locked runtime versions', () => {
  const platform = json('apps/ios/package.json');
  const native = json('apps/ios/native/package.json');
  const lock = json('apps/ios/native/package-lock.json');
  for (const dependency of ['react', 'react-native']) {
    assert.equal(native.dependencies[dependency], platform.dependencies[dependency]);
  }
  for (const group of ['dependencies', 'devDependencies']) {
    assert.deepEqual(lock.packages[''][group], native[group]);
    for (const [dependency, version] of Object.entries(native[group])) {
      assert.equal(lock.packages[`node_modules/${dependency}`].version, version);
    }
  }
  assert.equal(native.engines.node, read('.node-version').trim());
  assert.equal(`npm@${native.engines.npm}`, json('package.json').packageManager);
  for (const dependency of ['@agentui/theme', '@agentui/ui-primitives']) {
    assert.equal(platform.dependencies[dependency], json(`packages/${dependency.slice('@agentui/'.length)}/package.json`).version);
    assert.equal(json('package-lock.json').packages['apps/ios'].dependencies[dependency], platform.dependencies[dependency]);
  }
  const hermes = lock.packages['node_modules/hermes-compiler'].version;
  assert.ok(read('apps/ios/native/ios/Podfile.lock').includes(`:tag: hermes-v${hermes}\n`));
});

test('all iOS entry points reject malformed or extra simulator arguments before preparation', () => {
  const invalidArguments = [[], ['not-a-simulator'], ['g'.repeat(36)], ['-'.repeat(36)],
    ['a'.repeat(35)], ['a'.repeat(37)], [''],
    ['8C8C1971-6462-4016-BE9B-DBBBD9DCB0C6', 'extra']];
  for (const entry of ['agentui-ios', 'apps/ios/native/run.sh', 'apps/ios/native/verify.sh']) {
    for (const args of invalidArguments) {
      const result = spawnSync('/bin/bash', [entry, ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 1, `${entry} ${args}: ${result.stderr}`);
      assert.match(result.stderr, /Supply one simulator UDID/);
      assert.equal(result.stdout, '');
    }
  }
});

test('simulator UUID parsing accepts either case and returns the canonical uppercase identifier', () => {
  for (const input of ['8c8c1971-6462-4016-be9b-dbbbd9dcb0c6', '8C8C1971-6462-4016-BE9B-DBBBD9DCB0C6']) {
    const result = spawnSync('/bin/bash', ['-c', 'source apps/ios/native/common.sh; require_simulator "$1"', 'parse', input],
      { cwd: root, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '8C8C1971-6462-4016-BE9B-DBBBD9DCB0C6');
  }
});

test('native build source snapshots track build inputs and ignore unrelated review changes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agentui-ios-source-'));
  try {
    mkdirSync(join(fixture, 'apps/ios/native'), { recursive: true });
    mkdirSync(join(fixture, 'reviews'));
    writeFileSync(join(fixture, 'apps/ios/native/common.sh'), read('apps/ios/native/common.sh'));
    writeFileSync(join(fixture, 'apps/ios/native/input.txt'), 'initial');
    writeFileSync(join(fixture, 'README.md'), 'initial');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
    const git = (args) => execFileSync('git', args, { cwd: fixture, env, stdio: 'pipe' });
    git(['init', '--quiet']);
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    const snapshot = (snapshotEnv = env) => execFileSync('/bin/bash', ['-c', 'set -euo pipefail; source apps/ios/native/common.sh; ios_source_snapshot'],
      { cwd: fixture, env: snapshotEnv, encoding: 'utf8' });
    const before = snapshot();
    writeFileSync(join(fixture, 'README.md'), 'unrelated change');
    writeFileSync(join(fixture, 'reviews/result.md'), 'unrelated review');
    assert.equal(snapshot(), before);
    writeFileSync(join(fixture, 'apps/ios/native/input.txt'), 'changed build input');
    assert.notEqual(snapshot(), before);
    writeFileSync(join(fixture, 'apps/ios/native/input.txt'), 'initial');
    writeFileSync(join(fixture, 'apps/ios/native/new-input.txt'), 'new build input');
    assert.notEqual(snapshot(), before);
    rmSync(join(fixture, 'apps/ios/native/new-input.txt'));
    const globalConfig = join(fixture, 'global-config');
    const excludes = join(fixture, 'global-excludes');
    const externalDiff = join(fixture, 'external-diff');
    writeFileSync(excludes, 'globally-ignored.txt\n');
    writeFileSync(externalDiff, '#!/bin/sh\necho constant\n');
    chmodSync(externalDiff, 0o755);
    writeFileSync(globalConfig, `[core]\n\texcludesFile = ${excludes}\n[commit]\n\tgpgSign = true\n`);
    const hostileEnv = { ...env, GIT_CONFIG_GLOBAL: globalConfig, GIT_EXTERNAL_DIFF: externalDiff };
    writeFileSync(join(fixture, 'apps/ios/native/input.txt'), 'first change');
    const first = snapshot(hostileEnv);
    writeFileSync(join(fixture, 'apps/ios/native/input.txt'), 'second change');
    assert.notEqual(snapshot(hostileEnv), first);
    const withoutUntracked = snapshot(hostileEnv);
    writeFileSync(join(fixture, 'apps/ios/native/globally-ignored.txt'), 'input');
    assert.notEqual(snapshot(hostileEnv), withoutUntracked);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verification preserves completed evidence on failure and records the build receipt', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agentui-ios-verify-'));
  try {
    const native = join(fixture, 'apps/ios/native');
    const work = join(native, '.work');
    const product = join(work, 'build/Build/Products/Release-iphonesimulator/AgentUI.app');
    const installed = join(fixture, 'installed');
    const bin = join(fixture, 'bin');
    for (const dir of [product, installed, bin, join(work, 'evidence')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(native, 'verify.sh'), read('apps/ios/native/verify.sh'));
    writeFileSync(join(native, 'run.sh'), read('apps/ios/native/run.sh'));
    writeFileSync(join(native, 'prepare.sh'), read('apps/ios/native/prepare.sh'));
    writeFileSync(join(native, 'common.sh'), `${read('apps/ios/native/common.sh')}\nios_source_snapshot() { echo snapshot; }\nios_bundle_id() { echo example.app; }\nios_bundle_executable() { echo AgentUI; }\n`);
    writeFileSync(join(work, 'build-source.txt'), 'snapshot\n');
    writeFileSync(join(work, 'build-simulator.txt'), '8C8C1971-6462-4016-BE9B-DBBBD9DCB0C6\n');
    writeFileSync(join(work, 'build-prepared-inputs.sha256'), 'receipt from build\n');
    writeFileSync(join(work, 'prepared-inputs.sha256'), 'later receipt\n');
    writeFileSync(join(work, 'evidence/previous.txt'), 'complete evidence');
    for (const dir of [product, installed]) {
      writeFileSync(join(dir, 'main.jsbundle'), 'bundle');
      writeFileSync(join(dir, 'AgentUI'), 'native executable');
    }
    const commands = {
      xcrun: `#!/bin/bash\ncase "$*" in\n  *"bootstatus"*) echo "$*" >> "$BOOT_LOG"; [[ "$*" == *' -b' && "\${FAIL_BOOT:-}" != 1 ]] || exit 1; if [[ "\${WAIT_BOOT:-}" == 1 ]]; then touch "$BOOT_READY"; while [[ ! -e "$BOOT_RELEASE" ]]; do /bin/sleep .05; done; fi;;\n  *"list devices"*) echo 8C8C1971-6462-4016-BE9B-DBBBD9DCB0C6;;\n  *get_app_container*) echo "$INSTALLED";;\n  *"simctl launch"*) echo 'example.app: 123';;\n  *"launchctl list"*) echo '123 0 UIKitApplication:example.app[abc]';;\n  *screenshot*) [[ "\${FAIL_SCREENSHOT:-}" != 1 ]] || exit 1; touch "\${@: -1}";;\nesac\n`,
      git: '#!/bin/sh\n[ "$1" = rev-parse ] && echo commit\nexit 0\n',
      node: '#!/bin/sh\nexit 0\n', lsof: '#!/bin/sh\nexit 1\n',
      sleep: '#!/bin/sh\nexit 0\n', sw_vers: '#!/bin/sh\nexit 0\n',
      xcodebuild: '#!/bin/sh\nexit 0\n', npm: '#!/bin/sh\nexit 0\n', pod: '#!/bin/sh\nexit 0\n',
    };
    for (const [name, contents] of Object.entries(commands)) {
      writeFileSync(join(bin, name), contents, { mode: 0o755 });
    }
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTALLED: installed, BOOT_LOG: join(fixture, 'boot.log') };
    const run = (extra = {}) => spawnSync('/bin/bash', [join(native, 'verify.sh'), '8C8C1971-6462-4016-BE9B-DBBBD9DCB0C6'],
      { cwd: fixture, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.notEqual(run({ FAIL_SCREENSHOT: '1' }).status, 0);
    assert.equal(readFileSync(join(work, 'evidence/previous.txt'), 'utf8'), 'complete evidence');
    writeFileSync(join(work, 'build-simulator.txt'), 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA\n');
    assert.match(run().stderr, /Run ios:run for this simulator/);
    writeFileSync(join(work, 'build-simulator.txt'), '8C8C1971-6462-4016-BE9B-DBBBD9DCB0C6\n');
    writeFileSync(join(installed, 'AgentUI'), 'different native executable');
    assert.match(run().stderr, /Installed native executable differs/);
    assert.equal(readFileSync(join(work, 'evidence/previous.txt'), 'utf8'), 'complete evidence');
    writeFileSync(join(installed, 'AgentUI'), 'native executable');
    const bootFailure = run({ FAIL_BOOT: '1' });
    assert.notEqual(bootFailure.status, 0);
    assert.match(bootFailure.stderr, /Unable to boot the simulator/);
    assert.equal(readFileSync(join(work, 'evidence/previous.txt'), 'utf8'), 'complete evidence');
    assert.match(readFileSync(join(fixture, 'boot.log'), 'utf8'), /bootstatus .* -b/);
    renameSync(join(work, 'evidence'), join(work, 'evidence.previous'));
    mkdirSync(join(work, 'evidence.lock'));
    assert.match(run().stderr, /remove .work\/evidence.lock and retry/);
    rmSync(join(work, 'evidence.lock'), { recursive: true });
    assert.notEqual(run({ FAIL_SCREENSHOT: '1' }).status, 0);
    assert.equal(readFileSync(join(work, 'evidence/previous.txt'), 'utf8'), 'complete evidence');
    const ready = join(fixture, 'ready');
    const release = join(fixture, 'release');
    const first = spawn('/bin/bash', [join(native, 'verify.sh'), '8C8C1971-6462-4016-BE9B-DBBBD9DCB0C6'],
      { cwd: fixture, env: { ...env, WAIT_BOOT: '1', BOOT_READY: ready, BOOT_RELEASE: release }, stdio: 'ignore' });
    const firstExit = new Promise((resolve) => first.once('exit', resolve));
    try {
      for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(existsSync(ready), 'first verification reached boot');
      const overlap = run();
      assert.notEqual(overlap.status, 0);
      assert.match(overlap.stderr, /Another preparation, build, or verification may be running/);
      const build = spawnSync('/bin/bash', [join(native, 'run.sh'), '8C8C1971-6462-4016-BE9B-DBBBD9DCB0C6'],
        { cwd: fixture, env, encoding: 'utf8' });
      assert.notEqual(build.status, 0);
      assert.match(build.stderr, /Another preparation, build, or verification may be running/);
      const prepare = spawnSync('/bin/bash', [join(native, 'prepare.sh')], { cwd: fixture, env, encoding: 'utf8' });
      assert.notEqual(prepare.status, 0);
      assert.match(prepare.stderr, /Another preparation, build, or verification may be running/);
      assert.equal(readFileSync(join(work, 'evidence/previous.txt'), 'utf8'), 'complete evidence');
    } finally {
      writeFileSync(release, 'release');
      assert.equal(await firstExit, 0);
    }
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const provenance = readFileSync(join(work, 'evidence/provenance.txt'), 'utf8');
    assert.match(provenance, /receipt from build/);
    assert.doesNotMatch(provenance, /later receipt/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('native run freezes the receipt that passed preparation validation', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agentui-ios-build-'));
  try {
    const native = join(fixture, 'apps/ios/native');
    const work = join(native, '.work');
    const product = join(work, 'build/Build/Products/Release-iphonesimulator/AgentUI.app');
    const bin = join(fixture, 'bin');
    for (const dir of [product, bin, join(native, 'ios')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(native, 'run.sh'), read('apps/ios/native/run.sh'));
    writeFileSync(join(native, 'common.sh'), `${read('apps/ios/native/common.sh')}\nios_source_snapshot() { echo snapshot; }\nios_bundle_id() { echo example.app; }\n`);
    writeFileSync(join(native, 'input'), 'prepared input');
    const receipt = execFileSync('shasum', ['-a', '256', 'input'], { cwd: native, encoding: 'utf8' });
    writeFileSync(join(work, 'prepared-inputs.sha256'), receipt);
    const commands = {
      node: '#!/bin/sh\nexit 0\n', xcrun: '#!/bin/sh\nif [ "${FAIL_INSTALL:-}" = 1 ] && [ "$2" = install ]; then exit 1; fi\nexit 0\n',
      xcodebuild: '#!/bin/sh\nif [ "${WAIT_BUILD:-}" = 1 ]; then touch "$BUILD_READY"; while [ ! -e "$BUILD_RELEASE" ]; do /bin/sleep .05; done; fi\n[ "${CHANGE_RECEIPT:-}" = 1 ] && echo changed > .work/prepared-inputs.sha256\necho bundle > .work/build/Build/Products/Release-iphonesimulator/AgentUI.app/main.jsbundle\n',
    };
    for (const [name, contents] of Object.entries(commands)) writeFileSync(join(bin, name), contents, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const run = (extra = {}) => spawnSync('/bin/bash', [join(native, 'run.sh'), '8C8C1971-6462-4016-BE9B-DBBBD9DCB0C6'],
      { cwd: fixture, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.notEqual(run({ FAIL_INSTALL: '1' }).status, 0);
    assert.equal(existsSync(join(work, 'build-source.txt')), false);
    assert.equal(existsSync(join(work, 'build-prepared-inputs.sha256')), false);
    assert.equal(existsSync(join(work, 'build-simulator.txt')), false);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(work, 'build-prepared-inputs.sha256'), 'utf8'), receipt);
    assert.equal(readFileSync(join(work, 'build-simulator.txt'), 'utf8'), '8C8C1971-6462-4016-BE9B-DBBBD9DCB0C6\n');
    const changed = run({ CHANGE_RECEIPT: '1' });
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /Preparation receipt changed during build/);
    assert.equal(existsSync(join(work, 'evidence.lock')), false);
    writeFileSync(join(work, 'prepared-inputs.sha256'), receipt);
    const ready = join(fixture, 'build-ready');
    const release = join(fixture, 'build-release');
    const first = spawn('/bin/bash', [join(native, 'run.sh'), '8C8C1971-6462-4016-BE9B-DBBBD9DCB0C6'],
      { cwd: fixture, env: { ...env, WAIT_BUILD: '1', BUILD_READY: ready, BUILD_RELEASE: release }, stdio: 'ignore' });
    const firstExit = new Promise((resolve) => first.once('exit', resolve));
    try {
      for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(existsSync(ready), 'build worker started');
      first.kill('SIGTERM');
      assert.notEqual(run().status, 0);
      assert.ok(existsSync(join(work, 'evidence.lock')));
    } finally {
      writeFileSync(release, 'release');
      assert.equal(await firstExit, 143);
    }
    assert.ok(existsSync(join(work, 'evidence.lock')));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
