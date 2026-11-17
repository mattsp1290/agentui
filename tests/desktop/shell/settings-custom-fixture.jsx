import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserApplication } from '../../../apps/desktop/src/shell/BrowserApplication.tsx';
import '../../../apps/desktop/src/shell/styles.css';

function CustomLayout() {
  return <label>Custom note <input /></label>;
}

createRoot(document.getElementById('root')).render(<BrowserApplication><CustomLayout /></BrowserApplication>);
