import { useEffect, useMemo, useState } from 'react';
import { formatEther, isAddress, parseEther, type Address } from 'viem';
import {
  BRIDGE_CHAINS,
  CALL_GAS_SWAP,
  acrossQuote,
  bridgeInTransaction,
  bridgeOutInput,
  type AcrossQuote,
  type PrivacyClient,
} from '@fractal/sdk';
import { normalizeAmount, type AppConfig } from './lib/config';
import { report } from './lib/report';
import { errorText, submitMode } from './lib/session';
import { sendOnChain } from './lib/wallet';

type Dir = 'in' | 'out';
type Status = { kind: 'busy' | 'ok' | 'error'; text: string } | null;

const eth = (x: bigint, d = 6) => Number(formatEther(x)).toLocaleString(undefined, { maximumFractionDigits: d });

/** Private bridge: in from another chain straight into the notes, or out from the notes to another chain. */
export default function Bridge({
  config,
  client,
  privateGas,
  onDone,
}: {
  config: AppConfig;
  client: PrivacyClient;
  privateGas: boolean;
  onDone: () => Promise<void>;
}) {
  const b = config.bridge!;
  const [dir, setDir] = useState<Dir>('in');
  const [chain, setChain] = useState(BRIDGE_CHAINS[1].id); // Base
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  const [refundTo, setRefundTo] = useState('');
  const [q, setQ] = useState<AcrossQuote | null>(null);
  const [qErr, setQErr] = useState<string>();
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const chainName = BRIDGE_CHAINS.find((c) => c.id === chain)?.name ?? '';

  const value = useMemo(() => {
    try {
      const v = parseEther(normalizeAmount(amount) as `${number}`);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [amount]);

  const quoteFor = async (v: bigint): Promise<AcrossQuote> => {
    if (!b.acrossApi) throw new Error('Bridge quotes are only available on Robinhood Chain mainnet.');
    if (dir === 'out') {
      const recipient = (isAddress(to) ? to : client.address) as Address;
      return acrossQuote({ originChainId: config.chainId, destinationChainId: chain, amount: bridgeOutInput(v), recipient }, b.acrossApi);
    }
    // The message's size, not its content, affects the fee: quote with a same-size placeholder.
    return acrossQuote(
      { originChainId: chain, destinationChainId: config.chainId, amount: v, recipient: b.depositHandler, message: client.bridgeInMessage(v) },
      b.acrossApi,
    );
  };

  useEffect(() => {
    setQ(null);
    setQErr(undefined);
    if (!value) return;
    const h = setTimeout(() => {
      quoteFor(value).then(setQ).catch((e) => setQErr(errorText(e)));
    }, 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, dir, chain, to]);

  async function go() {
    report(`bridge-${dir}`, 'click', { message: value ? '' : 'no amount' });
    if (!value) return;
    setBusy(true);
    try {
      const fresh = await quoteFor(value);
      if (fresh.isAmountTooLow) throw new Error('That amount is below Across’s minimum for this route.');
      if (fresh.maxDeposit > 0n && (dir === 'out' ? bridgeOutInput(value) : value) > fresh.maxDeposit) {
        throw new Error(`Across can take at most ${eth(fresh.maxDeposit, 4)} ETH on this route right now.`);
      }
      if (dir === 'out') {
        if (!isAddress(to)) throw new Error(`Enter the 0x address that should receive the ETH on ${chainName}.`);
        const refund = (refundTo.trim() ? refundTo.trim() : to) as Address;
        if (!isAddress(refund)) throw new Error('The refund address is not valid.');
        const mode = await submitMode(config, client, privateGas, CALL_GAS_SWAP);
        report('bridge-out', 'mode', { message: mode.kind });
        setStatus({ kind: 'busy', text: 'Building your proof on this device (up to a minute; the page may pause while it works). Then confirm the signature in your wallet: if no window opens, click your wallet’s icon in the browser toolbar.' });
        await client.bridgeOut(value, b.adapter, {
          refundTo: refund,
          recipient: to as Address,
          destinationChainId: chain,
          outputAmount: fresh.outputAmount,
          exclusiveRelayer: fresh.exclusiveRelayer,
          quoteTimestamp: fresh.quoteTimestamp,
          fillDeadline: fresh.fillDeadline,
          exclusivityDeadline: fresh.exclusivityDeadline,
          weth: b.weth,
        }, mode);
        report('bridge-out', 'submitted');
        await new Promise((r) => setTimeout(r, mode.kind === 'bundler' ? 4000 : 0));
        await onDone();
        setStatus({
          kind: 'ok',
          text: `Sent. About ${eth(fresh.outputAmount)} ETH arrives at ${to.slice(0, 6)}…${to.slice(-4)} on ${chainName}${fresh.estimatedFillTimeSec ? ` in roughly ${fresh.estimatedFillTimeSec} seconds` : ''}.`,
        });
      } else {
        const message = client.bridgeInMessage(fresh.outputAmount);
        const tx = bridgeInTransaction({
          originChainId: chain, depositor: client.address, depositHandler: b.depositHandler, amount: value, quote: fresh, message,
        });
        if (fresh.spokePool.toLowerCase() !== tx.to.toLowerCase()) throw new Error('Across returned an unexpected deposit contract; nothing was sent.');
        setStatus({ kind: 'busy', text: `Confirm the deposit on ${chainName} in your wallet. It switches networks for this one transaction.` });
        const hash = await sendOnChain(config, client.address, tx);
        setStatus({ kind: 'busy', text: `Deposit sent on ${chainName} (${hash.slice(0, 10)}…). Waiting for it to land in your private balance…` });
        const before = client.balance();
        const until = Date.now() + 10 * 60_000;
        while (Date.now() < until) {
          await new Promise((r) => setTimeout(r, 5000));
          await onDone();
          if (client.balance() > before) break;
        }
        setStatus(
          client.balance() > before
            ? { kind: 'ok', text: `${eth(fresh.outputAmount)} ETH is in your private balance. Your Robinhood Chain address never appeared.` }
            : { kind: 'ok', text: 'Still on its way. It appears in your private balance once Across fills it; if it never fills, Across refunds you on the original chain.' },
        );
      }
      setAmount('');
    } catch (e) {
      report(`bridge-${dir}`, 'error', { message: errorText(e) });
      setStatus({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bridge">
      <div className="seg" role="radiogroup" aria-label="Direction">
        <button role="radio" aria-checked={dir === 'in'} onClick={() => { setDir('in'); setStatus(null); }}>Bridge in</button>
        <button role="radio" aria-checked={dir === 'out'} onClick={() => { setDir('out'); setStatus(null); }}>Bridge out</button>
      </div>

      <div className="row2">
        <label className="field">
          <span>{dir === 'in' ? 'From' : 'To'}</span>
          <select value={chain} onChange={(e) => setChain(Number(e.target.value))}>
            {BRIDGE_CHAINS.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Amount (ETH)</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" autoComplete="off" />
        </label>
      </div>

      {dir === 'out' && (
        <>
          <label className="field">
            <span>Recipient on {chainName}</span>
            <input className="mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
          </label>
          <label className="field">
            <span>Refund address on Robinhood Chain if the bridge can’t fill (optional, defaults to the recipient)</span>
            <input className="mono" value={refundTo} onChange={(e) => setRefundTo(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
          </label>
        </>
      )}

      <ul className="summary">
        {dir === 'in' ? (
          <>
            <li>You receive privately <strong>{q ? `≈ ${eth(q.outputAmount)} ETH` : '–'}</strong></li>
            <li>Arrives in <strong>{q?.estimatedFillTimeSec ? `~${q.estimatedFillTimeSec} s` : '–'}</strong></li>
            <li>Visible on-chain <strong>Your {chainName} wallet and the amount, never your Robinhood Chain address</strong></li>
          </>
        ) : (
          <>
            <li>Fee <strong>1% exit fee plus the bridge fee</strong></li>
            <li>They receive on {chainName} <strong>{q ? `≈ ${eth(q.outputAmount)} ETH` : '–'}</strong></li>
            <li>Visible on-chain <strong>The vault paying the bridge and the recipient, never your wallet</strong></li>
          </>
        )}
      </ul>
      {qErr && <p className="status error">{qErr}</p>}
      <button className="btn wide" onClick={go} disabled={busy || !value || (dir === 'out' && !isAddress(to))}>
        {dir === 'in' ? `Bridge in from ${chainName}` : `Bridge out to ${chainName}`}
      </button>
      {!busy && !status && (!value || (dir === 'out' && !isAddress(to))) && (
        <p className="muted" style={{ fontSize: 13, margin: '8px 0 0' }}>
          {!value
            ? amount.trim() ? 'That amount isn’t valid: use a dot for decimals, like 0.01.' : 'Enter an amount to continue.'
            : `Enter the full 0x address that should receive the ETH on ${chainName}.`}
        </p>
      )}
      {status && <p className={`status ${status.kind}`} role="status">{status.text}</p>}
      <p className="muted" style={{ fontSize: 14, marginTop: 14 }}>
        Through Across. Leave time between bridging in and moving funds out, and vary amounts: the same amount in and out
        minutes apart is easy to match.
      </p>
    </div>
  );
}
