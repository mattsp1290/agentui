import { useState, type ReactNode } from 'react';
import type { AgentDescriptor, CustomizationAppearance, CustomizationSettings, CustomizationStatus, ServiceMetadata } from '@agentui/contracts/service';
import type { ApplicationController } from './application-controller.js';
import { harness, harnessLabels, type Harness } from './ComposerAgentControls.js';
import { defaultAgentSelector, matchDefaultAgent } from './default-agent.js';
import { outcomeMessage } from './customization-messages.js';

const DEFAULT_SETTINGS: CustomizationSettings = { version: 1, appearance: 'system', showExtensionViews: true };
const APPEARANCES: readonly { readonly value: CustomizationAppearance; readonly label: string }[] = [
  { value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];
const selectorKey = (agent: AgentDescriptor) => { const selector = defaultAgentSelector(agent); return selector ? JSON.stringify(selector) : null; };

/** Appearance, default agent and extension views, stored in the connected repository's settings file. */
export function SettingsPreferences({ controller, status, metadata, enabled, children }: {
  readonly controller: ApplicationController; readonly status: CustomizationStatus | null; readonly metadata: ServiceMetadata | null; readonly enabled: boolean;
  readonly children?: ReactNode;
}) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const stored = status?.settings ?? null;
  const settings = stored ?? DEFAULT_SETTINGS;
  const writable = status?.support === 'supported' && status.connection !== null && status.head !== null;
  const controls = enabled && writable && !saving && status?.pending === null;
  const save = async (next: CustomizationSettings) => {
    setSaving(true);
    setNotice('');
    try {
      const outcome = await controller.saveSettings(next);
      if (outcome.kind !== 'ok') setNotice(outcomeMessage(outcome, controller.getSnapshot().customization));
    } finally { setSaving(false); }
  };
  // One option per distinct selector: agents a selector cannot tell apart share one option, named by their group.
  const ready = (metadata?.agents ?? []).filter(agent => agent.availability.kind === 'ready' && selectorKey(agent) !== null);
  const agents = ready.filter((agent, index) => ready.findIndex(other => selectorKey(other) === selectorKey(agent)) === index);
  const optionLabel = (agent: AgentDescriptor) => ready.filter(other => selectorKey(other) === selectorKey(agent)).length > 1 ? harnessLabels[harness(agent)] : agent.label;
  const groups = [...new Set(agents.map(agent => harness(agent)))] as Harness[];
  const storedAgent = settings.defaultAgent;
  const matched = storedAgent && metadata ? matchDefaultAgent(storedAgent, metadata) : null;
  const value = storedAgent ? JSON.stringify(storedAgent) : '';
  const listed = agents.some(agent => selectorKey(agent) === value);
  const unavailable = storedAgent !== undefined && (!matched || matched.availability.kind !== 'ready');
  return <section className="settings-section settings-preferences" aria-label="Appearance and defaults">
    <h2>Appearance</h2>
    {!writable && <p>Settings are stored in the connected customization repository. Connect one, with the launcher running, to change them.</p>}
    <div role="radiogroup" aria-label="Theme" className="appearance-choice">
      {APPEARANCES.map(choice => <label key={choice.value}><input type="radio" name="appearance" value={choice.value} checked={settings.appearance === choice.value}
        disabled={!controls} onChange={() => void save({ ...settings, appearance: choice.value })} />{choice.label}</label>)}
    </div>
    <label className="default-agent">Default agent
      <select value={value} disabled={!controls} onChange={event => {
        const { defaultAgent: _previous, ...rest } = settings;
        void save(event.target.value ? { ...rest, defaultAgent: JSON.parse(event.target.value) } : rest);
      }}>
        <option value="">Host default</option>
        {storedAgent && !listed && <option value={value}>{unavailable ? 'Unavailable on this host' : 'Saved agent'}</option>}
        {groups.map(group => <optgroup key={group} label={harnessLabels[group]}>
          {agents.filter(agent => harness(agent) === group).map(agent => <option key={agent.id} value={selectorKey(agent) ?? ''}>{optionLabel(agent)}</option>)}
        </optgroup>)}
      </select>
    </label>
    {unavailable && <p className="default-agent-unavailable">Unavailable on this host. New chats use the host default.</p>}
    <label><input type="checkbox" checked={settings.showExtensionViews} disabled={!controls}
      onChange={event => void save({ ...settings, showExtensionViews: event.target.checked })} />Show extension views</label>
    {children}
    <p role="status" className="customization-status">{saving ? 'Saving…' : ''}</p>
    {notice && <p role="alert">{notice}</p>}
  </section>;
}
