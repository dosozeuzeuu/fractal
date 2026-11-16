import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import Landing from './Landing';
import '@fontsource-variable/unbounded';
import '@fontsource/dotgothic16/400.css';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';

// VITE_PREVIEW builds the public site before the contracts are live: app pages show a launch screen,
// and the wallet/proving code is not bundled at all.
const Soon = lazy(() => import('./Soon'));
const pages = import.meta.env.VITE_PREVIEW
  ? { '/app': Soon, '/claim': Soon, '/receipt': Soon }
  : {
      '/app': lazy(() => import('./App')),
      '/claim': lazy(() => import('./Claim')),
      '/receipt': lazy(() => import('./Receipt')),
    };
const path = window.location.pathname.replace(/\/+$/, '') as keyof typeof pages;
const Page = pages[path];

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="grain" aria-hidden="true" />
    {Page ? (
      <Suspense fallback={<div className="app-shell"><p className="muted">Loading…</p></div>}>
        <Page />
      </Suspense>
    ) : (
      <Landing />
    )}
  </StrictMode>,
);
