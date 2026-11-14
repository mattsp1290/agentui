import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCompileCases } from './support/compile.mjs';
import { protocolContract } from '../../../tests/protocol/fixtures/contracts.mjs';

assert.equal(new URL(protocolContract.file, new URL('../../../', import.meta.url)).href, import.meta.url);
test(protocolContract.test, () => assertCompileCases(protocolContract.compiler));
