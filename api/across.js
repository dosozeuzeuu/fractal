// Across quote proxy (a Vercel serverless function at /api/across): forwards suggested-fees queries to
// Across server-side, so browsers never hit CORS limits and an optional ACROSS_API_KEY stays secret.
// Only the parameters fractal's private bridge needs are passed through.
const ACROSS = 'https://app.across.to/api/suggested-fees';
const ALLOWED = ['inputToken', 'outputToken', 'originChainId', 'destinationChainId', 'amount', 'recipient', 'message'];

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).send(JSON.stringify({ message: 'GET only' }));
  const q = new URLSearchParams();
  for (const k of ALLOWED) {
    const v = req.query[k];
    if (typeof v === 'string' && v.length <= 4096 && /^[0-9a-zA-Zx]+$/.test(v)) q.set(k, v);
  }
  try {
    const headers = process.env.ACROSS_API_KEY ? { Authorization: `Bearer ${process.env.ACROSS_API_KEY}` } : {};
    const r = await fetch(`${ACROSS}?${q}`, { headers });
    const text = await r.text();
    return res.status(r.status).send(text);
  } catch (e) {
    return res.status(502).send(JSON.stringify({ message: 'Across is unreachable right now' }));
  }
}
