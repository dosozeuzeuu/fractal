import { useEffect, useState } from 'react';
import type { PrivacyClient } from '@fractal/sdk';
import { CALL_GAS_EXIT } from '@fractal/sdk/src/client';
import { decodeBase64Url } from '@fractal/sdk/src/keys';
import { Brand } from './components/Logo';
import { fmt, loadConfig, type AppConfig } from './lib/config';
import { connectWallet } from './lib/wallet';
import { createClient, createLinkClient, errorText, submitMode, tokenBy } from './lib/session';

type Status = { kind: 'busy' | 'ok' | 'error'; text: string } | null;

/** /claim#<seed>: moves a payment link's funds into the visitor's private balance. */
export default function Claim() {
  const [config, setConfig] = useState<AppConfig>();
  const [seed, setSeed] = useState<Uint8Array | null>(null);
  const [me, setMe] = useState<PrivacyClient>();
  const [link, setLink] = useState<PrivacyClient>();
  const [found, setFound] = useState<{ token: string; amount: bigint }[] | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadConfig().then(setConfig).catch((e) => setStatus({ kind: 'error', text: errorText(e) }));
    const fromHash = () => {
      setFound(null);
      try {
        const s = decodeBase64Url(location.hash.slice(1));
        setSeed(s.length === 32 ? s : null);
      } catch {
        setSeed(null);
      }
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(true);
    setStatus({ kind: 'busy', text: label });
    try {
      const done = await fn();
      setStatus(done ? { kind: 'ok', text: done } : null);
    } catch (e) {
      setStatus({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const open = () =>
    run('Waiting for your wallet…', async () => {
      const wallet = await connectWallet(config!);
      const mine = await createClient(config!, wallet);
      setStatus({ kind: 'busy', text: 'Sign in your wallet to turn on privacy, so the funds land in your private balance.' });
      await mine.activate();
      const l = await createLinkClient(config!, wallet, seed!);
      setStatus({ kind: 'busy', text: 'Looking for the link’s funds…' });
      await l.sync();
      setMe(mine);
      setLink(l);
      setFound([...l.balances()].map(([token, amount]) => ({ token, amount })));
    });

  const claim = () =>
    run('Building the claim proof on this device…', async () => {
      const results: string[] = [];
      for (const { token, amount } of found!) {
        const t = tokenBy(config!, token);
        const mode = token === '0x0000000000000000000000000000000000000000' ? await submitMode(config!, link!, true, CALL_GAS_EXIT) : { kind: 'direct' as const };
        // With private gas, the gas comes out of the link itself.
        const gas = mode.kind === 'bundler' ? (mode.gas.verificationGasLimit + mode.gas.callGasLimit + mode.gas.preVerificationGas) * mode.gas.maxFeePerGas : 0n;
        const p = await link!.prepare({ token: token as `0x${string}`, pay: { to: me!.selfKeys(), amount: amount - gas }, mode });
        await link!.submit(p, mode);
        results.push(`${fmt(amount - gas, t)} ${t.symbol}`);
      }
      await link!.sync();
      setFound([]);
      return `Claimed ${results.join(' and ')} into your private balance.`;
    });

  return (
    <div className="app-shell app">
      <header className="app-top"><Brand /></header>
      <div className="panel tone">
        <h1>Claim a payment link</h1>
        {!seed && <p>This link is incomplete. Ask the sender to copy it again, including everything after the #.</p>}
        {seed && !found && (
          <>
            <p>Someone sent you funds with a link. Connect your wallet to see the amount and move it into your private balance.</p>
            <button className="btn wide" onClick={open} disabled={busy || !config}>Connect and open the link</button>
          </>
        )}
        {found && found.length > 0 && (
          <>
            <p className="verdict">{found.map(({ token, amount }) => `${fmt(amount, tokenBy(config!, token))} ${tokenBy(config!, token).symbol}`).join(' + ')}</p>
            <p>Claiming moves it into your private balance. Once claimed, the link is empty.</p>
            <button className="btn wide" onClick={claim} disabled={busy}>Claim</button>
          </>
        )}
        {found && found.length === 0 && !status && <p>This link is empty. It was already claimed, or the sender took the funds back.</p>}
        {status && <p className={`status ${status.kind}`} role="status">{status.text}</p>}
        {status?.kind === 'ok' && <p style={{ marginTop: 16 }}><a href="/app">Open your balance</a></p>}
      </div>
    </div>
  );
}
