import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('genuine first-party archives run with copied third-party runtime closure outside the checkout', t => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)), directory = realpathSync(mkdtempSync(join(tmpdir(), 'agentui-packed-reports-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages;
  const pinned = source => {
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    assert.equal(pkg.version, lock[relative(root, source)]?.version, 'copied dependency matches lockfile version');
  };
  const modules = join(directory, 'node_modules'); mkdirSync(join(modules, '@agentui'), { recursive: true });
  writeFileSync(join(directory, 'package.json'), '{"private":true,"type":"module"}');
  const firstParty = new Set(['contracts', 'protocol', 'sdk', 'host', 'example-generated-text-output']);
  for (const name of readdirSync(join(root, 'node_modules'))) {
    if (name.startsWith('.')) continue;
    if (name === '@agentui') {
      for (const child of readdirSync(join(root, 'node_modules', name))) {
        if (child.startsWith('switchboard-')) symlinkSync(realpathSync(join(root, 'node_modules', name, child)), join(modules, name, child), 'dir');
      }
    } else symlinkSync(realpathSync(join(root, 'node_modules', name)), join(modules, name), 'dir');
  }
  for (const source of ['packages/contracts', 'packages/protocol', 'packages/sdk', 'packages/host', 'examples/generated-text-output']) {
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: join(root, source), encoding: 'utf8' }));
    const target = join(modules, packed.name); mkdirSync(target, { recursive: true });
    execFileSync('tar', ['-xzf', join(directory, packed.filename), '--strip-components=1', '-C', target]);
    for (const file of packed.files) assert.deepEqual(readFileSync(join(target, file.path)), readFileSync(join(root, source, file.path)), 'archive bytes equal built package');
  }
  const hostLocal = join(root, 'packages/host/node_modules'), hostCopies = [];
  if (existsSync(hostLocal)) {
    for (const scope of readdirSync(hostLocal)) for (const name of readdirSync(join(hostLocal, scope))) { pinned(join(hostLocal, scope, name)); hostCopies.push(scope + '/' + name); }
    cpSync(hostLocal, join(modules, '@agentui/host/node_modules'), { recursive: true, dereference: true });
  }
  const consumer = readFileSync(new URL('./packed-consumer.mjs', import.meta.url), 'utf8');
  writeFileSync(join(directory, 'consumer.mjs'), consumer);
  writeFileSync(join(directory, 'trace.mjs'), `
    import { registerHooks } from 'node:module';
    import { writeFileSync } from 'node:fs';
    const urls = new Set();
    registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); urls.add(result.url); return result; } });
    process.on('exit', () => writeFileSync('resolved.json', JSON.stringify([...urls])));
  `);
  execFileSync(process.execPath, ['--import', './trace.mjs', 'consumer.mjs'], { cwd: directory, stdio: 'pipe' });
  const paths = JSON.parse(readFileSync(join(directory, 'resolved.json'), 'utf8')).filter(url => url.startsWith('file:')).map(fileURLToPath);
  const copies = new Map();
  for (const path of paths) {
    if (path.startsWith(directory + '/')) continue;
    const marker = '/node_modules/', at = path.lastIndexOf(marker);
    assert.ok(at >= 0, 'no checkout first-party runtime escape: ' + path);
    const tail = path.slice(at + marker.length).split('/'), name = tail[0].startsWith('@') ? tail.slice(0, 2).join('/') : tail[0];
    assert.ok(!name.startsWith('@agentui/') || name.startsWith('@agentui/switchboard-'), 'no first-party checkout escape');
    const source = path.slice(0, at + marker.length) + name;
    const destination = source.startsWith(join(root, 'node_modules') + '/') ? join(modules, relative(join(root, 'node_modules'), source)) : join(modules, name);
    pinned(source); copies.set(destination, source);
  }
  for (const name of readdirSync(modules)) {
    if (name === '@agentui') {
      for (const child of readdirSync(join(modules, name))) if (!firstParty.has(child)) rmSync(join(modules, name, child), { recursive: true, force: true });
    } else rmSync(join(modules, name), { recursive: true, force: true });
  }
  for (const [destination, source] of [...copies].sort(([a], [b]) => a.length - b.length)) {
    mkdirSync(dirname(destination), { recursive: true }); cpSync(source, destination, { recursive: true, dereference: true });
    assert.deepEqual(readFileSync(join(destination, 'package.json')), readFileSync(join(source, 'package.json')));
  }
  for (const path of ['reports.sqlite', 'host.sqlite', 'resolved.json']) rmSync(join(directory, path), { force: true });
  execFileSync(process.execPath, ['--import', './trace.mjs', 'consumer.mjs'], { cwd: directory, stdio: 'pipe' });
  for (const url of JSON.parse(readFileSync(join(directory, 'resolved.json'), 'utf8'))) if (url.startsWith('file:')) {
    const path = fileURLToPath(url); assert.ok(realpathSync(path).startsWith(directory + '/'), 'final runtime is entirely copied outside checkout');
    assert.equal(lstatSync(path).isSymbolicLink(), false);
  }
  t.diagnostic(`Five genuine first-party archives passed with ${copies.size} traced third-party copies (${[...copies.keys()].map(path => relative(modules, path)).join(', ')}) and ${hostCopies.length} host-local copies (${hostCopies.join(', ')}). This exercises a copied runtime closure, not npm installation of the complete declared dependency closure.`);
});
