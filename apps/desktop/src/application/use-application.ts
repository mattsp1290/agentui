import { useEffect, useState, useSyncExternalStore } from 'react';
import { createBrowserConnection } from '@agentui/client/service';
import { BrowserViewStorage } from './browser-storage.js';
import { createApplicationController } from './application-controller.js';
import { capturePageArtifact } from './page-artifact.js';
import type { ApplicationController, ApplicationSnapshot } from './application-controller.js';

export function useApplication(supplied?: ApplicationController): { readonly controller: ApplicationController; readonly snapshot: ApplicationSnapshot } {
  const [controller] = useState(() => supplied ?? createApplicationController({ createConnection: createBrowserConnection,
    ownedViewStorage: BrowserViewStorage, createId: () => crypto.randomUUID(), artifact: capturePageArtifact() }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    void controller.start();
    const close = () => { void controller.dispose(); };
    const resume = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener('pagehide', close);
    window.addEventListener('pageshow', resume);
    return () => { close(); window.removeEventListener('pagehide', close); window.removeEventListener('pageshow', resume); };
  }, [controller]);
  return { controller, snapshot };
}
