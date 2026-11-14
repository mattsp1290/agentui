import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Text, Surface, TextField, ThemeScope } from '@agentui/ui-primitives/desktop';
import '@agentui/ui-primitives/styles.css';
import './fixture.css';

function Workbench() {
  const [appearance, setAppearance] = useState(undefined);
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(0);
  const [submissions, setSubmissions] = useState(0);
  return <ThemeScope appearance={appearance} data-testid="system">
    <header className="workbench-header">
      <strong>AgentUI <span className="separator">/</span> Theme workbench</strong>
      <nav aria-label="Appearance">
        {['System', 'Light', 'Dark'].map((name) => <Button key={name} tone="secondary"
          aria-pressed={name.toLowerCase() === (appearance ?? 'system')}
          onClick={() => setAppearance(name === 'System' ? undefined : name.toLowerCase())}>{name}</Button>)}
      </nav>
    </header>
    <div className="workspace">
      <aside aria-label="Example conversations">
        <Text variant="label">WORKSPACE</Text>
        <Text variant="title" as="h2">Make room for the work.</Text>
        <Text variant="muted">A reference for the conversation client we are building.</Text>
        <div className="thread-list">
          <Surface><Text variant="label">AgentUI defaults</Text><Text variant="muted">Theme and primitive fixtures</Text></Surface>
          <Text variant="muted">Agent integrations arrive in later tasks.</Text>
        </div>
        <Text variant="code">LOCAL DESIGN FIXTURE</Text>
      </aside>
      <main>
        <div className="conversation-heading"><Text variant="muted">DESIGN / FOUNDATIONS</Text><Text variant="title" as="h1">A clearer place to think.</Text></div>
        <Surface className="message">
          <Text variant="label">AgentUI</Text>
          <Text>The same colors and spacing belong on desktop and mobile. Each platform keeps its own controls.</Text>
          <Text variant="muted">Light and dark palettes, readable text, and keyboard focus are part of the default.</Text>
        </Surface>
        <section aria-label="Module override" className="override-example">
          <ThemeScope colors={{ accent: '#6d28d9', onAccent: '#ffffff' }} data-testid="override">
            <Surface><Text variant="label">A module can have its own accent.</Text><Text variant="muted">The surrounding conversation keeps its theme.</Text>
              <Button data-testid="module-button">Module action</Button>
            </Surface>
          </ThemeScope>
        </section>
        <Surface className="composer">
          <form onSubmit={(event) => { event.preventDefault(); setSubmissions(submissions + 1); }}>
            <TextField label="Message" placeholder="Explore the default controls" value={message} onChange={(event) => setMessage(event.target.value)} />
            <div className="actions">
              <Button tone="secondary" disabled>Attach file</Button>
              <Button tone="danger" onClick={() => setMessage('')}>Clear draft</Button>
              <Button data-testid="send" onClick={() => setSent(sent + 1)}>Send message</Button>
            </div>
          </form>
          <Text variant="muted" role="status">Actions {sent}. Form submissions {submissions}. This fixture runs no agents.</Text>
        </Surface>
        <footer><Text variant="muted">Original AgentUI primitives. Design patterns informed by T3 Code.</Text></footer>
      </main>
    </div>
  </ThemeScope>;
}

createRoot(document.getElementById('root')).render(<Workbench />);
