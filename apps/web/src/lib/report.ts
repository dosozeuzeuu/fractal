/**
 * Beta diagnostics: tells /api/report which step of an action was reached and any error text.
 * Never sends addresses, amounts, keys or notes: hex strings and long numbers are stripped first.
 */
const clean = (s: unknown) =>
  String(s ?? '')
    .replace(/0x[0-9a-fA-F]{6,}/g, '0x…')
    .replace(/fx1[0-9a-z]{6,}/gi, 'fx1…')
    .replace(/\d{7,}/g, '#')
    .slice(0, 400);

export function report(action: string, stage: string, extra: { message?: unknown; ms?: number; threads?: number } = {}) {
  try {
    const body = JSON.stringify({
      action,
      stage,
      ms: extra.ms,
      threads: extra.threads,
      message: clean(extra.message instanceof Error ? extra.message.message : extra.message),
      page: location.pathname,
      isolated: globalThis.crossOriginIsolated === true,
    });
    if (!navigator.sendBeacon?.('/api/report', new Blob([body], { type: 'application/json' }))) {
      fetch('/api/report', { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => undefined);
    }
  } catch {
    /* diagnostics must never break the app */
  }
}

let installed = false;
export function installErrorReports() {
  if (installed) return;
  installed = true;
  addEventListener('error', (e) => report('page', 'error', { message: e.message }));
  addEventListener('unhandledrejection', (e) => report('page', 'unhandled', { message: (e.reason as Error)?.message ?? e.reason }));
}
