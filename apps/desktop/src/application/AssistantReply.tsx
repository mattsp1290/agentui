import { memo, useState, type ComponentProps } from 'react';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';

type CopyState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'copied' }
  | { readonly kind: 'failed' };

function CodeBlock({ code }: { readonly code: string }) {
  const [copy, setCopy] = useState<CopyState>({ kind: 'idle' });
  async function copyCode(): Promise<void> {
    setCopy({ kind: 'pending' });
    try {
      await navigator.clipboard.writeText(code);
      setCopy({ kind: 'copied' });
    } catch {
      setCopy({ kind: 'failed' });
    }
  }
  return <div className="reply-code-block">
    <div className="reply-code-actions">
      <button type="button" disabled={copy.kind === 'pending'} onClick={() => void copyCode()}>Copy code</button>
      <span role="status">{copy.kind === 'copied' ? 'Copied.' : copy.kind === 'failed' ? 'Copy unavailable. Select the code to copy.' : copy.kind === 'pending' ? 'Copying…' : ''}</span>
    </div>
    <pre><code>{code}</code></pre>
  </div>;
}

function CodePre({ node, children }: ComponentProps<'pre'> & ExtraProps) {
  const codeNode = node?.children.length === 1 ? node.children[0] : undefined;
  if (codeNode?.type !== 'element' || codeNode.tagName !== 'code') return <pre>{children}</pre>;
  let code = '';
  for (const child of codeNode.children) {
    if (child.type !== 'text') return <pre>{children}</pre>;
    code += child.value;
  }
  return <CodeBlock key={code} code={code} />;
}

const components = {
  pre: CodePre,
  a: ({ children, href }) => <span className="reply-destination">{children} ({href || 'Destination unavailable'})</span>,
  img: ({ alt, src }) => <span className="reply-destination">Image not loaded{alt ? `: ${alt}` : ''} ({src || 'Destination unavailable'})</span>,
} satisfies Components;

export const AssistantReply = memo(function AssistantReply({ text }: { readonly text: string }) {
  return <div className="assistant-reply"><Markdown components={components}>{text}</Markdown></div>;
});
