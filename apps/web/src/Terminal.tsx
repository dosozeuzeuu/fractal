import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatUnits, parseUnits, type Address } from 'viem';
import { CALL_GAS_SWAP, type OwnedNote, type PrivacyClient } from '@fractal/sdk';
import { Brand } from './components/Logo';
import { loadConfig, normalizeAmount, type AppConfig } from './lib/config';
import { installErrorReports, report } from './lib/report';
import { connectWallet } from './lib/wallet';
import { createClient, errorText, submitMode } from './lib/session';
import { chartUrl, search, terminalQuote, terminalRoute, tokenMeta, trending, usd, type Market } from './lib/terminal';

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const SWAP_OUT = 5; // NoteKind.SwapOut
const BUY_PRESETS = ['0.01', '0.05', '0.1', '0.5'];
const SELL_PRESETS = [25, 50, 100];
const SLIPPAGES = [100, 300, 1000]; // bps
type Status = { kind: 'busy' | 'ok' | 'error'; text: string } | null;

const num = (x: bigint, decimals: number, digits = 6) =>
  Number(formatUnits(x, decimals)).toLocaleString(undefined, { maximumFractionDigits: digits });

interface Position {
  token: Address;
  symbol: string;
  decimals: number;
  amount: bigint;
  valueEth: bigint | null;
  costEth: bigint;
  proceedsEth: bigint;
}

/** Cost and proceeds per token, from this wallet's own swap-output notes (spent or not). Local only. */
function costBasis(notes: OwnedNote[]) {
  const m = new Map<string, { cost: bigint; proceeds: bigint }>();
  const get = (t: string) => m.get(t) ?? { cost: 0n, proceeds: 0n };
  for (const n of notes) {
    if (n.kind !== SWAP_OUT) continue;
    if (n.memoToken === ZERO && n.token !== ZERO) {
      const k = n.token.toLowerCase();
      m.set(k, { ...get(k), cost: get(k).cost + n.memoAmount });
    } else if (n.token === ZERO && n.memoToken !== ZERO) {
      const k = n.memoToken.toLowerCase();
      m.set(k, { ...get(k), proceeds: get(k).proceeds + n.amount });
    }
  }
  return m;
}

