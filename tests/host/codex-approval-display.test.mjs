import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalItem, approvalPrompt, bounded, rememberApprovalItem } from '../../packages/host/dist/codex-approval-display.js';

const workspace = '/workspace';
const commandItem = { id: 'tool', type: 'commandExecution', command: 'printf from-item', cwd: '/workspace/item' };
const commandDetails = approvalItem(commandItem)[1];
const fileDetails = changes => approvalItem({ id: 'tool', type: 'fileChange', changes })[1];
const filePrompt = changes => approvalPrompt('file', {}, fileDetails(changes), workspace);

for (const { name, params, details = commandDetails, expected } of [
  { name: 'explicit command and cwd win', params: { command: 'printf explicit', cwd: '/explicit', reason: 'Permission' },
    expected: 'Run: printf explicit\nWorking directory: /explicit\n\nPermission' },
  { name: 'item command and cwd fill absent fields', params: {}, expected: 'Run: printf from-item\nWorking directory: /workspace/item' },
  { name: 'each field falls back independently', params: { command: 'printf explicit' }, expected: 'Run: printf explicit\nWorking directory: /workspace/item' },
  { name: 'blank and malformed fields use item details', params: { command: '  ', cwd: 7 }, expected: 'Run: printf from-item\nWorking directory: /workspace/item' },
  { name: 'missing item uses honest workspace fallback', params: {}, details: null, expected: 'Allow Codex to run a command?\nWorkspace: /workspace' },
  { name: 'file item cannot supply a command', params: {}, details: fileDetails([{ path: '/file', kind: { type: 'add' } }]),
    expected: 'Allow Codex to run a command?\nWorkspace: /workspace' },
  { name: 'cwd alone still describes permission', params: { cwd: '/request' }, details: null,
    expected: 'Allow Codex to run a command?\nWorking directory: /request' },
]) {
  test(`command display ${name}`, () => {
    assert.equal(approvalPrompt('command', params, details ?? undefined, workspace), expected);
  });
}

test('file display shows native kinds, moves, scope and reason with paths before patches', () => {
  const details = fileDetails([
    { path: '/old', kind: { type: 'update', move_path: '/new' }, diff: '-old\n+new' },
    { path: '/added', kind: { type: 'add' }, diff: '+created' },
    { path: '/deleted', kind: { type: 'delete' }, diff: '-removed' },
  ]);
  assert.equal(approvalPrompt('file', { grantRoot: '/grant', reason: 'Permission' }, details, workspace),
    'Allow Codex to change files?\nWrite access requested under: /grant\n\n/old (update) → /new\n/added (add)\n/deleted (delete)\n\n/old\n-old\n+new\n\n/added\n+created\n\n/deleted\n-removed\n\nPermission');
  assert.match(approvalPrompt('file', {}, commandDetails, workspace), /Workspace: \/workspace\n\nCodex did not provide file details\./);
});

for (const [name, changes] of [
  ['empty', []], ['null', null], ['missing', undefined], ['object', {}], ['string', 'changes'],
  ['malformed', [{ path: null, kind: null }]], ['null entry', [null]], ['empty path', [{ path: ' ' }]],
]) {
  test(`file display keeps ${name} details explicitly unavailable`, () => {
    assert.equal(filePrompt(changes), 'Allow Codex to change files?\nWorkspace: /workspace\n\nCodex did not provide file details.');
  });
}

for (const kind of ['new-protocol-kind', { type: 'new-protocol-kind' }, null, undefined]) {
  test(`file display preserves paths for unknown kind ${JSON.stringify(kind)}`, () => {
    assert.match(filePrompt([{ path: '/workspace/x', kind, diff: '+x' }]),
      /\/workspace\/x \(changed\) Codex did not provide file details\./);
  });
}

test('many-file display lists every path before separately bounded diffs', () => {
  const changes = Array.from({ length: 6 }, (_, index) => ({
    path: `/workspace/file-${index}.ts`, kind: { type: 'update' }, diff: '+++' + 'x'.repeat(2_497),
  }));
  const prompt = filePrompt(changes);
  const firstDiff = prompt.indexOf('+++');
  assert.ok(firstDiff >= 0);
  for (const { path } of changes) {
    const position = prompt.indexOf(`${path} (update)`);
    assert.ok(position >= 0 && position < firstDiff, `${path} is visible before diffs`);
  }
  assert.match(prompt, /Further details omitted/);
  assert.ok(Buffer.byteLength(JSON.stringify(prompt)) < 9_000);
});

