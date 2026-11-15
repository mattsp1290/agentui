import { useEffect, useId, useRef, useState } from 'react';
import type { AgentDescriptor } from '@agentui/contracts/service';
import { CLAUDE_SDK_RUNTIMES, CODEX_RUNTIME, CODEX_SDK_RUNTIME, PI_RUNTIME, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';

type Harness = 'pi' | 'claude' | 'codex' | 'recorded' | 'other';
type Picker = { readonly kind: 'closed' } | { readonly kind: 'harness' } | { readonly kind: 'model'; readonly harness: Harness };
const harnessLabels = { pi: 'Pi', claude: 'Claude', codex: 'Codex', recorded: 'Recorded', other: 'Local agent' };
const modelLabels = [
  { runtime: CODEX_RUNTIME, label: 'Host default' },
  { runtime: CODEX_SDK_RUNTIME, label: 'GPT-6.1 Sol' },
  { runtime: CLAUDE_SDK_RUNTIMES.opus, label: 'Opus' },
  { runtime: CLAUDE_SDK_RUNTIMES.sonnet, label: 'Sonnet' },
  { runtime: PI_RUNTIME, label: 'GLM 5.3' },
  { runtime: RECORDED_RUNTIME, label: 'No live model' },
];
function harness(agent: AgentDescriptor | null): Harness {
  switch (agent?.runtime.engine) {
    case 'pi': return 'pi';
    case 'claude-sdk': return 'claude';
    case 'codex': case 'codex-sdk': return 'codex';
    case 'agentui-recorded': return 'recorded';
    default: return 'other';
  }
}
function model(agent: AgentDescriptor | null): string {
  if (!agent) return 'Select model';
  return modelLabels.find(({ runtime }) => runtime.engine === agent.runtime.engine && runtime.version === agent.runtime.version && runtime.format === agent.runtime.format)?.label ?? agent.label;
}
function Chevron() {
  return <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>;
}

export function ComposerAgentControls({ agents, agent, hasConversation, enabled, onStartConversation }: {
  readonly agents: readonly AgentDescriptor[];
  readonly agent: AgentDescriptor | null;
  readonly hasConversation: boolean;
  readonly enabled: boolean;
  readonly onStartConversation: (agentId: string) => void;
}) {
  const [picker, setPicker] = useState<Picker>({ kind: 'closed' });
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const currentHarness = harness(agent);
  const currentModel = model(agent);
  const selectedHarness = picker.kind === 'model' ? picker.harness : currentHarness;
  const modelChoices = agent && !agents.some(entry => entry.id === agent.id) ? [agent, ...agents] : agents;
  const open = enabled && picker.kind !== 'closed';
  const groups: readonly Harness[] = ['pi', 'claude', 'codex', ...(['recorded', 'other'] satisfies Harness[]).filter(kind => agents.some(entry => harness(entry) === kind) || Boolean(agent && currentHarness === kind))];
  function close(restoreFocus = false): void {
    setPicker({ kind: 'closed' });
    if (restoreFocus) trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    dialog.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setPicker({ kind: 'closed' });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setPicker({ kind: 'closed' });
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, picker.kind]);
  useEffect(() => { if (!enabled) setPicker({ kind: 'closed' }); }, [enabled]);
  return <div className="composer-agent-controls" ref={root} role="group" aria-label="Chat settings" onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close();
  }}>
    <button type="button" className="composer-setting" aria-label={`Harness, ${agent ? harnessLabels[currentHarness] : 'Select harness'}`} aria-expanded={open && picker.kind === 'harness'} aria-controls={id} aria-haspopup="dialog" disabled={!enabled} onClick={event => {
      trigger.current = event.currentTarget;
      setPicker(previous => previous.kind === 'harness' ? { kind: 'closed' } : { kind: 'harness' });
    }}>{agent ? harnessLabels[currentHarness] : 'Harness'}<Chevron /></button>
    <button type="button" className="composer-setting" aria-label={`Model, ${currentModel}`} aria-expanded={open && picker.kind === 'model'} aria-controls={id} aria-haspopup="dialog" disabled={!enabled || !agent} onClick={event => {
      trigger.current = event.currentTarget;
      setPicker(previous => previous.kind === 'model' ? { kind: 'closed' } : { kind: 'model', harness: currentHarness });
    }}>{currentModel}<Chevron /></button>
    <button type="button" className="composer-setting composer-effort" aria-label="Effort, Default. Managed by the host." title="Effort is managed by the host. This host does not offer effort settings." disabled>Default<Chevron /></button>
    {open && <div id={id} ref={dialog} className="composer-picker" role="dialog" aria-label={picker.kind === 'harness' ? 'Choose harness' : 'Choose model'} tabIndex={-1}>
      <div className="composer-picker-heading"><strong>{picker.kind === 'harness' ? 'Harness' : `${harnessLabels[picker.kind === 'model' ? picker.harness : currentHarness]} models`}</strong><button type="button" aria-label="Close chat settings" onClick={() => close(true)}>×</button></div>
      <p>{hasConversation ? 'Choosing a different harness or model starts a new chat. Your draft stays here.' : 'Choose a harness and model to start a new chat.'}</p>
      <div className="composer-picker-options">
        {picker.kind === 'harness' ? groups.map(kind => {
          const entries = agents.filter(entry => harness(entry) === kind);
          const ready = entries.some(entry => entry.availability.kind === 'ready');
          const unavailable = entries.find(entry => entry.availability.kind === 'unavailable');
          const reason = unavailable?.availability.kind === 'unavailable' ? unavailable.availability.reason : 'Not configured on this host';
          return <button type="button" key={kind} className="composer-picker-option" disabled={!ready} aria-label={`${harnessLabels[kind]}${ready ? '' : ', unavailable'}`} title={ready ? undefined : reason} onClick={() => setPicker({ kind: 'model', harness: kind })}>
            <span>{harnessLabels[kind]}</span><small>{ready ? `${entries.filter(entry => entry.availability.kind === 'ready').length} available` : reason}</small><span className="picker-check" aria-hidden="true">{kind === currentHarness ? '✓' : '›'}</span>
          </button>;
        }) : modelChoices.filter(entry => harness(entry) === selectedHarness).map(entry => {
          const current = hasConversation && entry.id === agent?.id;
          const ready = entry.availability.kind === 'ready';
          return <button type="button" key={entry.id} className="composer-picker-option" disabled={!ready || current} aria-label={current ? `${entry.label}, current model` : `Start new chat with ${entry.label}`} aria-current={current ? 'true' : undefined} title={entry.availability.kind === 'unavailable' ? entry.availability.reason : undefined} onClick={() => {
            close();
            onStartConversation(entry.id);
          }}>
            <span>{model(entry)}</span><small>{entry.label}</small><small>{current ? 'Current' : entry.availability.kind === 'unavailable' ? entry.availability.reason : 'Start new chat'}</small>{current && <span className="picker-check" aria-hidden="true">✓</span>}
          </button>;
        })}
      </div>
    </div>}
  </div>;
}
