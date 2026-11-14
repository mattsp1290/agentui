import { createRoot } from 'react-dom/client';
import { BrowserApplication } from './BrowserApplication.js';
import { ArtifactIdentity } from '../application/ArtifactIdentity.js';

const container = document.getElementById('root');
if (!container) throw new Error('Browser development root container is missing');
createRoot(container).render(<BrowserApplication artifact={<ArtifactIdentity />} />);
