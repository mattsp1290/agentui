import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '@agentui/contracts';
import { realFixture, request, rows } from './refresh-support.mjs';
import { syntheticResult, assertFits, assertExceeds, JSON_MAX_NODES } from './refresh-resource-support.mjs';

test('valid synthetic metadata history exceeds one JSON budget while each row stays usable', async t => {
  const f = await realFixture(t), evidence = [];
  f.setRun(async command => {
    const built = await syntheticResult(f, command);
    assertFits(built.job);
    evidence.push(built.job);
    return built.result;
  });
  let owner = await f.open();
  for (const id of ['first', 'second']) {
    const receipt = await owner.request(request(id, f.first, 1));
    assert.equal(receipt.job.build.kind, 'built');
    assert.equal(receipt.job.promotion.reason, 'revision-conflict');
  }
  assertExceeds(evidence);
  const stored = rows(f.database);
  stored.forEach(row => assert.equal(canonicalJson(JSON.parse(row.body)), row.body));
  for (const id of ['first', 'second']) assert.equal((await owner.inspect(id)).job.build.kind, 'built');
  await owner.close(); owner = await f.open();
  for (const id of ['first', 'second']) {
    assert.equal((await owner.inspect(id)).job.promotion.reason, 'revision-conflict');
    assert.equal((await owner.request(request(id, f.first, 1))).job.build.kind, 'built');
  }
  f.setRun(async () => ({ kind: 'failed', failure: 'unavailable' }));
  assert.equal((await owner.request(request('later', f.first))).job.build.failure, 'unavailable');
  assert.deepEqual(rows(f.database).slice(0, 2), stored);
  assert.equal(f.commands.length, 3); assert.equal(f.stops(), 0); assert.equal(f.replacements(), 0);
});

for (const [name, jobNodes] of [['job envelope', JSON_MAX_NODES + 1], ['later ordinary refusal', JSON_MAX_NODES], ['standalone manifest', undefined]]) {
  test(`valid synthetic metadata ${name} overflow is terminal before selection`, async t => {
    const f = await realFixture(t);
    let selects = 0;
    f.setRun(async command => {
      const built = await syntheticResult(f, command, jobNodes === undefined ? { files: 26000 } : { jobNodes });
      if (jobNodes === undefined) assertExceeds(built.result.manifest);
      else {
        assertFits(built.result.manifest);
        if (jobNodes > JSON_MAX_NODES) assertExceeds(built.job);
        else {
          assertFits(built.job);
          assertExceeds({ ...built.job, promotion: { ...built.job.promotion, kind: 'refused', reason: 'revision-conflict' } });
        }
      }
      return built.result;
    });
    let owner = await f.open();
    const select = owner.selection.select;
    owner.selection.select = async command => { selects++; return select(command); };
    const original = request('limit', f.first, 1);
    const receipt = await owner.request(original);
    assert.equal(receipt.job.build.kind, 'failed'); assert.equal(receipt.job.build.failure, 'resource-limit');
    assert.equal(receipt.job.promotion.kind, 'not-built');
    assert.deepEqual(await owner.inspect('limit'), receipt);
    assert.deepEqual(await owner.request(original), receipt);
    assert.equal(JSON.parse(rows(f.database)[0].body).build.failure, 'resource-limit');
    await assert.rejects(owner.promote('limit'), /not-built/);
    await owner.close(); owner = await f.open();
    assert.deepEqual(await owner.inspect('limit'), receipt);
    assert.deepEqual(await owner.request(original), receipt);
    assert.equal(owner.selection.status().desiredRevision, 0);
    assert.equal(f.commands.length, 1); assert.equal(selects, 0); assert.equal(f.stops(), 0); assert.equal(f.replacements(), 0);
    f.setRun(async () => ({ kind: 'failed', failure: 'unavailable' }));
    assert.equal((await owner.request(request('later', f.first))).job.build.failure, 'unavailable');
  });
}

test('valid synthetic metadata at the exact refused-row node limit remains promotable and reopenable', async t => {
  const f = await realFixture(t);
  f.setRun(async command => {
    const built = await syntheticResult(f, command, { jobNodes: JSON_MAX_NODES - 1 });
    assertFits(built.job);
    assertFits({ ...built.job, promotion: { ...built.job.promotion, kind: 'refused', reason: 'revision-conflict' } });
    return built.result;
  });
  let owner = await f.open();
  const original = request('exact-limit', f.first, 1), receipt = await owner.request(original);
  assert.equal(receipt.job.build.kind, 'built'); assert.equal(receipt.job.promotion.reason, 'revision-conflict');
  const before = rows(f.database);
  await owner.close(); owner = await f.open();
  assert.deepEqual(await owner.inspect(original.id), receipt);
  assert.deepEqual(await owner.request(original), receipt);
  assert.deepEqual(await owner.promote(original.id), receipt);
  assert.deepEqual(rows(f.database), before);
  assert.equal(f.commands.length, 1); assert.equal(f.stops(), 0); assert.equal(f.replacements(), 0);
});

test('a SQL error persisting resource-limit failure still stops the owner', async t => {
  const f = await realFixture(t);
  f.setRun(async command => (await syntheticResult(f, command, { jobNodes: JSON_MAX_NODES + 1 })).result);
  const owner = await f.open();
  f.database.exec(`CREATE TRIGGER reject_resource BEFORE UPDATE ON host_refresh_jobs
    WHEN json_extract(NEW.body, '$.build.failure')='resource-limit' BEGIN SELECT RAISE(ABORT, 'PRIVATE_RESOURCE_WRITE'); END`);
  await assert.rejects(owner.request(request('limit', f.first)), /^Error: Refresh unavailable$/);
  assert.equal(JSON.parse(rows(f.database)[0].body).build.kind, 'building');
  assert.equal(f.stops(), 1); assert.equal(f.commands.length, 1);
  await assert.rejects(owner.request(request('later', f.first)), /unavailable/);
  assert.equal(rows(f.database).length, 1);
});
