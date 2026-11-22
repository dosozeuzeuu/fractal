import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAddress, type Address } from 'viem';
import type { OwnedNote, PrivacyClient } from '@fractal/sdk';
import { CALL_GAS_EXIT, CALL_GAS_SWAP, encodeReceipt } from '@fractal/sdk/src/client';
import { decodePrivateAddress, encodeBase64Url } from '@fractal/sdk/src/keys';
import { Brand } from './components/Logo';
import { fmt, loadConfig, parseAmount, type AppConfig, type TokenInfo } from './lib/config';
import { installErrorReports, report } from './lib/report';
import { connectWallet } from './lib/wallet';
import { createClient, errorText, submitMode, tokenBy } from './lib/session';
import { quote, routeData } from './lib/swap';
import Bridge from './Bridge';

type Tab = 'shield' | 'send' | 'swap' | 'withdraw' | 'link' | 'bridge';
type Status = { kind: 'busy' | 'ok' | 'error'; text: string } | null;
const TABS: [Tab, string][] = [['shield', 'Shield'], ['send', 'Send'], ['swap', 'Swap'], ['withdraw', 'Withdraw'], ['link', 'Link'], ['bridge', 'Bridge']];
const ZERO = '0x0000000000000000000000000000000000000000';
const SLIPPAGE_BPS = 100n; // 1%

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function CopyRow({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy-row">
      <code title={value}>{value}</code>
      <button
        className="btn"
        onClick={() => navigator.clipboard.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}
      >
        {done ? 'Copied' : label}
      </button>
    </div>
  );
}

function TokenSelect({ config, value, onChange, label, exclude }: { config: AppConfig; value: Address; onChange: (a: Address) => void; label: string; exclude?: Address }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as Address)}>
        {config.tokens.filter((t) => t.address !== exclude).map((t) => (
          <option key={t.address} value={t.address}>{t.symbol}</option>
        ))}
      </select>
    </label>
  );
}

function Activity({ client, config, notes, onCopy }: { client: PrivacyClient; config: AppConfig; notes: OwnedNote[]; onCopy: (s: string) => void }) {
  const rows = [...notes].sort((a, b) => b.index - a.index).flatMap((n) => {
    const t = tokenBy(config, n.token);
    const out: { key: string; what: string; amount: string; incoming: boolean; action?: React.JSX.Element }[] = [];
    if ((n.kind === 0 || n.kind === 5) && n.amount > 0n) {
      out.push({
        key: `in-${n.index}`,
        what: n.kind === 5 ? 'Swap received' : n.viaPrivateAddress ? 'Received at your private address' : 'Received or shielded',
        amount: `${fmt(n.amount, t)} ${t.symbol}`,
        incoming: true,
      });
    }
    if (n.kind === 1 && n.memoAmount > 0n) {
      const action =
        n.memoTo !== ZERO ? (
          <button
            className="linkish"
            onClick={async () => {
              const [opk] = await client.keysOf(n.memoTo);
              onCopy(`${location.origin}/receipt#${encodeReceipt(client.receiptFor(n, opk))}`);
            }}
          >
            Copy receipt link
          </button>
        ) : undefined;
      out.push({ key: `pay-${n.index}`, what: n.memoTo === ZERO ? 'Paid a private address' : `Paid ${short(n.memoTo)}`, amount: `${fmt(n.memoAmount, t)} ${t.symbol}`, incoming: false, action });
    }
    if (n.kind === 3 && n.memoAmount > 0n) {
      out.push({ key: `exit-${n.index}`, what: `Withdrew to ${short(n.memoTo)}`, amount: `${fmt(n.memoAmount, t)} ${t.symbol}`, incoming: false });
    }
    if (n.kind === 4 && n.memoAmount > 0n) {
      const bridged = n.token === ZERO && n.memoToken === ZERO;
      out.push({ key: `swap-${n.index}`, what: bridged ? `Bridged out to ${short(n.memoTo)}` : `Swapped into ${tokenBy(config, n.memoToken).symbol}`, amount: `${fmt(n.memoAmount, t)} ${t.symbol}`, incoming: false });
    }
    if (n.kind === 6) {
      const seed = encodeBase64Url(hexToBytes32(n.payRho));
      out.push({
        key: `link-${n.index}`,
        what: 'Created a payment link',
        amount: `${fmt(n.memoAmount, t)} ${t.symbol}`,
        incoming: false,
        action: <button className="linkish" onClick={() => onCopy(`${location.origin}/claim#${seed}`)}>Copy link</button>,
      });
    }
    return out;
  });
  if (!rows.length) return <p className="empty">Nothing yet. Shield some ETH to start.</p>;
  return (
    <ul className="history">
      {rows.map((r) => (
        <li key={r.key}>
          <span className="what">{r.what}</span>
          <span className={`amt ${r.incoming ? 'in' : ''}`}>{r.amount}</span>
          {r.action && <span className="sub">{r.action}</span>}
        </li>
      ))}
    </ul>
  );
}

