import { Suspense, type ReactNode } from 'react';
import type { ConversationContentLayoutProps } from '@agentui/sdk/react';
import { CustomizationBoundary, type ContentLayoutSelection } from './DesktopCustomizations.js';

export function CustomizationContent({ selection, conversationKey, transcript, nativeTranscript, modules }: ConversationContentLayoutProps & {
  readonly selection: ContentLayoutSelection;
  readonly conversationKey: string;
  readonly nativeTranscript: ReactNode;
}) {
  const fallback = <>{transcript}{modules}</>;
  let content = fallback;
  if (selection.kind === 'conflict') {
    content = <><p role="alert">Content layout conflict. {selection.namespaces.join(', ')} claim the layout. The default arrangement remains active.</p>{fallback}</>;
  } else if (selection.kind === 'claimed') {
    const Layout = selection.owner.presentation.contentLayout;
    content = <Suspense fallback={<><p role="status">Content layout is loading. Module actions will return when it is ready.</p>{nativeTranscript}</>}>
      <CustomizationBoundary key={`${selection.owner.lifetime}/${conversationKey}`} fail={selection.owner.fail} fallback={nativeTranscript}>
        <Layout transcript={transcript} modules={modules} />
      </CustomizationBoundary>
    </Suspense>;
  }
  return <div className="conversation-content">{content}</div>;
}
