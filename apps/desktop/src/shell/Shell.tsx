import { Component, useState, type ReactNode } from 'react';
import { Button, Surface, Text, ThemeScope } from '@agentui/ui-primitives/desktop';

type ContentState = { readonly kind: 'ready' } | { readonly kind: 'failed' };

type ContentBoundaryProps = { readonly children: ReactNode; readonly revision: number };

class ContentBoundary extends Component<ContentBoundaryProps, ContentState> {
  override state: ContentState = { kind: 'ready' };

  static getDerivedStateFromError(): ContentState {
    return { kind: 'failed' };
  }

  override componentDidUpdate(previous: Readonly<ContentBoundaryProps>) {
    if (this.state.kind === 'failed' && previous.revision !== this.props.revision) this.setState({ kind: 'ready' });
  }

  override render() {
    if (this.state.kind === 'failed') {
      return <Surface className="landing" role="alert">
        <Text variant="title" as="h1">This view could not load.</Text>
        <Text>Your recovery controls are still available. Restore the default view to continue.</Text>
      </Surface>;
    }
    return this.props.children;
  }
}

function DefaultView() {
  return <div className="landing-grid">
    <section className="introduction" aria-labelledby="welcome-title">
      <Text variant="label">YOUR AGENTS. YOUR WORKSPACE.</Text>
      <Text variant="title" as="h1" id="welcome-title">A home for your conversations.</Text>
      <Text variant="muted">AgentUI brings your existing agents into a workspace you can make your own.</Text>
      <Surface className="connection-card">
        <div className="connection-heading"><span className="status-dot" /><Text as="h2" variant="label">No host connected</Text></div>
        <Text>Connect to the local Codex host on this Mac to open your conversations.</Text>
        <Button className="connect-host" onClick={() => window.location.assign('http://127.0.0.1:7140/browser.html')}>Connect to local Codex</Button>
        <Text variant="muted">Start the AgentUI Codex host first, then connect. Keep the host running while you work.</Text>
      </Surface>
    </section>
    <aside className="workspace-notes" aria-label="About this build">
      <div className="note-number">01</div>
      <Text as="h2" variant="label">Built around your agents</Text>
      <Text variant="muted">The local host uses your existing Codex installation and serves your conversations directly to this Mac.</Text>
      <div className="note-divider" />
      <div className="note-number">02</div>
      <Text as="h2" variant="label">A workspace you can change</Text>
      <Text variant="muted">Custom layouts can arrange your conversation and tools. Recovery controls belong to the app and remain outside the conversation view.</Text>
      <div className="build-label">LOCAL CODEX WORKSPACE</div>
    </aside>
  </div>;
}

export function DesktopShell({ children, defaultView, settingsView, extensionsView, workspaceOpen = false, protectedContent, navigation, activeView, onRestore, restoreMode = 'remount', status, buildLabel, appearance }: {
  readonly children?: ReactNode;
  readonly defaultView?: ReactNode;
  readonly settingsView?: ReactNode;
  readonly extensionsView?: ReactNode;
  /** An extension workspace owns the area right of the rail, so the sidebar column collapses. */
  readonly workspaceOpen?: boolean;
  readonly protectedContent?: ReactNode;
  readonly navigation?: ReactNode;
  readonly activeView?: 'chats' | 'extensions' | 'settings';
  readonly onRestore?: () => void;
  readonly restoreMode?: 'remount' | 'managed';
  readonly status?: ReactNode;
  readonly buildLabel?: string;
  /** Light or dark from the connected repository's settings; absent follows the system. */
  readonly appearance?: 'light' | 'dark';
}) {
  const [view, setView] = useState<{ readonly kind: 'initial' } | { readonly kind: 'default'; readonly revision: number }>({ kind: 'initial' });
  const boundaryKey = restoreMode === 'managed' ? 0 : view.kind === 'initial' ? 0 : view.revision;
  const revision = view.kind === 'initial' ? 0 : view.revision;
  const showSettings = settingsView !== undefined && activeView === 'settings';
  const showExtensions = extensionsView !== undefined && activeView === 'extensions';
  return <ThemeScope className="desktop-shell" {...(appearance ? { appearance } : {})} data-workspace-view={activeView} data-workspace-open={showExtensions && workspaceOpen ? 'true' : undefined}>
    <header className="shell-header">
      <div className="brand"><span className="brand-mark" aria-hidden="true">a</span><strong>AgentUI</strong><span className="platform-label">Desktop</span></div>
      <details className="recovery-menu"><summary>View options</summary><nav aria-label="Recovery controls">
        <Button tone="secondary" onClick={() => { onRestore?.(); setView((current) => ({ kind: 'default', revision: current.kind === 'default' ? current.revision + 1 : 1 })); }}>Restore default view</Button>
        <Button tone="secondary" onClick={() => window.location.reload()}>Reload app</Button>
      </nav></details>
    </header>
    {navigation}
    {protectedContent}
    <main id="main-content">
      <div className="shell-view" hidden={showSettings || showExtensions}>
        <ContentBoundary key={boundaryKey} revision={revision}>
          {view.kind === 'initial' ? children ?? defaultView ?? <DefaultView /> : defaultView ?? <DefaultView />}
        </ContentBoundary>
      </div>
      {settingsView !== undefined && <div className="shell-view" hidden={!showSettings}>
        <ContentBoundary key={`settings-${boundaryKey}`} revision={revision}>{settingsView}</ContentBoundary>
      </div>}
      {extensionsView !== undefined && <div className="shell-view" hidden={!showExtensions}>
        <ContentBoundary key={`extensions-${boundaryKey}`} revision={revision}>{extensionsView}</ContentBoundary>
      </div>}
    </main>
    <footer className="shell-footer"><span className="footer-status">{status ?? 'Disconnected'}</span><span>{buildLabel ?? 'Local app · No host connection'}</span></footer>
  </ThemeScope>;
}
