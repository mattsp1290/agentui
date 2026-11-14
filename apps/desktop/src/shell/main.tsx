import { createRoot } from 'react-dom/client';
import { DesktopShell } from './Shell.js';

const container = document.getElementById('root');
if (!container) throw new Error('Desktop root container is missing');
createRoot(container).render(<DesktopShell />);
