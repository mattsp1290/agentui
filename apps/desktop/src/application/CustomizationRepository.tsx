import { useState } from 'react';
import type { CustomizationStatus } from '@agentui/contracts/service';
import type { ApplicationController } from './application-controller.js';
import { outcomeMessage } from './customization-messages.js';

const PROTECTED = new Set(['main', 'master']);

/** Settings section: connect, sync and disconnect the customization repository. Every change goes through the launcher's worker. */
export function CustomizationRepository({ controller, status, enabled }: {
  readonly controller: ApplicationController; readonly status: CustomizationStatus | null; readonly enabled: boolean;
}) {
  const [location, setLocation] = useState('');
  const [branch, setBranch] = useState('');
  const [subdirectory, setSubdirectory] = useState('');
  const [confirming, setConfirming] = useState<'connect' | 'disconnect' | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ readonly text: string; readonly failed: boolean } | null>(null);
  const offline = status !== null && status.support === 'worker-offline';
  const connection = status?.connection ?? null;
  const busy = saving || status?.pending !== null && status?.pending !== undefined;
  const controls = enabled && status !== null && !offline && !busy;
  const run = async (action: () => ReturnType<ApplicationController['syncCustomization']>, done: string) => {
    setConfirming(null);
    setSaving(true);
    setNotice(null);
    try {
      const outcome = await action();
      setNotice(outcome.kind === 'ok' ? { text: done, failed: false } : { text: outcomeMessage(outcome, controller.getSnapshot().customization), failed: true });
    } finally { setSaving(false); }
  };
  const connect = async () => {
    await run(() => controller.connectCustomization({ location: location.trim(), branch: branch.trim(), subdirectory: subdirectory.trim() }), 'Connected.');
    if (controller.getSnapshot().customization?.connection) { setLocation(''); setBranch(''); setSubdirectory(''); }
  };
  return <section className="settings-section customization-repository" aria-label="Customization repository">
    <h2>Customization repository</h2>
    {status === null ? <p>Reading the repository state…</p> : offline ? <>
      <p>The launcher is not connected, so the repository cannot be changed from here.</p>
      {connection && <dl className="customization-connection"><dt>Repository</dt><dd>{connection.location}</dd><dt>Branch</dt><dd>{connection.branch}</dd>
        {connection.subdirectory && <><dt>Subdirectory</dt><dd>{connection.subdirectory}</dd></>}</dl>}
    </> : connection ? <>
      <dl className="customization-connection">
        <dt>Repository</dt><dd>{connection.location}</dd>
        <dt>Branch</dt><dd>{connection.branch}</dd>
        {connection.subdirectory && <><dt>Subdirectory</dt><dd>{connection.subdirectory}</dd></>}
        <dt>Head</dt><dd><code>{status?.head?.slice(0, 12) ?? 'Unknown'}</code></dd>
      </dl>
      <div className="action-row">
        <button type="button" disabled={!controls} onClick={() => void run(() => controller.syncCustomization(), 'The repository is up to date.')}>Sync</button>
        <button type="button" disabled={!controls} onClick={() => setConfirming('disconnect')}>Disconnect</button>
      </div>
      {confirming === 'disconnect' && <div className="customization-confirm" role="group" aria-label="Confirm disconnect">
        <p>Disconnect this repository? The applied build keeps running until the next apply.</p>
        <button type="button" onClick={() => void run(() => controller.disconnectCustomization(), 'Disconnected.')}>Disconnect repository</button>
        <button type="button" onClick={() => setConfirming(null)}>Cancel</button>
      </div>}
    </> : <form className="customization-connect" onSubmit={event => {
      event.preventDefault();
      if (PROTECTED.has(branch.trim())) setConfirming('connect');
      else void connect();
    }}>
      <p>AgentUI clones the repository on the machine that runs the launcher, commits extension and settings changes to this branch, and pushes them with that user&rsquo;s git credentials.</p>
      <label>Repository<input name="repository" required value={location} disabled={!controls} onChange={event => setLocation(event.target.value)} /></label>
      <label>Branch<input name="branch" required placeholder="customization" value={branch} disabled={!controls} onChange={event => { setBranch(event.target.value); setConfirming(null); }} /></label>
      <label>Subdirectory<input name="subdirectory" placeholder="Optional" value={subdirectory} disabled={!controls} onChange={event => setSubdirectory(event.target.value)} /></label>
      <button type="submit" disabled={!controls || !location.trim() || !branch.trim()}>Connect</button>
      {confirming === 'connect' && <div className="customization-confirm" role="group" aria-label="Confirm branch">
        <p>AgentUI will push commits directly to {branch.trim()}.</p>
        <button type="button" onClick={() => void connect()}>Connect and push to {branch.trim()}</button>
        <button type="button" onClick={() => setConfirming(null)}>Cancel</button>
      </div>}
    </form>}
    <p role="status" className="customization-status">{busy ? 'Saving\u2026' : notice && !notice.failed ? notice.text : ''}</p>
    {notice?.failed && <p role="alert">{notice.text}</p>}
  </section>;
}
