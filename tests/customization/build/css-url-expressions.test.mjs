import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceMap } from 'node:module';
import { build } from 'vite';
import { chromium } from 'playwright';
import { cssUrlExpressions } from '../../../scripts/lib/css-url-expressions.mjs';
import { repository, buildCustom } from './support.mjs';

test('relative CSS URL expressions retain precedence, bytes and source maps in Chromium', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentui-css-expressions-'));
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'style.css'), '.fixture { color: rgb(1, 2, 3); }');
  const cases = [
    ['single-use guard', "if (!style) throw new Error('valid CSS URL became falsy');\nglobalThis.probe = 'guard passed';", value => assert.equal(value, 'guard passed')],
    ['prefix and suffix', "globalThis.probe = 'prefix:' + style + ':suffix';", value => assert.match(value, /^prefix:http:.*\.css:suffix$/u)],
    ['template interpolation', 'globalThis.probe = `prefix:${style}:suffix`;', value => assert.match(value, /^prefix:http:.*\.css:suffix$/u)],
    ['tagged raw interpolation', 'globalThis.probe = String.raw`prefix\\n${style}suffix`;', value => assert.match(value, /^prefix\\nhttp:.*\.csssuffix$/u)],
    ['computed key', "globalThis.probe = Object.keys({[style]:'value'})[0];", value => assert.match(value, /^http:.*\.css$/u)],
    ['multiple markers and escapes', `globalThis.probe = 'quote:"\\n' + style + style + ':suffix';`, value => assert.match(value, /^quote:"\nhttp:.*\.csshttp:.*\.css:suffix$/u)],
  ];
  for (const minify of [false, true]) for (const [label, body, check] of cases) {
    await t.test(`${label}, minify ${minify}`, async () => {
      await writeFile(join(root, 'entry.js'), `import style from './style.css?url';\n${body}\n`);
      const result = await build({ root, configFile: false, base: './', logLevel: 'silent', plugins: [cssUrlExpressions()],
        build: { write: false, minify, sourcemap: true, assetsInlineLimit: 0, rolldownOptions: { input: join(root, 'entry.js') } } });
      const entry = result.output.find(file => file.type === 'chunk' && file.isEntry);
      const files = new Map(result.output.map(file => [`/nested/artifact/${file.fileName}`, file.type === 'chunk' ? file.code : file.source]));
      const server = createServer((request, response) => {
        if (request.url === '/nested/artifact/') { response.setHeader('Content-Type', 'text/html'); response.end(`<script type="module" src="./${entry.fileName}"></script>`); return; }
        const bytes = files.get(request.url);
        response.writeHead(bytes === undefined ? 404 : 200, { 'Content-Type': request.url.endsWith('.css') ? 'text/css' : 'text/javascript' });
        response.end(bytes);
      }).listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}/nested/artifact/`);
        await page.waitForFunction(() => globalThis.probe !== undefined);
        check(await page.evaluate(() => globalThis.probe));
        assert.deepEqual(errors, []);
        const css = result.output.find(file => file.type === 'asset' && file.fileName.endsWith('.css'));
        assert.equal(await page.evaluate(async path => (await fetch(path)).text(), `./${css.fileName}`), css.source);
        if (label === 'single-use guard') {
          const offset = entry.code.indexOf('guard passed'), before = entry.code.slice(0, offset).split('\n');
          const map = new SourceMap(JSON.parse(result.output.find(file => file.fileName === `${entry.fileName}.map`).source));
          const location = map.findEntry(before.length - 1, before.at(-1).length);
          assert.equal(location.originalLine, 2);
          assert.match(location.originalSource, /entry\.js$/u);
        }
      } finally { await page.close(); await new Promise(resolve => server.close(resolve)); }
    });
  }
});

test('pre-CSS grouping handles emitted keys and quasis without rewriting tagged raw text', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentui-css-ast-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'entry.js'), 'globalThis.probe = true;');
  let parse;
  await build({ root, configFile: false, logLevel: 'silent', plugins: [{ name: 'capture-chunk-parser', buildStart() { parse = this.parse.bind(this); } }],
    build: { write: false, rolldownOptions: { input: join(root, 'entry.js') } } });
  const marker = '__VITE_CSS_URL__ab12__', url = 'https://example.invalid/style.css';
  const run = source => {
    const transformed = cssUrlExpressions().renderChunk.handler.call({ parse, error(message) { throw new Error(message); } }, source);
    const code = transformed.code.replaceAll(marker, `"+${JSON.stringify(url)}+"`);
    return new Function(`${code}; return value;`)();
  };
  assert.equal(run(`const value = !'${marker}';`), false);
  assert.deepEqual(run(`const value = {'prefix:${marker}:suffix': 1};`), { [`prefix:${url}:suffix`]: 1 });
  assert.equal(run(`const value = new class { '${marker}' = 2; }()[${JSON.stringify(url)}];`), 2);
  assert.equal(run(`const value = \`raw\\n${marker}\${({toString(){return 'coerced'},valueOf(){throw Error('wrong hint')}})}suffix\`;`), `raw\n${url}coercedsuffix`);
  for (const count of [1, 2, 3, 4]) {
    const slashes = '\\'.repeat(count);
    assert.equal(run(`const value = \`prefix${slashes}${marker}suffix\`;`), `prefix${'\\'.repeat(Math.floor(count / 2))}${url}suffix`);
  }
  assert.throws(() => run(`const value = String.raw\`raw\\n${marker}\`;`), /tagged template raw text/u);
  assert.equal(cssUrlExpressions().renderChunk.handler.call({ parse() { throw new Error('unnecessary parse'); } }, "const value='__VITE_CSS_URL__nothex__';"), undefined);
});

test('committed custom artifact qualifies the original single-use CSS guard', { timeout: 30_000 }, t => {
  const f = repository();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.write('desktop/style.css', '.guard { color: red; }');
  f.write('desktop/index.tsx', `import style from './style.css?url';
    if(!style) throw new Error('valid CSS URL became falsy');
    export default {kind:'desktop',sdkVersion:'0.13.0',activate(){return {modules:[],dispose(){}}}};`);
  buildCustom(f, f.commit());
});
