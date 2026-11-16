import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import Landing from './Landing';
import '@fontsource-variable/unbounded';
import '@fontsource/dotgothic16/400.css';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';

// Public pre-launch site: app pages show the launch screen until the contracts are live.
const Soon = lazy(() => import('./Soon'));
const isAppPage = ['/app', '/claim', '/receipt'].includes(window.location.pathname.replace(/\/+$/, ''));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="grain" aria-hidden="true" />
    {isAppPage ? (
      <Suspense fallback={null}>
        <Soon />
      </Suspense>
    ) : (
      <Landing />
    )}
  </StrictMode>,
);
