// Diagnostics sink (a Vercel function at /api/report): the app posts which step of an action it
// reached and any error text, so failures in users' browsers show up in the Vercel runtime logs.
// Addresses, hashes and long numbers are stripped here as well as in the browser: nothing that
// identifies a wallet, note or amount is logged.
const clean = (s) =>
  String(s ?? '')
    .replace(/0x[0-9a-fA-F]{6,}/g, '0x…')
    .replace(/fx1[0-9a-z]{6,}/gi, 'fx1…')
    .replace(/\d{7,}/g, '#')
    .slice(0, 400);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('');
  let b = req.body;
  try { if (typeof b === 'string') b = JSON.parse(b); } catch { b = {}; }
  b = b || {};
  console.log(JSON.stringify({
    fractal: 'report',
    action: clean(b.action).slice(0, 40),
    stage: clean(b.stage).slice(0, 40),
    ms: Number.isFinite(b.ms) ? Math.round(b.ms) : undefined,
    message: clean(b.message),
    page: clean(b.page).slice(0, 40),
    isolated: Boolean(b.isolated),
    threads: Number.isFinite(b.threads) ? b.threads : undefined,
    ua: clean(req.headers['user-agent']).slice(0, 160),
  }));
  return res.status(204).send('');
}
