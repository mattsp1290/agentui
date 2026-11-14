import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTheme } from '@agentui/theme';
import { toCssVariables } from '@agentui/ui-primitives/desktop';

test('stylesheets and derived variables reference defined theme tokens', async () => {
  const variables = toCssVariables(createTheme());
  const sources = [
    await readFile(fileURLToPath(import.meta.resolve('@agentui/ui-primitives/styles.css')), 'utf8'),
    await readFile(new URL('./fixture.css', import.meta.url), 'utf8'),
    ...Object.values(variables),
  ];
  let references = 0;
  for (const source of sources) {
    for (const match of source.matchAll(/var\((--aui-[\w-]+)/g)) {
      references += 1;
      assert.ok(Object.hasOwn(variables, match[1]), `Undefined theme variable ${match[1]}`);
    }
  }
  assert.ok(references > 0, 'the check inspected theme variable references');
});
