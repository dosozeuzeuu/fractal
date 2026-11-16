import { useEffect, useState } from 'react';
import { zeroAddress } from 'viem';
import { decodeReceipt, verifyReceipt, type Receipt as R, type ReceiptCheck } from '@fractal/sdk/src/client';
import { Brand } from './components/Logo';
import { fmt, loadConfig, type AppConfig } from './lib/config';
import { publicClientFor } from './lib/wallet';
import { tokenBy } from './lib/session';

/** /receipt#<data>: anyone can check that a fractal payment happened, without a wallet. */
export default function Receipt() {
  const [config, setConfig] = useState<AppConfig>();
  const [receipt, setReceipt] = useState<R | null>(null);
  const [check, setCheck] = useState<ReceiptCheck | null>(null);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');

  const load = (s: string) => {
    setCheck(null);
    setError('');
    try {
      const data = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s;
      setReceipt(decodeReceipt(data.trim()));
    } catch {
      setReceipt(null);
      setError('That is not a fractal receipt. Paste the whole link.');
    }
  };

  useEffect(() => {
    loadConfig().then(setConfig).catch(() => setError('This site’s configuration did not load.'));
    const fromHash = () => {
      if (location.hash.length > 1) load(location.hash);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  useEffect(() => {
    if (!config || !receipt) return;
    if (receipt.chainId !== config.chainId || receipt.vault.toLowerCase() !== config.vault.toLowerCase()) {
      setCheck({ valid: false, reason: `This receipt is for another network or vault (chain ${receipt.chainId}).` });
      return;
    }
    verifyReceipt(publicClientFor(config), receipt, BigInt(config.startBlock)).then(setCheck).catch(() =>
      setCheck({ valid: false, reason: 'Could not reach the network to check it. Try again.' }),
    );
  }, [config, receipt]);

  const t = config && receipt ? tokenBy(config, receipt.token) : undefined;
  return (
    <div className="app-shell app">
      <header className="app-top"><Brand /></header>
      {!receipt && (
        <div className="panel tone">
          <h1>Check a receipt</h1>
          <p>A receipt proves one private payment happened, and reveals nothing else about the payer’s balance.</p>
          <label className="field"><span>Receipt link</span><input className="mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="https://…/receipt#…" /></label>
          <button className="btn wide" onClick={() => load(input)} disabled={!input}>Check</button>
          {error && <p className="status error">{error}</p>}
        </div>
      )}
      {receipt && t && (
        <div className={`panel ${check?.valid ? 'invert' : ''}`}>
          {!check && <p className="verdict">Checking the chain…</p>}
          {check?.valid && (
            <>
              <p className="verdict">Payment confirmed</p>
              <ul className="ledger" style={{ marginTop: 12 }}>
                <li><span className="k">amount</span><span>{fmt(receipt.amount, t)} {t.symbol}</span></li>
                <li><span className="k">paid to</span><span className="mono">{receipt.to === zeroAddress ? 'a private address' : receipt.to}</span></li>
                <li><span className="k">block</span><span className="mono">{check.blockNumber.toString()}</span></li>
                <li><span className="k">network</span><span>{config!.name}</span></li>
              </ul>
            </>
          )}
          {check && !check.valid && (
            <>
              <p className="verdict">Not a valid payment</p>
              <p className="status error">{check.reason}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