function hexToBytes32(x: bigint): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig>();
  const [client, setClient] = useState<PrivacyClient>();
  const [active, setActive] = useState(false);
  const [registered, setRegistered] = useState<boolean>();
  const [notes, setNotes] = useState<OwnedNote[]>([]);
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());
  const [pendingSwaps, setPendingSwaps] = useState(0);
  const [tab, setTab] = useState<Tab>(() => TABS.find(([t]) => t === location.hash.slice(1))?.[0] ?? 'shield');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<Address>(ZERO);
  const [tokenOut, setTokenOut] = useState<Address>(ZERO);
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  const [privateGas, setPrivateGas] = useState(true);
  const [quoted, setQuoted] = useState<bigint | null>(null);
  const [newLink, setNewLink] = useState<string>();
  const syncing = useRef(false);

  useEffect(() => {
    installErrorReports();
    loadConfig()
      .then((c) => { setConfig(c); setTokenOut(c.tokens[1]?.address ?? ZERO); })
      .catch((e) => setStatus({ kind: 'error', text: errorText(e) }));
  }, []);

  const tIn = config ? tokenBy(config, token) : undefined;
  const tOut = config ? tokenBy(config, tokenOut) : undefined;
  const value = tIn ? parseAmount(amount, tIn) : null;

  const refresh = useCallback(async (c?: PrivacyClient) => {
    const cl = c ?? client;
    if (!cl || syncing.current) return;
    syncing.current = true;
    try {
      await cl.sync();
      setBalances(new Map(cl.balances()));
      setNotes([...cl.notes]);
      setPendingSwaps(cl.pendingSwaps.size);
    } finally {
      syncing.current = false;
    }
  }, [client]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => refresh().catch(() => undefined), 15_000);
    return () => clearInterval(id);
  }, [active, refresh]);

  // Live swap quote.
  useEffect(() => {
    setQuoted(null);
    if (tab !== 'swap' || !client || !config?.swap || !value || !tIn || !tOut || tIn.address === tOut.address) return;
    const h = setTimeout(() => {
      quote(client.publicClient, config, tIn, tOut, value).then(setQuoted).catch(() => setQuoted(null));
    }, 250);
    return () => clearTimeout(h);
  }, [tab, client, config, value, tIn, tOut]);

  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(true);
    setStatus({ kind: 'busy', text: label });
    try {
      const done = await fn();
      setStatus(done ? { kind: 'ok', text: done } : null);
    } catch (e) {
      report(tab, 'error', { message: errorText(e) });
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
    run('Sign the message in your wallet. The first time, it asks twice to check your wallet signs consistently.', async () => {
      await client!.activate();
      setRegistered(await client!.isRegistered());
      setStatus({ kind: 'busy', text: 'Finding your notes…' });
      await refresh(client);
      setActive(true);
    });

  const register = () =>
    run('Confirm the registration in your wallet…', async () => {
      await client!.register();
      setRegistered(true);
      return 'Registered. Others can now pay this address privately.';
    });

  const copy = (s: string) => navigator.clipboard.writeText(s).then(() => setStatus({ kind: 'ok', text: 'Copied to your clipboard.' }));
  const usesBundler = Boolean(config?.bundlerUrl) && privateGas;

  const submit = () => {
    report(tab, 'click', { message: !client ? 'no client' : !config ? 'no config' : !value ? 'no amount' : !tIn ? 'no token' : '' });
    if (!client || !config || !value || !tIn) return;
    setNewLink(undefined);
    if (tab === 'shield') {
      return run(token === ZERO ? 'Confirm the deposit in your wallet…' : 'Confirm the approval and deposit in your wallet…', async () => {
        await client.shield(value, token);
        await refresh();
        setAmount('');
        return `Shielded ${fmt(value, tIn)} ${tIn.symbol}.`;
      });
    }
    return run('Preparing…', async () => {
      const callGas = tab === 'swap' ? CALL_GAS_SWAP : CALL_GAS_EXIT;
      const mode = await submitMode(config, client, privateGas, callGas);
      report(tab, 'mode', { message: mode.kind });
      const proving = 'Building your proof on this device (up to a minute). Then confirm the signature in your wallet: if no window opens, click your wallet’s icon in the browser toolbar.';
      let done: string;
      if (tab === 'send') {
        const keys = to.trim().startsWith('fx1') ? decodePrivateAddress(to) : isAddress(to) ? await client.recipientKeys(to) : null;
        if (!keys) throw new Error('Enter a 0x address or an fx1 private address.');
        setStatus({ kind: 'busy', text: proving });
        const p = await client.prepare({ token, pay: { to: keys, amount: value, memoTo: isAddress(to) ? to : undefined }, mode });
        report(tab, 'signed');
        setStatus({ kind: 'busy', text: 'Submitting…' });
        await client.submit(p, mode);
        report(tab, 'submitted');
        done = `Sent ${fmt(value, tIn)} ${tIn.symbol} privately.`;
      } else if (tab === 'withdraw') {
        if (!isAddress(to)) throw new Error('Enter the 0x address to withdraw to.');
        setStatus({ kind: 'busy', text: proving });
        const p = await client.prepare({ token, exit: { recipient: to, amount: value }, mode });
        report(tab, 'signed');
        setStatus({ kind: 'busy', text: 'Submitting…' });
        await client.submit(p, mode);
        report(tab, 'submitted');
        done = `Withdrew ${fmt(value - value / 100n, tIn)} ${tIn.symbol} to ${short(to)}.`;
      } else if (tab === 'swap') {
        if (!config.swap || !tOut) throw new Error('Swaps are not available on this network yet.');
        const q = await quote(client.publicClient, config, tIn, tOut, value);
        const minOut = q - (q * SLIPPAGE_BPS) / 10_000n;
        setStatus({ kind: 'busy', text: proving });
        const p = await client.prepare({ token, swap: { tokenOut, amountIn: value, minOut, adapter: config.swap.adapter, data: routeData(config) }, mode });
        report(tab, 'signed');
        setStatus({ kind: 'busy', text: 'Submitting…' });
        await client.submit(p, mode);
        report(tab, 'submitted');
        done = `Swap sent. About ${fmt(q, tOut, 4)} ${tOut.symbol} will arrive in your private balance.`;
      } else {
        setStatus({ kind: 'busy', text: proving });
        const p = await client.prepare({ token, link: { amount: value }, mode });
        report(tab, 'signed');
        setStatus({ kind: 'busy', text: 'Submitting…' });
        await client.submit(p, mode);
        report(tab, 'submitted');
        setNewLink(`${location.origin}/claim#${encodeBase64Url(p.linkSeed!)}`);
        done = `Link created for ${fmt(value, tIn)} ${tIn.symbol}. Anyone with it can claim the funds, so share it only with the person you mean to pay.`;
      }
      await new Promise((r) => setTimeout(r, mode.kind === 'bundler' ? 4000 : 0));
      await refresh();
      setAmount('');
      return done;
    });
  };

  const ethInfo = config?.tokens[0];
  const actionLabel = { shield: 'Shield', send: 'Send privately', swap: 'Swap privately', withdraw: 'Withdraw', link: 'Create link', bridge: 'Bridge' }[tab];
  const privateAddr = useMemo(() => (active && client ? client.privateAddress() : ''), [active, client]);

  return (
    <div className="app-shell app">
      <header className="app-top">
        <Brand />
        <span className="spacer" />
        {config && <span className={`tag ${config.devVerifier ? 'dev' : 'on'}`}>{config.name}{config.devVerifier ? ' · test build' : ''}</span>}
        {client && <span className="tag mono">{short(client.address)}</span>}
        <a className="btn ghost" href="/terminal">Terminal</a>
      </header>

      {!client && (
        <div className="panel tone">
          <h1>Connect a wallet</h1>
          <p>Use MetaMask, Rabby or another browser wallet. fractal asks it to switch to {config?.name ?? 'Robinhood Chain'} if needed.</p>
          <button className="btn wide" onClick={connect} disabled={busy || !config}>Connect wallet</button>
        </div>
      )}

      {client && !active && (
        <div className="panel tone">
          <h1>Enter the pattern</h1>
          <p>Your wallet signs one message, and this page derives your privacy keys from it. They stay in this tab’s memory; reloading asks again. There’s no new seed phrase to save.</p>
          <button className="btn wide" onClick={activate} disabled={busy}>Sign and turn on privacy</button>
        </div>
      )}

      {client && active && config && ethInfo && tIn && (
        <>
          <div className="panel">
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>Private balance</p>
            <div className="balances">
              <p className="balance-main">{fmt(balances.get(ZERO) ?? 0n, ethInfo)}<small>ETH</small></p>
              {config.tokens.slice(1).map((t) => (
                <div className="balance-row" key={t.address}><span>{t.symbol}</span><span>{fmt(balances.get(t.address) ?? 0n, t, 4)}</span></div>
              ))}
              {pendingSwaps > 0 && <div className="balance-row"><span>Swaps settling</span><span>{pendingSwaps}</span></div>}
            </div>

            <div className="tabs" role="tablist" aria-label="Action">
              {TABS.filter(([t]) => t !== 'bridge' || config.bridge).map(([t, label]) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setStatus(null); setNewLink(undefined); if (t === 'withdraw' && !to) setTo(client.address); }}>
                  {label}
                </button>
              ))}
            </div>

            {tab === 'bridge' && config.bridge ? (
              <Bridge config={config} client={client} privateGas={privateGas} onDone={() => refresh()} />
            ) : (<>
            {tab === 'swap' ? (
              <div className="row2">
                <TokenSelect config={config} value={token} onChange={(a) => { setToken(a); if (a === tokenOut) setTokenOut(config.tokens.find((t) => t.address !== a)!.address); }} label="From" />
                <TokenSelect config={config} value={tokenOut} onChange={setTokenOut} label="To" exclude={token} />
              </div>
            ) : (
              <TokenSelect config={config} value={token} onChange={setToken} label="Token" />
            )}

            {(tab === 'send' || tab === 'withdraw') && (
              <label className="field">
                <span>{tab === 'send' ? 'Recipient: a registered 0x address or an fx1 private address' : 'Withdraw to'}</span>
                <input className="mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder={tab === 'send' ? '0x… or fx1…' : '0x…'} spellCheck={false} autoComplete="off" />
              </label>
            )}
            <label className="field">
              <span>Amount in {tIn.symbol}</span>
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" autoComplete="off" />
            </label>

            <ul className="summary">
              {tab === 'shield' && <><li>Fee <strong>None, just gas</strong></li><li>Visible on-chain <strong>Your address, token and amount</strong></li></>}
              {tab === 'send' && <><li>Fee <strong>None, just gas</strong></li><li>Visible on-chain <strong>Nothing about the payment</strong></li></>}
              {tab === 'link' && <><li>Fee <strong>None, just gas</strong></li><li>Who can claim <strong>Anyone who has the link</strong></li></>}
              {tab === 'withdraw' && <><li>Exit fee (1%) <strong>{value ? `${fmt(value / 100n, tIn)} ${tIn.symbol}` : '—'}</strong></li><li>Arrives <strong>{value ? `${fmt(value - value / 100n, tIn)} ${tIn.symbol}` : '—'}</strong></li></>}
              {tab === 'swap' && tOut && (
                <>
                  <li>You get about <strong>{quoted !== null ? `${fmt(quoted, tOut, 4)} ${tOut.symbol}` : '—'}</strong></li>
                  <li>At least, or refunded <strong>{quoted !== null ? `${fmt(quoted - (quoted * SLIPPAGE_BPS) / 10_000n, tOut, 4)} ${tOut.symbol}` : '—'}</strong></li>
                  <li>Swap fee <strong>{(config.swapFeeBps / 100).toFixed(2)}%</strong></li>
                  <li>Visible on-chain <strong>The tokens and amounts, not you</strong></li>
                </>
              )}
            </ul>

            {tab !== 'shield' && (config.bundlerUrl ? (
              <label className="toggle">
                <input type="checkbox" checked={privateGas} onChange={(e) => setPrivateGas(e.target.checked)} />
                <span>Pay gas from my private ETH, so my wallet address never appears on this transaction.</span>
              </label>
            ) : (
              <p style={{ fontSize: 14 }}>Your wallet submits this and pays its gas, so its address appears on the transaction. What it does stays private.</p>
            ))}

            {tab === 'swap' && !config.swap ? (
              <p className="status">Swaps aren’t set up on this network yet.</p>
            ) : (
              <button className="btn wide" onClick={submit} disabled={busy || !value || (tab === 'swap' && quoted === null)}>{actionLabel}</button>
            )}
            {!busy && !status && !value && <p className="muted" style={{ fontSize: 13, margin: '8px 0 0' }}>{amount.trim() ? 'That amount isn’t valid: use a dot for decimals, like 0.01.' : 'Enter an amount to continue.'}</p>}
            {status && <p className={`status ${status.kind}`} role="status">{status.text}</p>}
            {newLink && <CopyRow value={newLink} label="Copy link" />}
            {usesBundler && tab !== 'shield' && token !== ZERO && <p className="muted" style={{ fontSize: 13, margin: '10px 0 0' }}>Private gas is paid from your ETH notes.</p>}
            </>)}
          </div>

          <div className="panel">
            <h2>Receive privately</h2>
            <p>Share your private address. Payments to it reveal nothing on-chain, not even that this wallet was paid.</p>
            <CopyRow value={privateAddr} label="Copy" />
            {registered === false && (
              <>
                <p style={{ marginTop: 18 }}>To also be paid at your 0x address, publish your public key once. This shows on-chain that the address uses fractal.</p>
                <button className="btn ghost wide" onClick={register} disabled={busy}>Register this address</button>
              </>
            )}
          </div>

          <div className="panel">
            <h2>Activity</h2>
            <Activity client={client} config={config} notes={notes} onCopy={copy} />
          </div>
        </>
      )}

      {(!client || !active) && status && <p className={`status ${status.kind}`} role="status">{status.text}</p>}
    </div>
  );
}
