import { useEffect, useRef, useState } from 'react';
import { EXTENSION_SDK_VERSION, type OutputId, type OutputListing, type OutputRead } from '@agentui/sdk';
import type { ConversationContentLayoutProps, ConversationModuleProps, ConversationOutputReader, UiExtensionEntry } from '@agentui/sdk/react';

type Result = OutputListing | OutputRead;
const readers: ConversationOutputReader[] = [], results: Result[] = [];
const probe: { readers: ConversationOutputReader[]; results: Result[]; settlements: number; instances: number; current: ConversationOutputReader | null; resume(): void; fail(): void; rerender(): void } = {
  readers, results, settlements: 0, instances: 0,
  current: null, resume: () => {}, fail: () => {}, rerender: () => {},
};
Object.assign(window, { outputProbe: probe });

export function Reports({ outputs, commands }: ConversationModuleProps) {
  const lifetime = useRef({ alive: false });
  type Request = { readonly owner: ConversationOutputReader; readonly lifetime: { alive: boolean } };
  const latest = useRef<Request | null>(null);
  type Feedback = { readonly request: Request } & ({ readonly kind: 'pending' } | { readonly kind: 'result'; readonly result: Result } | { readonly kind: 'error'; readonly error: string });
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [revision, setRevision] = useState(0);
  const [instance] = useState(() => ++probe.instances);
  const state = feedback?.request.owner === outputs && feedback.request.lifetime === lifetime.current ? feedback : null;
  const listing = state?.kind === 'result' && 'outputs' in state.result ? state.result.outputs : [];
  const output = listing[0];
  const selection = useRef<{ owner: ConversationOutputReader; id: OutputId } | null>(null);
  if (output) selection.current = { owner: outputs, id: output.outputId };
  const selected = selection.current?.owner === outputs ? selection.current.id : undefined;
  function query(operation: () => Promise<Result>) {
    const request = { owner: outputs, lifetime: lifetime.current };
    latest.current = request;
    setFeedback({ request, kind: 'pending' });
    function publish(next: Feedback) {
      if (request.lifetime.alive && latest.current === request) setFeedback(next);
    }
    void operation().then(result => {
      probe.results.push(result);
      publish({ request, kind: 'result', result });
    }, error => publish({ request, kind: 'error', error: String(error) })).finally(() => { probe.settlements++; });
  }
  useEffect(() => {
    const current = { alive: true }; lifetime.current = current;
    return () => { current.alive = false; };
  }, []);
  useEffect(() => {
    probe.current = outputs; probe.readers.push(outputs);
    if (new URLSearchParams(location.search).has('automatic')) query(() => outputs.list());
  }, [outputs]);
  useEffect(() => { probe.rerender = () => setRevision(value => value + 1); });
  const availability = commands.send.availability('Authored message');
  return <div data-testid="reports" data-instance={instance} data-revision={revision}>
    <button onClick={() => query(() => outputs.list())}>List outputs</button>
    <button disabled={!selected} onClick={() => { const id = selected; if (id) query(() => outputs.read(id)); }}>Read output</button>
    <button disabled={availability.kind === 'disabled'} onClick={() => void commands.send.run('Authored message')}>Inline send</button>
    {availability.kind === 'disabled' && <p>{availability.reason}</p>}
    <p data-testid="output-status">{state?.kind === 'pending' ? 'Reading…' : state?.kind === 'error' ? state.error
      : state?.kind === 'result' ? state.result.kind === 'available' ? 'outputs' in state.result ? `${state.result.outputs.length} outputs` : `${state.result.bytes.length} bytes` : state.result.kind : ''}</p>
  </div>;
}

function Layout({ transcript, modules }: ConversationContentLayoutProps) {
  const [state, setState] = useState<'ready' | 'suspended' | 'failed'>('ready');
  const held = useRef<Promise<void> | null>(null);
  useEffect(() => {
    probe.fail = () => setState('failed');
  }, []);
  if (state === 'failed') throw new Error('Authored layout failed');
  if (state === 'suspended' && held.current) throw held.current;
  function suspend() {
    held.current = new Promise<void>(resolve => {
      probe.resume = () => { held.current = null; resolve(); setState('ready'); };
    });
    setState('suspended');
  }
  return <div><button onClick={suspend}>Suspend layout</button>{transcript}{modules}</div>;
}

export default {
  kind: 'desktop', sdkVersion: EXTENSION_SDK_VERSION,
  activate() {
    return { contentLayout: Layout, modules: [{ id: 'reports', label: 'Reports', component: Reports,
      actions: [{ id: 'send', label: 'Authored send', availability: ({ commands }) => commands.send.availability('Authored message'),
        run: ({ commands }) => commands.send.run('Authored message') }] }], dispose() {} };
  },
} satisfies UiExtensionEntry<'desktop'>;
