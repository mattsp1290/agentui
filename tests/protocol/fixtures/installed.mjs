import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import { createAguiProjection, describeProjection, aguiProtocol } from '@agentui/host/agui';
import { coverageContract } from './coverage.mjs';

const ref = (id, scope = ['fixture']) => ({ id, scope });
const bounds = { maxEntities: 64, maxPayloadBytes: 16384, maxJsonDepth: 24, maxJsonNodes: 2048 };
const { projectionFamilies, plannedFamilies } = coverageContract;
const schema = JSON.parse(readFileSync(new URL('./upstream/schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false });
ajv.addSchema(schema);
export function validateDefinition(name) {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  assert.equal(typeof validate, 'function', name);
  return validate;
}
export const validateEvent = validateDefinition('Event');

function mapped(projection, fact, count = 1) {
  const result = projection.accept(fact);
  assert.equal(result.kind, 'mapped', JSON.stringify(result));
  assert.equal(result.events.length, count, JSON.stringify(result.events));
  for (const event of result.events) {
    assert.equal(validateEvent(event), true, JSON.stringify(validateEvent.errors));
  }
  return result.events;
}

function actor({ start = true, sourceKey = 'agentui.fixture', runId = 'run' } = {}) {
  const made = createAguiProjection({ threadId: 'thread', runId, parentRunId: 'parent', sourceKey, bounds });
  assert.equal(made.kind, 'ok', JSON.stringify(made));
  if (start) mapped(made.value, { kind: 'run-started' });
  return made.value;
}

export const installedFixtures = {
  'lifecycle-text-tools'() {
    const projection = actor({ start: false });
    assert.deepEqual(mapped(projection, { kind: 'run-started', timestamp: 0 }), [{
      type: 'RUN_STARTED', threadId: 'thread', runId: 'run', parentRunId: 'parent',
      timestamp: 0, protocolVersion: aguiProtocol.version,
    }]);
    const owner = ref('same'), message = ref('same'), tool = ref('same');
    const [step] = mapped(projection, { kind: 'step-started', step: ref('step'), name: '' });
    assert.equal(step.type, 'STEP_STARTED');
    assert.deepEqual(step.metadata, { switchboard: { name: '' } });
    const [text] = mapped(projection, { kind: 'text-started', message, owner, role: 'assistant', name: '' });
    assert.equal(typeof text.subagentRunId, 'string');
    assert.notEqual(text.subagentRunId, '');
    assert.equal(text.role, 'assistant');
    assert.equal(text.name, '');
    const [empty] = mapped(projection, { kind: 'text-content', message, owner, delta: '' });
    const [content] = mapped(projection, { kind: 'text-content', message, owner, delta: 'hello' });
    assert.equal(empty.delta, '');
    assert.equal(content.delta, 'hello');
    assert.equal(content.messageId, text.messageId);
    assert.equal(content.subagentRunId, text.subagentRunId);
    const [call] = mapped(projection, { kind: 'tool-started', tool, owner, parentMessage: message, name: 'lookup' });
    assert.equal(call.type, 'TOOL_CALL_START');
    assert.equal(call.toolCallName, 'lookup');
    assert.equal(call.parentMessageId, text.messageId);
    assert.equal(call.subagentRunId, text.subagentRunId);
    assert.equal(new Set([text.messageId, call.toolCallId, text.subagentRunId]).size, 3);
    const [args] = mapped(projection, { kind: 'tool-arguments', tool, owner, delta: '{"n":0}' });
    assert.equal(args.delta, '{"n":0}');
    assert.equal(args.toolCallId, call.toolCallId);
    const [ended] = mapped(projection, { kind: 'tool-arguments-ended', tool, owner });
    assert.equal(ended.type, 'TOOL_CALL_END');
    assert.equal(ended.toolCallId, call.toolCallId);
    const [result] = mapped(projection, { kind: 'tool-result', tool, owner, resultMessage: ref('result'), content: 'observed failure' });
    assert.equal(result.type, 'TOOL_CALL_RESULT');
    assert.equal(result.toolCallId, call.toolCallId);
    assert.equal(result.content, 'observed failure');
    assert.notEqual(result.messageId, text.messageId);
    assert.equal(mapped(projection, { kind: 'text-ended', message, owner })[0].messageId, text.messageId);
    assert.equal(mapped(projection, { kind: 'step-finished', step: ref('step') })[0].stepName, step.stepName);
    assert.deepEqual(mapped(projection, { kind: 'run-finished', outcome: 'success' })[0].outcome, { type: 'success' });
    const other = actor({ sourceKey: 'another.source' });
    const same = actor();
    assert.equal(mapped(same, { kind: 'text-complete', message, role: 'assistant', text: '' }, 3)[0].messageId, text.messageId);
    same.close();
    const anotherRun = actor({ runId: 'another-run' });
    assert.equal(mapped(anotherRun, { kind: 'text-complete', message, role: 'assistant', text: '' }, 3)[0].messageId, text.messageId);
    anotherRun.close();
    const batch = mapped(other, { kind: 'text-complete', message, role: 'assistant', text: '' }, 3);
    const [plain] = batch;
    assert.deepEqual(batch.map(event => event.type), ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END']);
    assert.equal(batch[1].delta, '');
    assert.ok(batch.every(event => event.messageId === plain.messageId));
    assert.notEqual(plain.messageId, text.messageId);
    assert.equal('subagentRunId' in plain, false);
    const scoped = actor();
    assert.notEqual(mapped(scoped, { kind: 'text-complete', message: ref('same', ['other']), role: 'assistant', text: '' }, 3)[0].messageId, text.messageId);
    projection.close();
    other.close();
    scoped.close();
  },

  'state-activity-public-extensions'() {
    const projection = actor();
    for (const snapshot of [null, false, 0, '', [], { count: 0, done: false }]) {
      assert.deepEqual(mapped(projection, { kind: 'state-snapshot', snapshot })[0].snapshot, snapshot);
    }
    const delta = [
      { op: 'add', path: '/empty', value: null }, { op: 'replace', path: '/count', value: 0 },
      { op: 'remove', path: '/old' }, { op: 'move', from: '/a', path: '/b' },
      { op: 'copy', from: '/b', path: '/c' }, { op: 'test', path: '/done', value: false },
    ];
    assert.deepEqual(mapped(projection, { kind: 'state-delta', delta })[0].delta, delta);
    const message = ref('activity');
    const [snapshot] = mapped(projection, { kind: 'activity-snapshot', message, activityType: 'progress', content: { count: 0, done: false }, replace: false });
    assert.equal(snapshot.replace, false);
    assert.deepEqual(snapshot.content, { count: 0, done: false });
    const patch = [{ op: 'replace', path: '/done', value: true }];
    const [activity] = mapped(projection, { kind: 'activity-delta', message, activityType: 'progress', patch });
    assert.equal(activity.messageId, snapshot.messageId);
    assert.deepEqual(activity.patch, patch);
    const publicPayload = { count: 0, done: false, empty: null };
    const envelope = { namespace: 'example.progress', schemaVersion: '1', publicPayload };
    assert.deepEqual(mapped(projection, { kind: 'raw', ...envelope }), [{ type: 'RAW', source: envelope.namespace, event: envelope }]);
    assert.deepEqual(mapped(projection, { kind: 'custom', ...envelope, name: 'observed' }), [{ type: 'CUSTOM', name: 'observed', value: envelope }]);
    const [detached] = mapped(projection, { kind: 'state-snapshot', snapshot: publicPayload });
    publicPayload.count = 7;
    assert.equal(detached.snapshot.count, 0);
    projection.close();
  },

  'messages-and-opaque-content'() {
    const projection = actor();
    const parts = [
      { type: 'text', id: ref('part'), text: '', metadata: { count: 0 } },
      { type: 'image', source: { type: 'data', value: 'opaque-image', mimeType: 'image/png' } },
      { type: 'audio', source: { type: 'url', value: 'opaque-audio', mimeType: 'audio/wav' }, metadata: false },
      { type: 'video', source: { type: 'file', value: 'opaque-video', provider: 'native' } },
      { type: 'document', source: { type: 'file', value: 'opaque-file' }, metadata: ['citation'] },
    ];
    const messages = [
      { id: ref('developer'), role: 'developer', content: '' },
      { id: ref('system'), role: 'system', content: 'policy' },
      { id: ref('assistant'), role: 'assistant', content: '', encryptedValue: 'opaque-assistant', toolCalls: [
        { id: ref('call'), type: 'function', function: { name: 'lookup', arguments: '{partial' }, encryptedValue: 'opaque-call' },
      ] },
      { id: ref('user'), role: 'user', content: parts },
      { id: ref('tool'), role: 'tool', toolCallId: ref('call'), content: [{ type: 'image', source: { type: 'data', value: 'opaque-tool-image', mimeType: 'image/png' } }], error: 'observed error' },
      { id: ref('activity'), role: 'activity', activityType: 'progress', content: { done: false } },
      { id: ref('reasoning'), role: 'reasoning', content: 'opaque visible value', encryptedValue: 'opaque-reasoning' },
    ];
    const [snapshot] = mapped(projection, { kind: 'messages-snapshot', messages });
    assert.equal(snapshot.type, 'MESSAGES_SNAPSHOT');
    assert.deepEqual(snapshot.messages.map(item => item.role), messages.map(item => item.role));
    const [, , assistant, user, tool, activity, reasoning] = snapshot.messages;
    assert.equal(assistant.encryptedValue, 'opaque-assistant');
    assert.equal(assistant.toolCalls[0].encryptedValue, 'opaque-call');
    assert.deepEqual(assistant.toolCalls[0].function, { name: 'lookup', arguments: '{partial' });
    assert.equal(tool.toolCallId, assistant.toolCalls[0].id);
    assert.equal(tool.error, 'observed error');
    assert.deepEqual(tool.content, messages[4].content);
    assert.deepEqual(user.content.slice(1), parts.slice(1));
    assert.notEqual(user.content[0].id, parts[0].id.id);
    assert.equal(user.content[0].text, '');
    assert.deepEqual(user.content[0].metadata, { count: 0 });
    assert.deepEqual(activity.content, { done: false });
    assert.equal(reasoning.content, 'opaque visible value');
    assert.equal(reasoning.encryptedValue, 'opaque-reasoning');
    const [emptyTool] = mapped(projection, { kind: 'messages-snapshot', messages: [{ id: ref('tool'), role: 'tool', toolCallId: ref('call'), content: [] }] });
    assert.deepEqual(emptyTool.messages[0].content, []);
    assert.deepEqual(mapped(projection, { kind: 'messages-snapshot', messages: [] })[0].messages, []);
    projection.close();
  },

  'terminal-interrupts-usage'() {
    const usage = [{ provider: '', model: '', inputTokens: 0, outputTokens: 0, totalTokens: 0 }];
    for (const outcome of ['success', 'cancelled', 'interrupt']) {
      const projection = actor();
      const tool = ref('same'), owner = ref('same');
      const [call] = mapped(projection, { kind: 'tool-started', tool, owner, name: '' });
      mapped(projection, { kind: 'tool-arguments-ended', tool, owner });
      const fact = { kind: 'run-finished', outcome, usage, timestamp: 0, ...(outcome === 'success' ? { pendingTools: [tool] } : {}), ...(outcome === 'interrupt' ? {
        interrupts: [{ interrupt: ref('same'), tool, owner, reason: '', message: '', metadata: { zero: 0 }, responseSchema: { type: 'string' } }],
      } : {}) };
      const [finished] = mapped(projection, fact);
      assert.equal(finished.type, 'RUN_FINISHED');
      assert.equal(finished.threadId, 'thread');
      assert.equal(finished.runId, 'run');
      assert.equal(finished.outcome.type, outcome);
      if (outcome === 'success') assert.deepEqual(finished.outcome, { type: 'success', pendingToolCallIds: [call.toolCallId] });
      assert.deepEqual(finished.usage, usage);
      assert.equal(finished.timestamp, 0);
      if (outcome === 'interrupt') {
        assert.equal(finished.outcome.interrupts.length, 1);
        const [interrupt] = finished.outcome.interrupts;
        for (const id of [call.subagentRunId, interrupt.subagentRunId, interrupt.toolCallId]) {
          assert.equal(typeof id, 'string');
          assert.notEqual(id, '');
        }
        assert.equal(interrupt.toolCallId, call.toolCallId);
        assert.equal(interrupt.subagentRunId, call.subagentRunId);
        assert.equal(new Set([interrupt.id, interrupt.toolCallId, interrupt.subagentRunId]).size, 3);
        assert.equal(interrupt.reason, '');
        assert.equal(interrupt.message, '');
        assert.deepEqual(interrupt.metadata, { zero: 0 });
        assert.deepEqual(interrupt.responseSchema, { type: 'string' });
      }
      projection.close();
    }
    const failing = actor();
    assert.deepEqual(mapped(failing, { kind: 'run-failed', failure: 'transport-failure', usage }), [{
      type: 'RUN_ERROR', code: 'transport-failure', message: 'The native run transport failed.', usage,
    }]);
    failing.close();
    for (const result of [false, 0, '', null]) {
      const projection = actor();
      const [finished] = mapped(projection, { kind: 'run-finished', outcome: 'success', result });
      if (result === null) assert.equal('result' in finished, false);
      else assert.equal(finished.result, result);
      assert.equal('usage' in finished, false);
      projection.close();
    }
  },

  'availability-description'() {
    for (const family of projectionFamilies) {
      assert.deepEqual(describeProjection(family), { kind: 'ok', value: {
        family, representability: 'represented', availability: 'undeclared', qualification: 'undeclared',
      } });
    }
    for (const availability of ['supported', 'unsupported', 'unavailable', 'undeclared']) {
      assert.deepEqual(describeProjection('state', { availability, qualification: 'unqualified' }), { kind: 'ok', value: {
        family: 'state', representability: 'represented', availability, qualification: 'unqualified',
      } });
    }
    for (const family of plannedFamilies) {
      assert.deepEqual(describeProjection(family), { kind: 'error', error: { code: 'invalid-input' } });
    }
  },

  'terminal-ordering-limit'() {
    const projection = actor();
    assert.equal(mapped(projection, { kind: 'run-finished', outcome: 'success' })[0].type, 'RUN_FINISHED');
    assert.equal(mapped(projection, { kind: 'run-failed', failure: 'transport-failure' })[0].type, 'RUN_ERROR');
    projection.close();
  },

  'acknowledged-absence-and-fault'() {
    const projection = actor();
    for (const family of projectionFamilies) {
      assert.deepEqual(mapped(projection, { kind: 'not-observable', family }, 0), []);
    }
    assert.equal(mapped(projection, { kind: 'state-snapshot', snapshot: false })[0].snapshot, false);
    assert.equal(projection.close(), undefined);
    assert.equal(projection.close(), undefined);
    assert.deepEqual(projection.accept({ kind: 'run-finished', outcome: 'success' }), { kind: 'error', error: { code: 'closed' } });
    for (const fact of [
      ...['unknown-fact', 'reasoning-started', 'subagent-started'].map((kind) => ({ kind })),
      ...[...plannedFamilies, 'unknown-family'].map((family) => ({ kind: 'not-observable', family })),
    ]) {
      const rejected = actor();
      assert.deepEqual(rejected.accept(fact), { kind: 'error', error: { code: 'invalid-input' } });
      assert.deepEqual(rejected.accept({ kind: 'state-snapshot', snapshot: null }), { kind: 'error', error: { code: 'closed' } });
      rejected.close();
    }
  },
};
