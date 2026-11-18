import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { workingTreePlan } from '../../support/working-tree-plan.mjs';

const desktop = fileURLToPath(new URL('../../../apps/desktop/', import.meta.url));
async function contents(directory) {
  const files = await readdir(directory, { recursive: true, withFileTypes: true });
  return Promise.all(files.filter(file => file.isFile()).map(async file => {
    const path = join(file.parentPath, file.name);
    return { path, text: (await readFile(path)).toString('latin1') };
  }));
}
// What an extension leaves in a build: its manifest in the selection module, and its scoped workspace CSS and classes.
const markers = namespace => [`namespace:\`${namespace}\``, `"namespace":"${namespace}"`, `data-extension-workspace=${namespace}]`,
  `data-extension-workspace="${namespace}"]`, `.${namespace}-workspace`];
// The selection module's entries are `{manifest:{…},load:…}`; the committed empty selection emits none.
const selectionEntry = /\{manifest:\{/u;

test('the extension test bundle carries every working-tree extension, so the markers below are meaningful', async () => {
  const namespaces = workingTreePlan().entries.map(entry => entry.manifest.namespace);
  assert.ok(namespaces.length >= 2);
  const files = await contents(join(desktop, 'web-dist-extensions-test'));
  for (const namespace of namespaces) {
    for (const marker of [markers(namespace)[0], markers(namespace)[2]]) assert.ok(files.some(file => file.text.includes(marker)), `${namespace}: ${marker}`);
  }
  assert.ok(files.some(file => selectionEntry.test(file.text)));
});

for (const bundle of ['web-dist-browser', 'web-dist']) {
  test(`the product bundle ${bundle} contains no extension and an empty customization selection`, async () => {
    const files = await contents(join(desktop, bundle));
    assert.ok(files.length > 0);
    for (const { manifest } of workingTreePlan().entries) {
      for (const marker of markers(manifest.namespace)) {
        assert.deepEqual(files.filter(file => file.text.includes(marker)).map(file => file.path), [], `${bundle} holds ${marker}`);
      }
    }
    assert.deepEqual(files.filter(file => selectionEntry.test(file.text)).map(file => file.path), []);
  });
}
