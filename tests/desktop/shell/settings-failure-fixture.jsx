import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserApplication } from '../../../apps/desktop/src/shell/BrowserApplication.tsx';
import '../../../apps/desktop/src/shell/styles.css';

function FailedLayout() {
  throw new Error('Intentional layout failure');
}

createRoot(document.getElementById('root')).render(<BrowserApplication><FailedLayout /></BrowserApplication>);
