import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const throwingListener of [false, true]) {
  test(`unobserved hydration failure survives a child process with throwing subscriber ${throwingListener}`, () => {
    const fixtureUrl = new URL('./support.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { fixture } from ${JSON.stringify(fixtureUrl)};
      const { store } = fixture({ drafts: {
        async load() { throw new Error('storage unavailable'); },
        async save() { throw new Error('must not save'); },
      } });
      if (${throwingListener}) store.subscribe(() => { throw new Error('invalid subscriber'); });
      setTimeout(() => {
        assert.deepEqual(store.getSnapshot().connection, { kind: 'failed', reason: 'storage unavailable' });
      }, 10);
    `], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
  });
}
