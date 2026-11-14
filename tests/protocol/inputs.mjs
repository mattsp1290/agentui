import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const retainedDir = 'tests/protocol/fixtures/upstream/';
const upstream = new URL('../../' + retainedDir, import.meta.url);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const provenanceBytes = readFileSync(new URL('provenance.json', upstream));
const provenance = JSON.parse(provenanceBytes);
const buffers = new Map();
for (const [file, input] of Object.entries(provenance.files)) {
  const bytes = readFileSync(new URL(file, upstream));
  assert.equal(digest(bytes), input.sha256, `Retained upstream input changed: ${file}`);
  buffers.set(file, bytes);
}
function verifiedBytes(file) {
  assert.ok(buffers.has(file), `Retained upstream input is not listed: ${file}`);
  return buffers.get(file);
}
function table(file) {
  const [header, ...lines] = verifiedBytes(file).toString('utf8').trimEnd().split('\n');
  const columns = header.split('\t');
  return lines.map((line) => {
    const cells = line.split('\t');
    assert.equal(cells.length, columns.length, `${file}: ${line}`);
    return Object.fromEntries(columns.map((column, index) => [column, cells[index]]));
  });
}
const pin = JSON.parse(verifiedBytes('ag-ui-pin.json'));
const schema = JSON.parse(verifiedBytes('schema.json'));
const definitions = table('ag-ui-matrix.tsv');
const fixtures = table('upstream.tsv').map(({ path, typescriptAccepts, pythonAccepts }) => {
  const [definition, validity] = path.split('/');
  assert.ok(['valid', 'invalid'].includes(validity), path);
  for (const accepted of [typescriptAccepts, pythonAccepts]) assert.ok(['true', 'false'].includes(accepted), `${path}: ${accepted}`);
  return { path, definition, valid: validity === 'valid', typescriptAccepts: typescriptAccepts === 'true', pythonAccepts: pythonAccepts === 'true' };
});

export const retained = { retainedDir, provenance, provenanceDigest: digest(provenanceBytes), pin, schema, definitions, fixtures };
