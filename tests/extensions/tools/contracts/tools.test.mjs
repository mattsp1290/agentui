import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendToolGeneration, pinFrontendTools } from '@agentui/sdk/tools';

const run = {
  conversation: { hostId: 'h', conversationId: 'c' },
  runId: 'r',
  authority: {
    kind: 'agentui-host',
    hostId: 'h',
    binding: { namespace: 'n', installationId: 'i', opaqueSessionId: 's' },
  },
};
const capabilities = { tools: { clientProvided: true } };
const pin = (generations, overrides = {}) =>
  pinFrontendTools({ generations, platform: 'desktop', run, capabilities, ...overrides });
const make = async (opts = {}) =>
  (
    await createFrontendToolGeneration({
      capture: () => undefined,
      namespace: 'demo',
      generation: '1',
      platform: 'desktop',
      activate({ frontendTools: tools }) {
        tools.add({
          definition: {
            name: 'text_length',
            description: 'count',
            parameters: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
          },
          decodeInput(x) {
            return x.text;
          },
          async execute(x) {
            return String(x.length);
          },
        });
        return { dispose() {} };
      },
      ...opts,
    })
  ).generation;

test('pins hold retired generations and active calls until they drain', async () => {
  let finish,
    disposed = 0;
  const a = await make({
    activate({ frontendTools: tools }) {
      tools.add({
        definition: { name: 'x', description: 'x' },
        decodeInput(x) {
          return x;
        },
        execute() {
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      });
      return {
        dispose() {
          disposed++;
        },
      };
    },
  });
  const p = pin([a]);
  const call = p.invoke('demo__x', {}, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '');
  const retired = a.retire();
  assert.equal(retired, a.retire());
  assert.throws(() => pin([a]), /Invalid or retired/u);
  p.release();
  p.release();
  assert.deepEqual(await p.invoke('demo__x', {}, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? ''), { kind: 'refused', code: 'released' });
  assert.equal(disposed, 0);
  finish('done');
  assert.equal((await call).output, 'done');
  await retired;
  assert.equal(disposed, 1);
  assert.throws(() => pin([a]));
});

test('old and new generations and multiple pins are independent', async () => {
  let disposed = 0;
  const a = await make({
    activate({ frontendTools: t }) {
      t.add({
        definition: { name: 'x', description: 'x' },
        decodeInput(x) {
          return x;
        },
        async execute() {
          return 'old';
        },
      });
      return {
        dispose() {
          disposed++;
        },
      };
    },
  });
  const p = pin([a]),
    q = pin([a]);
  const done = a.retire();
  const b = await make();
  const newer = pin([b]);
  assert.equal((await p.invoke('demo__x', {}, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')).output, 'old');
  assert.equal((await newer.invoke('demo__text_length', { text: 'abc' }, newer.bindings.find(binding => binding.name === 'demo__text_length')?.activationId ?? '')).output, '3');
  p.release();
  assert.equal(disposed, 0);
  q.release();
  await done;
  assert.equal(disposed, 1);
  newer.release();
  await b.retire();
});

test('schema, capability, snapshot, and receiver boundaries', async () => {
  class Tool {
    definition = {
      name: 'x',
      description: 'x',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    };
    prefix = 'ok';
    decodeInput(x) {
      return x.value;
    }
    async execute(x) {
      return this.prefix + x;
    }
  }
  const tool = new Tool();
  const g = await make({
    activate({ frontendTools: t }) {
      t.add(tool);
      return { dispose() {} };
    },
  });
  tool.definition.name = 'changed';
  const localRun = structuredClone(run);
  localRun.conversation.conversationId = 'snapshot';
  const p = pin([g], { run: localRun });
  localRun.conversation.conversationId = 'later';
  assert.equal(p.run.conversation.conversationId, 'snapshot');
  assert.equal(p.definitions[0].name, 'demo__x');
  assert.equal((await p.invoke('demo__x', { value: '!' }, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')).output, 'ok!');
  assert.equal((await p.invoke('demo__x', { value: 3 }, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')).code, 'invalid-arguments');
  for (const caps of [
    undefined,
    {},
    { tools: { clientProvided: false } },
    { tools: { clientProvided: true, supported: false } },
  ])
    assert.equal(pin([g], { capabilities: caps }).definitions.length, 0);
  assert.equal(pin([g], { platform: 'ios' }).definitions.length, 0);
  p.release();
  await g.retire();
});

test('invalid schemas poison registration and clean up', async (t) => {
  const cases = [
    ['empty id dependency collides with the root URI', { type: 'object', dependencies: { id: [] } }, /Unsupported tool schema/u],
    [
      'invalid schema',
      { type: 'object', properties: { x: { minimum: 'no' } } },
      /Invalid draft-07 schema/u,
    ],
    ['unknown keyword', { type: 'object', future: true }, /Unsupported schema keyword/u],
    ['nested ref', { type: 'object', properties: { x: { $ref: '#' } } }, /Unsupported schema keyword: \$ref/u],
    ['definitions', { type: 'object', definitions: { x: { type: 'string' } } }, /Unsupported schema keyword: definitions/u],
    [
      'root dialect',
      { type: 'object', $schema: 'http://json-schema.org/draft-06/schema#' },
      /Unsupported schema dialect/u,
    ],
    [
      'nested dialect',
      {
        type: 'object',
        properties: { x: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' } },
      },
      /Unsupported schema dialect/u,
    ],
    ['unsupported id', { type: 'object', $id: 'x' }, /Unsupported schema keyword/u],
    [
      'unknown format',
      { type: 'object', properties: { x: { type: 'string', format: 'uuid' } } },
      /Unsupported schema format/u,
    ],
  ];
  for (const [label, schema, expected] of cases)
    await t.test(label, async () => {
      let disposed = 0;
      await assert.rejects(
        make({
          activate({ frontendTools: tools }) {
            try {
              tools.add({
                definition: { name: 'x', description: 'x', parameters: schema },
                decodeInput(x) {
                  return x;
                },
                async execute() {
                  return '';
                },
              });
            } catch {}
            return {
              dispose() {
                disposed++;
              },
            };
          },
        }),
        expected,
      );
      assert.equal(disposed, 1);
    });
});

test('disposal rejection is shared without retry', async () => {
  let count = 0;
  const g = await make({
    activate() {
      return {
        dispose() {
          count++;
          throw new Error('failed');
        },
      };
    },
  });
  const a = g.retire();
  const b = g.retire();
  assert.equal(a, b);
  await assert.rejects(a, /failed/);
  await assert.rejects(b, /failed/);
  assert.equal(count, 1);
});

test('wire definition conforms to retained protocol Tool schema', async () => {
  const { readFile } = await import('node:fs/promises');
  const { default: Ajv } = await import('ajv/dist/2020.js');
  const schema = JSON.parse(await readFile('tests/protocol/fixtures/upstream/schema.json', 'utf8'));
  const validate = new Ajv({ strict: false }).compile({ ...schema, $ref: '#/$defs/Tool' });
  const g = await make();
  const p = pin([g]);
  assert.equal(validate(p.definitions[0]), true, JSON.stringify(validate.errors));
  p.release();
  await g.retire();
});

test('rejects malformed public definitions and generation identity', async () => {
  for (const definition of [
    { name: 'x' },
    { name: 'x', description: 3 },
    { name: 'x', description: 'x', parameters: null },
    { name: 'x', description: 'x', extra: true },
    { name: 'x', description: 'x', metadata: null },
  ]) {
    await assert.rejects(
      make({
        activate({ frontendTools: t }) {
          t.add({
            definition,
            decodeInput(x) {
              return x;
            },
            async execute() {
              return '';
            },
          });
          return { dispose() {} };
        },
      }),
    );
  }
  await assert.rejects(make({ generation: '' }));
  await assert.rejects(make({ platform: 'web' }));
});

test('generation identity is captured before activation settles', async () => {
  let finish;
  const options = {
    capture: () => undefined,
    namespace: 'original',
    generation: 'one',
    platform: 'desktop',
    activate() {
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const creating = createFrontendToolGeneration(options);
  options.namespace = 'changed';
  options.generation = 'two';
  options.platform = 'ios';
  finish({ dispose() {} });
  const { generation: g } = await creating;
  assert.equal(g.namespace, 'original');
  assert.equal(g.generation, 'one');
  assert.equal(g.platform, 'desktop');
  assert.equal(Object.isFrozen(g), true);
  await g.retire();
});

test('registration rejects collisions and closes after activation', async () => {
  let add;
  const contribution = {
    definition: { name: 'x', description: 'x' },
    decodeInput(x) {
      return x;
    },
    async execute() {
      return '';
    },
  };
  await assert.rejects(
    make({
      activate({ frontendTools: t }) {
        t.add(contribution);
        t.add(contribution);
        return { dispose() {} };
      },
    }),
  );
  const g = await make({
    activate({ frontendTools: t }) {
      add = t.add;
      return { dispose() {} };
    },
  });
  assert.throws(() => add(contribution), /closed/);
  const other = await make();
  assert.throws(() => pin([g, other]), /Duplicate/);
  await g.retire();
  await other.retire();
});

test('arguments are not defaulted or coerced and decoder errors refuse', async () => {
  const g = await make({
    activate({ frontendTools: t }) {
      t.add({
        definition: {
          name: 'x',
          description: 'x',
          parameters: { type: 'object', properties: { n: { type: 'number', default: 4 } } },
        },
        decodeInput(x) {
          if (!('n' in x)) throw Error('missing');
          return x.n;
        },
        async execute(x) {
          return String(x);
        },
      });
      return { dispose() {} };
    },
  });
  const p = pin([g]);
  assert.equal((await p.invoke('demo__x', {}, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')).code, 'decode-failed');
  assert.equal((await p.invoke('demo__x', { n: '4' }, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')).code, 'invalid-arguments');
  p.release();
  await g.retire();
});

test('ios pins select ios generations and refuse unknown names', async () => {
  const g = await make({ platform: 'ios' });
  const p = pin([g], { platform: 'ios' });
  assert.equal((await p.invoke('demo__text_length', { text: 'hi' }, p.bindings.find(binding => binding.name === 'demo__text_length')?.activationId ?? '')).output, '2');
  assert.equal((await p.invoke('missing', {}, p.bindings.find(binding => binding.name === 'missing')?.activationId ?? '')).code, 'unknown-tool');
  p.release();
  await g.retire();
});

test('handler rejection drains an in-flight call and nonstring results reject', async () => {
  let reject,
    disposed = 0;
  const g = await make({
    activate({ frontendTools: t }) {
      t.add({
        definition: { name: 'x', description: 'x' },
        decodeInput(x) {
          return x;
        },
        execute() {
          return new Promise((_, fail) => {
            reject = fail;
          });
        },
      });
      return {
        dispose() {
          disposed++;
        },
      };
    },
  });
  const p = pin([g]);
  const call = p.invoke('demo__x', {}, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '');
  const retired = g.retire();
  p.release();
  reject(new Error('handler'));
  await assert.rejects(call, /handler/);
  await retired;
  assert.equal(disposed, 1);
  const other = await make({
    activate({ frontendTools: t }) {
      t.add({
        definition: { name: 'x', description: 'x' },
        decodeInput(x) {
          return x;
        },
        async execute() {
          return 3;
        },
      });
      return { dispose() {} };
    },
  });
  const q = pin([other]);
  await assert.rejects(q.invoke('demo__x', {}, q.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? ''), /string/);
  q.release();
  await other.retire();
});

test('registration captures methods and schema independently', async () => {
  const contribution = {
    definition: {
      name: 'x',
      description: 'x',
      parameters: { type: 'object', properties: { n: { type: 'string' } } },
    },
    decodeInput(x) {
      return x.n;
    },
    async execute(x) {
      return x;
    },
  };
  const g = await make({
    activate({ frontendTools: t }) {
      t.add(contribution);
      return { dispose() {} };
    },
  });
  contribution.definition.parameters.properties.n.type = 'number';
  contribution.decodeInput = () => 'changed';
  contribution.execute = async () => 'changed';
  const p = pin([g]);
  assert.equal((await p.invoke('demo__x', { n: 'original' }, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')).output, 'original');
  assert.equal((await p.invoke('demo__x', { n: 2 }, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')).code, 'invalid-arguments');
  p.release();
  await g.retire();
  await assert.rejects(make({ namespace: ['demo'] }));
});

test('activation reports registration and disposal failures', async () => {
  await assert.rejects(
    make({
      activate({ frontendTools: t }) {
        try {
          t.add({
            definition: {
              name: 'x',
              description: 'x',
              parameters: { type: 'object', future: true },
            },
            decodeInput(x) {
              return x;
            },
            async execute() {
              return '';
            },
          });
        } catch {}
        return {
          dispose() {
            throw Error('dispose boom');
          },
        };
      },
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0].message.includes('Unsupported schema keyword') &&
      error.errors[1].message === 'dispose boom',
  );
});

test('refusals and failed pins drain retired generations', async () => {
  let disposed = 0;
  const g = await make({
    activate({ frontendTools: t }) {
      t.add({
        definition: {
          name: 'x',
          description: 'x',
          parameters: { type: 'object', properties: { n: { type: 'number' } } },
        },
        decodeInput(x) {
          if (x.bad) throw Error('decode');
          return x;
        },
        async execute() {
          return 'ok';
        },
      });
      return {
        dispose() {
          disposed++;
        },
      };
    },
  });
  assert.throws(() => pin([g], { run: new Date() }));
  assert.throws(() => pin([Object.create(Object.getPrototypeOf(g))]), /Invalid or retired/);
  const p = pin([g]);
  const retired = g.retire();
  assert.equal((await p.invoke('demo__x', { n: 'bad' }, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')).code, 'invalid-arguments');
  assert.equal((await p.invoke('demo__x', { bad: true }, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')).code, 'decode-failed');
  assert.equal((await p.invoke('missing', {}, p.bindings.find(binding => binding.name === 'missing')?.activationId ?? '')).code, 'unknown-tool');
  p.release();
  assert.equal((await p.invoke('demo__x', {}, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')).code, 'released');
  await retired;
  assert.equal(disposed, 1);
});

test('rejected activation closes registration', async () => {
  let add;
  const tool = {
    definition: { name: 'x', description: 'x' },
    decodeInput(x) {
      return x;
    },
    async execute() {
      return '';
    },
  };
  await assert.rejects(
    make({
      activate({ frontendTools: t }) {
        add = t.add;
        t.add(tool);
        throw Error('activation');
      },
    }),
    /activation/,
  );
  assert.throws(() => add(tool), /closed/);
});

test('optional definitions and empty schemas preserve object arguments', async () => {
  for (const parameters of [
    undefined,
    {},
    { $schema: 'http://json-schema.org/draft-07/schema', type: 'object' },
  ]) {
    const g = await make({
      activate({ frontendTools: t }) {
        t.add({
          definition: { name: 'x', description: 'x', parameters, metadata: undefined },
          decodeInput(x) {
            return x;
          },
          async execute() {
            return 'ok';
          },
        });
        return { dispose() {} };
      },
    });
    const p = pin([g]);
    assert.equal((await p.invoke('demo__x', {}, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')).kind, 'completed');
    assert.equal((await p.invoke('demo__x', 'text', p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')).code, 'invalid-arguments');
    if (parameters === undefined || !Object.keys(parameters).length)
      assert.deepEqual(p.definitions[0].parameters, { type: 'object' });
    p.release();
    await g.retire();
  }
  for (const definition of [
    Object.assign({ name: 'x', description: 'x' }, { [Symbol('x')]: 1 }),
    { name: 'x', description: 'x', metadata: new Date() },
    {
      name: 'x',
      description: 'x',
      get metadata() {
        return {};
      },
    },
  ]) {
    await assert.rejects(
      make({
        activate({ frontendTools: t }) {
          t.add({
            definition,
            decodeInput(x) {
              return x;
            },
            async execute() {
              return '';
            },
          });
          return { dispose() {} };
        },
      }),
    );
  }
});

test('capture failure preserves disposal failure and captures disposal once', async () => {
  let reads = 0;
  const lifetime = {
    get dispose() {
      reads++;
      return function () {
        assert.equal(this, lifetime);
        throw Error('dispose');
      };
    },
  };
  await assert.rejects(
    createFrontendToolGeneration({
      namespace: 'demo',
      generation: '1',
      platform: 'desktop',
      activate() {
        return lifetime;
      },
      capture() {
        throw Error('capture');
      },
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.map((e) => e.message).join(',') === 'capture,dispose',
  );
  assert.equal(reads, 1);
});

test('run validation, property order, and reserved metadata', async () => {
  const g = await make({
    activate({ frontendTools: t }) {
      t.add({
        definition: {
          name: 'x',
          description: 'x',
          parameters: {
            type: 'object',
            properties: { zebra: { type: 'string' }, alpha: { type: 'string' } },
          },
        },
        decodeInput(x) {
          return x;
        },
        async execute() {
          return '';
        },
      });
      return { dispose() {} };
    },
  });
  const p = pin([g]);
  assert.deepEqual(Object.keys(p.definitions[0].parameters.properties), ['zebra', 'alpha']);
  p.release();
  for (const bad of [
    { ...run, authority: {} },
    { ...run, runId: '' },
    { ...run, conversation: {} },
  ])
    assert.throws(() => pin([g], { run: bad }));
  assert.throws(() => pin([g], { platform: 'web' }));
  await g.retire();
  await assert.rejects(
    make({
      activate({ frontendTools: t }) {
        t.add({
          definition: { name: 'x', description: 'x', metadata: { 'ag-ui': {} } },
          decodeInput(x) {
            return x;
          },
          async execute() {
            return '';
          },
        });
        return { dispose() {} };
      },
    }),
    /Reserved/u,
  );
});

test('disabled pins do not retain and concurrent calls drain', async () => {
  let disposed = 0;
  const finish = [];
  const g = await make({
    activate({ frontendTools: t }) {
      t.add({
        definition: { name: 'x', description: 'x' },
        decodeInput(x) {
          return x;
        },
        execute() {
          return new Promise((resolve) => finish.push(resolve));
        },
      });
      return {
        dispose() {
          disposed++;
        },
      };
    },
  });
  pin([g], { capabilities: undefined });
  pin([g], { platform: 'ios' });
  const p = pin([g]);
  const calls = [p.invoke('demo__x', {}, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? ''), p.invoke('demo__x', {}, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')];
  const retire = g.retire;
  const done = retire();
  p.release();
  finish[0]('one');
  await calls[0];
  assert.equal(disposed, 0);
  finish[1]('two');
  await calls[1];
  await done;
  assert.equal(disposed, 1);
});

test('vendored meta-schema matches official bytes', async () => {
  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { draft7 } = await import('../../../../packages/sdk/dist/draft-07.js');
  const bytes = await readFile('tests/extensions/tools/fixtures/draft-07.schema.json');
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '692e1d165e47afcb5f11b2ce1c639635ffa834035d6ecb6bcf3087481dae8404',
  );
  assert.deepEqual(JSON.parse(bytes), draft7);
});

test('captured contributions preserve identity and opaque provider bindings', async () => {
  const lifetime = { dispose() {} };
  const decoded = { modules: ['captured'] };
  const result = await createFrontendToolGeneration({
    namespace: 'demo',
    generation: 'label',
    platform: 'desktop',
    capture: () => decoded,
    activate() {
      return lifetime;
    },
  });
  assert.equal(result.contributions, decoded);
  const remote = {
    ...run,
    authority: {
      kind: 'remote-provider',
      binding: { namespace: 'example.crew', installationId: 'i', opaqueSessionId: 's' },
    },
  };
  const p = pin([result.generation], { run: remote });
  assert.deepEqual(p.run, remote);
  p.release();
  await result.generation.retire();
});

test('JSON snapshots preserve data without invoking hidden serialization hooks', async () => {
  let hookCalls = 0;
  const metadata = {};
  Object.defineProperty(metadata, 'toJSON', {
    value() {
      hookCalls++;
      return ['invalid metadata'];
    },
  });
  const args = { text: 'original' };
  Object.defineProperty(args, 'toJSON', {
    value() {
      hookCalls++;
      return { text: 'rewritten' };
    },
  });
  const generation = await make({
    activate({ frontendTools: tools }) {
      tools.add({
        definition: { name: 'x', description: 'x', metadata },
        decodeInput(value) {
          return value.text;
        },
        async execute(value) {
          return value;
        },
      });
      return { dispose() {} };
    },
  });
  const snapshot = pin([generation]);
  try {
    const result = await snapshot.invoke('demo__x', args, snapshot.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '');
    assert.equal(hookCalls, 0);
    assert.deepEqual(snapshot.definitions[0].metadata, {});
    assert.deepEqual(result, { kind: 'completed', output: 'original' });
  } finally {
    snapshot.release();
    await generation.retire();
  }
});


test('copied generation handles are refused without affecting the original', async () => {
  const g = await make();
  let p;
  try {
    assert.throws(() => pin([{ ...g }]), /Invalid or retired/u);
    p = pin([g]);
    assert.equal((await p.invoke('demo__text_length', { text: 'safe' }, p.bindings.find(binding => binding.name === 'demo__text_length')?.activationId ?? '')).output, '4');
  } finally {
    p?.release();
    await g.retire();
  }
});

test('registration error precedes capture failure and still disposes', async () => {
  let disposed = 0;
  let captures = 0;
  await assert.rejects(make({
    activate({ frontendTools: tools }) {
      try {
        tools.add({ definition: { name: 'x', description: 'x', parameters: { type: 'object', future: true } },
          decodeInput: value => value, async execute() { return ''; } });
      } catch {}
      return { dispose() { disposed++; } };
    },
    capture() { captures++; throw new Error('capture failed'); },
  }), /Unsupported schema keyword/u);
  assert.equal(disposed, 1);
  assert.equal(captures, 0);
});

test('property dependency named id works without references', async () => {
  const g = await make({
    activate({ frontendTools: tools }) {
      tools.add({ definition: { name: 'x', description: 'x', parameters: {
        type: 'object', properties: { id: { type: 'string' } }, dependencies: { id: ['name'] },
      } }, decodeInput: value => value, async execute() { return 'ok'; } });
      return { dispose() {} };
    },
  });
  const p = pin([g]);
  assert.equal((await p.invoke('demo__x', { id: 'x' }, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')).code, 'invalid-arguments');
  assert.equal((await p.invoke('demo__x', { id: 'x', name: 'name' }, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')).output, 'ok');
  p.release();
  await g.retire();
});

test('tool handlers require functions at registration', async () => {
  for (const field of ['decodeInput', 'execute']) {
    await assert.rejects(make({ activate({ frontendTools: tools }) {
      tools.add({ definition: { name: 'x', description: 'x' }, decodeInput: value => value,
        async execute() { return ''; }, [field]: 'invalid' });
    } }), /Tool requires decodeInput and execute functions/u);
  }
});

test('tool definition fields share one JSON budget after optional undefined normalization', async () => {
  await assert.rejects(make({ activate({ frontendTools: tools }) {
    tools.add({ definition: { name: 'x', description: 'a'.repeat(8_000_000), metadata: { text: 'b'.repeat(8_000_000) } },
      decodeInput: value => value, async execute() { return ''; } });
  } }), /JSON exceeds size limit/u);
  const g = await make({ activate({ frontendTools: tools }) {
    tools.add({ definition: { name: 'x', description: '', parameters: undefined, metadata: undefined },
      decodeInput: value => value, async execute() { return ''; } });
    return { dispose() {} };
  } });
  const p = pin([g]);
  assert.deepEqual(p.definitions, [{ name: 'demo__x', description: '', parameters: { type: 'object' } }]);
  p.release();
  await g.retire();
});

test('local schema references are unsupported', async () => {
  await assert.rejects(make({ activate({ frontendTools: tools }) {
    tools.add({ definition: { name: 'x', description: '', parameters: { type: 'object', $ref: '#/properties/y', properties: { y: { type: 'string' } } } }, decodeInput: x => x, async execute() { return ''; } });
    return { dispose() {} };
  } }), /Unsupported schema keyword: \$ref/u);
});


test('activation options are callable before activation starts', async () => {
  let activated = false;
  await assert.rejects(make({ capture: 'no', activate() { activated = true; } }), /requires activate and capture/u);
  await assert.rejects(make({ activate: 'no' }), /requires activate and capture/u);
  assert.equal(activated, false);
});

test('annotation data may contain reference-shaped keys', async () => {
  const g = await make({ activate({ frontendTools: tools }) {
    tools.add({ definition: { name: 'x', description: '', parameters: { type: 'object', default: { $ref: '#', definitions: {} }, examples: [{ $ref: '#', definitions: {} }] } }, decodeInput: x => x, async execute() { return 'ok'; } });
    return { dispose() {} };
  } });
  const p = pin([g]);
  assert.equal((await p.invoke('demo__x', {}, p.bindings.find(binding => binding.name === 'demo__x')?.activationId ?? '')).output, 'ok');
  p.release();
  await g.retire();
});

test('pins bind immutable activation identities even when generation labels match', async () => {
  const effects = [];
  const activate = label => ({ frontendTools }) => {
    frontendTools.add({
      definition: { name: 'text_length', description: 'count' },
      decodeInput: value => value.text,
      async execute(text) { effects.push(label); return String(text.length); },
    });
    return { dispose() {} };
  };
  const first = await make({ activate: activate('original') });
  const second = await make({ activate: activate('replacement') });
  const oldPin = pin([first]), newPin = pin([second]);
  try {
    assert.notEqual(first.activationId, second.activationId);
    assert.deepEqual(await newPin.invoke('demo__text_length', { text: 'hello' }),
      { kind: 'refused', code: 'activation-mismatch' });
    assert.deepEqual(oldPin.bindings, [{ name: 'demo__text_length', activationId: first.activationId }]);
    assert.ok(Object.isFrozen(oldPin.bindings));
    assert.ok(Object.isFrozen(oldPin.bindings[0]));
    assert.deepEqual(await newPin.invoke('demo__text_length', { text: 'hello' }, first.activationId),
      { kind: 'refused', code: 'activation-mismatch' });
    assert.deepEqual(effects, []);
    assert.deepEqual(await oldPin.invoke('demo__text_length', { text: 'hello' }, first.activationId),
      { kind: 'completed', output: '5' });
    assert.deepEqual(effects, ['original']);
  } finally {
    oldPin.release(); newPin.release();
    await Promise.all([first.retire(), second.retire()]);
  }
});