export default function Terminal() {
  const [config, setConfig] = useState<AppConfig>();
  const [client, setClient] = useState<PrivacyClient>();
  const [active, setActive] = useState(false);
  const [notes, setNotes] = useState<OwnedNote[]>([]);
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());
  const [query, setQuery] = useState('');
  const [markets, setMarkets] = useState<Market[]>([]);
  const [marketsErr, setMarketsErr] = useState<string>();
  const [sel, setSel] = useState<Market>();
  const [meta, setMeta] = useState<{ symbol: string; decimals: number }>();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('0.05');
  const [slip, setSlip] = useState(SLIPPAGES[1]);
  const [privateGas, setPrivateGas] = useState(true);
  const [q, setQ] = useState<bigint | null>(null);
  const [qErr, setQErr] = useState<string>();
  const [positions, setPositions] = useState<Position[]>([]);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const syncing = useRef(false);

  useEffect(() => {
    installErrorReports();
    loadConfig().then(setConfig).catch((e) => setStatus({ kind: 'error', text: errorText(e) }));
  }, []);

  // Market list: trending, or search results (debounced).
  useEffect(() => {
    if (!config) return;
    setMarketsErr(undefined);
    const h = setTimeout(() => {
      (query.trim() ? search(config, query) : trending(config))
        .then((ms) => { setMarkets(ms); setSel((cur) => cur ?? ms.find((m) => m.tradable)); })
        .catch((e) => setMarketsErr(errorText(e)));
    }, query ? 300 : 0);
    return () => clearTimeout(h);
  }, [config, query]);

  const pc = client?.publicClient;

  useEffect(() => {
    setMeta(undefined);
    if (!config || !sel || !pc) return;
    tokenMeta(pc, config, sel.token, sel.symbol).then(setMeta).catch(() => setMeta({ symbol: sel.symbol, decimals: 18 }));
  }, [config, sel, pc]);

  const held = sel ? [...balances].find(([a]) => a.toLowerCase() === sel.token.toLowerCase())?.[1] ?? 0n : 0n;
  const inDecimals = side === 'buy' ? 18 : meta?.decimals ?? 18;
  const value = useMemo(() => {
    try {
      const v = parseUnits(normalizeAmount(amount) as `${number}`, inDecimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [amount, inDecimals]);

  // Live quote.
  useEffect(() => {
    setQ(null);
    setQErr(undefined);
    if (!config || !sel || !pc || !value || !sel.tradable) return;
    const h = setTimeout(() => {
      terminalQuote(pc, config, sel, side, value).then(setQ).catch((e) => setQErr(errorText(e)));
    }, 250);
    return () => clearTimeout(h);
  }, [config, sel, pc, side, value]);

  const refresh = useCallback(async (c?: PrivacyClient) => {
    const cl = c ?? client;
    if (!cl || !config || syncing.current) return;
    syncing.current = true;
    try {
      await cl.sync();
      const bal = new Map(cl.balances());
      setBalances(bal);
      setNotes([...cl.notes]);
      const basis = costBasis(cl.notes);
      // One row per token: balance keys are checksummed, cost-basis keys lowercase.
      const tokens = new Map<string, Address>();
      for (const k of basis.keys()) tokens.set(k, k as Address);
      for (const t of bal.keys()) if (t !== ZERO) tokens.set(t.toLowerCase(), t);
      const amountOf = (k: string) => [...bal].find(([a]) => a.toLowerCase() === k)?.[1] ?? 0n;
      const out: Position[] = [];
      for (const [t, token] of tokens) {
        const amt = amountOf(t);
        const m = await tokenMeta(cl.publicClient, config, token).catch(() => ({ symbol: 'TOKEN', decimals: 18 }));
        const known = markets.find((x) => x.token.toLowerCase() === t.toLowerCase());
        let valueEth: bigint | null = null;
        if (amt > 0n && known?.tradable) valueEth = await terminalQuote(cl.publicClient, config, known, 'sell', amt).catch(() => null);
        const b = basis.get(t.toLowerCase()) ?? { cost: 0n, proceeds: 0n };
        out.push({ token, symbol: m.symbol, decimals: m.decimals, amount: amt, valueEth, costEth: b.cost, proceedsEth: b.proceeds });
      }
      setPositions(out.filter((p) => p.amount > 0n || p.costEth > 0n));
    } finally {
      syncing.current = false;
    }
  }, [client, config, markets]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => refresh().catch(() => undefined), 15_000);
    return () => clearInterval(id);
  }, [active, refresh]);

  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(true);
    setStatus({ kind: 'busy', text: label });
    try {
      const done = await fn();
      setStatus(done ? { kind: 'ok', text: done } : null);
    } catch (e) {
      report('terminal', 'error', { message: errorText(e) });
      setStatus({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const connect = () =>
    run('Waiting for your wallet…', async () => {
      if (!config) throw new Error('Configuration has not loaded yet.');
      setClient(await createClient(config, await connectWallet(config)));
    });

  const activate = () =>
    run('Sign the message in your wallet to turn on privacy…', async () => {
      await client!.activate();
      setStatus({ kind: 'busy', text: 'Finding your notes…' });
      await refresh(client);
      setActive(true);
    });

  const trade = () =>
    run('Preparing…', async () => {
      if (!client || !config || !sel || !meta || !value || !config.swap) return;
      const fresh = await terminalQuote(client.publicClient, config, sel, side, value);
      const minOut = fresh - (fresh * BigInt(slip)) / 10_000n;
      const data = await terminalRoute(client.publicClient, config, sel);
      const mode = await submitMode(config, client, privateGas, CALL_GAS_SWAP);
      setStatus({ kind: 'busy', text: `Building your proof on this device${globalThis.crossOriginIsolated ? '' : ' (single-threaded here, up to a minute)'}; then sign in your wallet.` });
      const tokenIn = side === 'buy' ? ZERO : sel.token;
      const tokenOut = side === 'buy' ? sel.token : ZERO;
      const p = await client.prepare({ token: tokenIn, swap: { tokenOut, amountIn: value, minOut, adapter: config.swap.adapter, data }, mode });
      report('terminal', 'signed', { message: mode.kind });
      setStatus({ kind: 'busy', text: 'Submitting…' });
      await client.submit(p, mode);
      report('terminal', 'submitted');
      await new Promise((r) => setTimeout(r, mode.kind === 'bundler' ? 4000 : 0));
      await refresh();
      return side === 'buy'
        ? `Bought about ${num(fresh, meta.decimals, 2)} ${meta.symbol}. The chain shows the vault buying, not you.`
        : `Sold for about ${num(fresh, 18)} ETH, back in your private balance.`;
    });

  const outSymbol = side === 'buy' ? meta?.symbol ?? sel?.symbol ?? '' : 'ETH';
  const outDecimals = side === 'buy' ? meta?.decimals ?? 18 : 18;
  const chart = config && sel ? chartUrl(config, sel) : null;
  const visibleSender = !(config?.bundlerUrl && privateGas);

  return (
    <div className="term">
      <header className="term-top">
        <Brand />
        <span className="term-title">Private terminal</span>
        <span className="spacer" />
        {config && <span className={`tag ${config.devVerifier ? 'dev' : 'on'}`}>{config.name}</span>}
        {client && <span className="tag mono">{`${client.address.slice(0, 6)}…${client.address.slice(-4)}`}</span>}
        <a className="btn ghost" href="/app">Wallet</a>
      </header>

      <div className="term-grid">
        <aside className="panel term-list" aria-label="Markets">
          <label className="field" style={{ marginBottom: 10 }}>
            <span>Search a token or paste its address</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, symbol or 0x…" spellCheck={false} autoComplete="off" />
          </label>
          <p className="term-sub">{query.trim() ? 'Results' : 'Most traded against ETH'}</p>
          {marketsErr && <p className="status error">{marketsErr}</p>}
          <ul className="term-markets">
            {markets.map((m) => (
              <li key={m.token}>
                <button className={sel?.token === m.token ? 'on' : ''} onClick={() => { setSel(m); setStatus(null); }} aria-pressed={sel?.token === m.token}>
                  <span className="sym">{m.symbol}</span>
                  <span className="px">{usd(m.priceUsd)}</span>
                  <span className={`chg ${m.change24h !== undefined && m.change24h < 0 ? 'dn' : 'up'}`}>
                    {m.change24h === undefined ? '' : `${m.change24h > 0 ? '+' : ''}${m.change24h.toFixed(1)}%`}
                  </span>
                  <span className="meta">{m.tradable ? `vol ${usd(m.volume24h)}` : m.why}</span>
                </button>
              </li>
            ))}
            {!markets.length && !marketsErr && <li className="muted" style={{ padding: 12 }}>Loading markets…</li>}
          </ul>
        </aside>

        <section className="panel term-main" aria-label="Chart">
          {sel ? (
            <>
              <div className="term-head">
                <div>
                  <h1>{sel.symbol}</h1>
                  <p className="muted mono" style={{ margin: 0, fontSize: 13 }}>{sel.name} · {sel.dex}</p>
                </div>
                <dl className="term-stats">
                  <div><dt>Price</dt><dd>{usd(sel.priceUsd)}</dd></div>
                  <div><dt>24h</dt><dd>{sel.change24h === undefined ? '–' : `${sel.change24h.toFixed(1)}%`}</dd></div>
                  <div><dt>Liquidity</dt><dd>{usd(sel.liquidityUsd)}</dd></div>
                  <div><dt>Mkt cap</dt><dd>{usd(sel.marketCap)}</dd></div>
                </dl>
              </div>
              {chart ? (
                <iframe className="term-chart" title={`${sel.symbol} price chart`} src={chart} loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                <div className="term-chart empty"><p>Live charts appear on Robinhood Chain mainnet.</p></div>
              )}
              <p className="muted mono" style={{ fontSize: 12, margin: '8px 0 0', overflowWrap: 'anywhere' }}>{sel.token}</p>
            </>
          ) : (
            <p className="muted">Pick a market.</p>
          )}
        </section>

        <section className="panel term-trade" aria-label="Trade">
          {!client && (
            <>
              <h2>Trade privately</h2>
              <p>Buys go through fractal’s vault: on-chain, the vault is the buyer, and nothing links the trade to your wallet.</p>
              <button className="btn wide" onClick={connect} disabled={busy || !config}>Connect wallet</button>
            </>
          )}
          {client && !active && (
            <>
              <h2>Turn on privacy</h2>
              <p>One signature derives your privacy keys. No new seed phrase.</p>
              <button className="btn wide" onClick={activate} disabled={busy}>Sign and turn on privacy</button>
            </>
          )}
          {client && active && sel && (
            <>
              <div className="seg" role="radiogroup" aria-label="Side">
                <button role="radio" aria-checked={side === 'buy'} onClick={() => { setSide('buy'); setAmount('0.05'); }}>Buy</button>
                <button role="radio" aria-checked={side === 'sell'} onClick={() => { setSide('sell'); setAmount(''); }}>Sell</button>
              </div>
              <p className="term-bal">
                Private balance <strong>{num(balances.get(ZERO) ?? 0n, 18, 4)} ETH</strong>
                {meta && <> and <strong>{num(held, meta.decimals, 2)} {meta.symbol}</strong></>}
              </p>
              <label className="field">
                <span>{side === 'buy' ? 'Spend (ETH)' : `Sell (${meta?.symbol ?? ''})`}</span>
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" autoComplete="off" />
              </label>
              <div className="chips">
                {side === 'buy'
                  ? BUY_PRESETS.map((p) => <button key={p} className="chip" onClick={() => setAmount(p)}>{p} ETH</button>)
                  : SELL_PRESETS.map((p) => (
                      <button key={p} className="chip" disabled={!meta || held === 0n} onClick={() => setAmount(formatUnits((held * BigInt(p)) / 100n, meta!.decimals))}>{p}%</button>
                    ))}
              </div>
              <div className="chips" role="radiogroup" aria-label="Slippage">
                <span className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>Max slippage</span>
                {SLIPPAGES.map((s) => (
                  <button key={s} role="radio" aria-checked={slip === s} className={`chip ${slip === s ? 'on' : ''}`} onClick={() => setSlip(s)}>{s / 100}%</button>
                ))}
              </div>
              <ul className="summary">
                <li>You get about <strong>{q !== null ? `${num(q, outDecimals, 4)} ${outSymbol}` : '–'}</strong></li>
                <li>At least, or refunded <strong>{q !== null ? `${num(q - (q * BigInt(slip)) / 10_000n, outDecimals, 4)} ${outSymbol}` : '–'}</strong></li>
                <li>Fee <strong>{(config!.swapFeeBps / 100).toFixed(2)}% plus the pool fee</strong></li>
              </ul>
              {qErr && <p className="status error">{qErr}</p>}
              {config!.bundlerUrl ? (
                <label className="toggle">
                  <input type="checkbox" checked={privateGas} onChange={(e) => setPrivateGas(e.target.checked)} />
                  <span>Pay gas from my private ETH, so my wallet never appears.</span>
                </label>
              ) : null}
              {visibleSender && (
                <p className="status error">Private gas is off: your wallet will be the visible sender of this trade.</p>
              )}
              <button className="btn wide" onClick={trade} disabled={busy || !value || q === null || !sel.tradable || !config!.swap}>
                {sel.tradable ? `${side === 'buy' ? 'Buy' : 'Sell'} ${sel.symbol} privately` : `Not tradable privately yet: ${sel.why}`}
              </button>
            </>
          )}
          {status && <p className={`status ${status.kind}`} role="status">{status.text}</p>}

          {client && active && (
            <div className="term-pos">
              <h2>Private positions</h2>
              {!positions.length && <p className="empty">No tokens yet. Buy something and it lands here, visible only to you.</p>}
              <ul className="history">
                {positions.map((p) => {
                  const pnl = p.valueEth === null ? null : p.valueEth + p.proceedsEth - p.costEth;
                  return (
                    <li key={p.token}>
                      <span className="what">
                        <button className="linkish" onClick={() => {
                          const m = markets.find((x) => x.token.toLowerCase() === p.token.toLowerCase());
                          if (m) { setSel(m); setSide('sell'); setAmount(formatUnits(p.amount, p.decimals)); }
                        }}>{p.symbol}</button>
                      </span>
                      <span className="amt">{num(p.amount, p.decimals, 2)}</span>
                      <span className="sub">
                        <span>Value {p.valueEth === null ? '–' : `${num(p.valueEth, 18, 5)} ETH`}</span>
                        <span>Cost {num(p.costEth, 18, 5)} ETH</span>
                        <span className={pnl === null ? '' : pnl < 0n ? 'dn' : 'up'}>PnL {pnl === null ? '–' : `${pnl >= 0n ? '+' : ''}${num(pnl, 18, 5)} ETH`}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      </div>
      <footer className="term-foot muted">
        Market data and charts from DexScreener. Trades route through Uniswap v3 on Robinhood Chain. Unaudited beta. Not affiliated with Robinhood.
      </footer>
    </div>
  );
}
