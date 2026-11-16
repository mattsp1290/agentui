import assert from 'node:assert/strict';
import test from 'node:test';
import { customizationMessage } from '../../apps/desktop/dist/application/DesktopCustomizations.js';

test('customization diagnostics preserve ordinary errors and the unknown-error fallback', () => {
  assert.equal(customizationMessage(new Error('Ordinary failure')), 'Ordinary failure');
  assert.equal(customizationMessage(new Error('')), '');
  for (const error of [null, undefined, 'Authored rejection', { message: 'Not an Error' }]) {
    assert.equal(customizationMessage(error), 'Customization failed.');
  }
});

test('customization diagnostics include nested aggregate reasons', () => {
  const primary = new AggregateError([new Error('Invalid tool name')], 'Registration failed');
  const error = new AggregateError([primary, new Error('Deferred cleanup rejected')], 'Activation failed');
  const message = customizationMessage(error);
  for (const reason of ['Activation failed', 'Registration failed', 'Invalid tool name', 'Deferred cleanup rejected']) assert.ok(message.includes(reason), message);
});

test('customization diagnostics terminate on authored aggregate cycles and retain sibling reasons', () => {
  const error = new AggregateError([], 'Authored failure');
  error.errors.push(error, new Error('Cleanup rejected'));
  assert.equal(customizationMessage(error), 'Authored failure Cleanup rejected');
});

test('malformed authored diagnostics cannot throw while publishing a failure', () => {
  for (const errors of [null, {}, 'Not a cause list']) {
    assert.match(customizationMessage(Object.assign(new AggregateError([], 'Authored failure'), { errors })), /Authored failure/);
  }
  const error = new AggregateError([], 'Authored failure');
  Object.defineProperty(error, 'errors', { get() { throw new Error('Cannot read causes'); } });
  assert.match(customizationMessage(error), /Authored failure/);
  for (const descriptor of [{ value: {} }, { get() { throw new Error('Cannot read message'); } }]) {
    assert.equal(customizationMessage(Object.defineProperty(new Error(), 'message', descriptor)), 'Customization failed.');
  }
});
