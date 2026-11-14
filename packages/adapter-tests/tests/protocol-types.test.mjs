import { test } from 'node:test';
import { assertCompileCases } from './support/compile.mjs';
import { protocolContract } from '../../../tests/protocol/fixtures/contracts.mjs';

test(protocolContract.test, () => assertCompileCases(protocolContract.compiler));
