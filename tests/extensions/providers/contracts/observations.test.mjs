import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertCompileCases } from '../../../support/compile.mjs';

const fixture = await readFile(new URL('../../../application/fixtures/provider-observations.ts', import.meta.url), 'utf8');
test('controlled HTTP observation provider compiles against public SDK exports', () => assertCompileCases({ prefix: fixture, cases: [['', null]] }));
test('observation opt-in preserves model and installation boundaries', () => assertCompileCases({ prefix: `
import type { AguiModel, AguiObservations, AguiOriginalRun, ProviderContributions, BackendProvider, ProviderPresentation } from '@agentui/sdk';
declare const contributions: ProviderContributions;
declare const backend: BackendProvider<AguiModel, 'one'>;
declare const presentation: ProviderPresentation<AguiModel, 'one'>;
declare const mapper: AguiObservations<AguiModel, 'one'>;
declare const other: AguiOriginalRun<'two'>;
contributions.addAgui('one', backend, presentation);
contributions.addAgui('one', backend, presentation, mapper);
`, cases: [
  ['', null],
  ["const invalid: AguiOriginalRun<'one'> = other; void invalid;", /not assignable/],
  ["type Invalid = AguiObservations<{ request: { text: string }; state: null; event: null; cursor: string }, 'one'>;", /does not satisfy/],
  ["contributions.add('one', backend, presentation, mapper);", /Expected 3 arguments/],
  ["const invalid: AguiObservations<AguiModel, 'one'> = { event: () => [{ ...other, firstPosition: 1, events: [] }], snapshot: () => [] }; void invalid;", /not assignable/],
]}));
