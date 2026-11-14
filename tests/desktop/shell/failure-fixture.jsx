import React from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopShell } from '../../../apps/desktop/src/shell/Shell.tsx';
import '../../../apps/desktop/src/shell/styles.css';

function FailedLayout() {
  throw new Error('Intentional content failure');
}

createRoot(document.getElementById('root')).render(<DesktopShell><FailedLayout /></DesktopShell>);