for (const length of [1_989, 1_990, 1_991, 1_992]) {
  test(`file paths at length ${length} are visible or explicitly omitted at the byte boundary`, () => {
    const paths = ['/' + 'a'.repeat(length - 1), '/' + 'b'.repeat(length - 1), '/workspace/third.ts'];
    const prompt = filePrompt(paths.map(path => ({ path, kind: { type: 'update' } })));
    for (const path of paths) assert.ok(prompt.includes(path) || prompt.includes('[Further details omitted]'), `${path.slice(0, 20)} is visible or marked omitted`);
  });
}

test('file patch budget never silently drops a later diff at exactly 4000 escaped bytes', () => {
  const prompt = filePrompt([
    { path: '/a', kind: { type: 'update' }, diff: 'a'.repeat(1_990) },
    { path: '/b', kind: { type: 'update' }, diff: 'b'.repeat(1_998) },
    { path: '/c', kind: { type: 'update' }, diff: 'sentinel-c' },
  ]);
  assert.ok(prompt.includes('sentinel-c') || prompt.includes('[Further details omitted]'));
});

for (const text of ['🙂汉'.repeat(10_000), '"\\\n\u0000'.repeat(4_000)]) {
  test(`command display bounds ${text.startsWith('🙂') ? 'Unicode' : 'JSON escapes'} without splitting characters`, () => {
    const details = approvalItem({ ...commandItem, command: text, cwd: text })[1];
    const prompt = approvalPrompt('command', { reason: text }, details, workspace);
    assert.match(prompt, /Run:/);
    assert.match(prompt, /Further details omitted/);
    assert.ok(Buffer.byteLength(JSON.stringify(prompt)) < 12_200);
    assert.equal(prompt.isWellFormed(), true);
  });
}

for (const [text, limit, expected] of [
  ['🙂汉', 7, '🙂汉'], ['🙂汉', 6, '🙂\n[Further details omitted]'],
  ['a\n', 3, 'a\n'], ['a\n', 2, 'a\n[Further details omitted]'],
]) {
  test(`bounded text respects escaped bytes for ${JSON.stringify(text)} at ${limit}`, () => {
    assert.equal(bounded(text, limit), expected);
  });
}

for (const id of [null, 0, '', ' ', 'a'.repeat(4_001), 'x' + '\n'.repeat(2_000)]) {
  test(`uncacheable item ID ${typeof id} with length ${id?.length} is rejected without truncation`, () => {
    assert.equal(approvalItem({ ...commandItem, id }), null);
  });
}

test('cache preserves exact IDs and rejects unrelated item kinds', () => {
  for (const id of ['0', ' tool ', 'a'.repeat(4_000), 'x' + '\n'.repeat(1_999)]) {
    assert.equal(approvalItem({ ...commandItem, id })[0], id);
  }
  assert.equal(approvalItem({ id: 'tool', type: 'agentMessage', text: 'hello' }), null);
  assert.equal(approvalItem({ id: 'tool', type: 'commandExecution', cwd: '/cwd' })[1].cwd, '/cwd');
});

test('cache evicts the oldest insertion, refreshes updated items and leaves unmatched IDs empty', () => {
  const cache = new Map();
  for (let index = 0; index < 64; index++) rememberApprovalItem(cache, approvalItem({ ...commandItem, id: `item-${index}` }));
  rememberApprovalItem(cache, approvalItem({ ...commandItem, id: 'item-0', command: 'updated' }));
  rememberApprovalItem(cache, approvalItem({ ...commandItem, id: 'item-64' }));
  assert.equal(cache.size, 64);
  assert.equal(cache.get('item-0').command, 'updated');
  assert.equal(cache.has('item-1'), false);
  assert.equal(cache.has('item-64'), true);
  assert.equal(approvalPrompt('command', {}, cache.get('unmatched'), workspace), 'Allow Codex to run a command?\nWorkspace: /workspace');
});

test('empty command items cannot evict useful cached details', () => {
  const cache = new Map();
  rememberApprovalItem(cache, approvalItem(commandItem));
  for (const id of ['tool', ...Array.from({ length: 65 }, (_, index) => `empty-${index}`)]) {
    const item = approvalItem({ id, type: 'commandExecution', command: ' ', cwd: null });
    assert.equal(item, null);
    if (item) rememberApprovalItem(cache, item);
  }
  assert.equal(cache.size, 1);
  assert.equal(approvalPrompt('command', {}, cache.get('tool'), workspace), 'Run: printf from-item\nWorking directory: /workspace/item');
});
