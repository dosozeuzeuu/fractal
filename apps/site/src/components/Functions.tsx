import type React from 'react';
import { useRef, useState } from 'react';

interface Fn {
  id: string;
  name: string;
  jp: string;
  line: string;
  flow: string[];
  steps: string[];
  visible: string[];
  hidden: string[];
  fee: string;
  note?: string;
}

const FNS: Fn[] = [
  {
    id: 'shield',
    name: 'Shield',
    jp: 'シールド',
    line: 'Move ETH or a listed token from your wallet into your private balance.',
    flow: ['Your wallet', 'fractal vault', 'Encrypted note'],
    steps: [
      'Connect a wallet such as MetaMask or Rabby and sign one message. Your privacy keys are derived from that signature, with no new seed phrase.',
      'Pick a token and an amount. A token other than ETH needs a one-time approval first.',
      'Confirm the deposit. The vault records a commitment to a new note in its tree, encrypted so only your keys can read it.',
    ],
    visible: ['your address', 'the token', 'the amount'],
    hidden: ['where the money goes next'],
    fee: 'Free, plus gas',
    note: 'During the beta the vault caps total ETH deposits at 50 ETH.',
  },
  {
    id: 'send',
    name: 'Send privately',
    jp: 'ソウキン',
    line: 'Pay another fractal user without revealing who paid, who received or how much.',
    flow: ['Your notes', 'Proof in your browser', 'Their new note'],
    steps: [
      'Enter a registered 0x address or an fx1 private address, and an amount.',
      'Your wallet signs a Spend message for exactly this payment. The proof checks that signature, so a leaked viewing key can never move your funds.',
      'Your browser builds a zero-knowledge proof in a few seconds. Your keys never leave the tab.',
      'The vault checks the proof, marks your old notes spent and adds a new note for the recipient, plus your change.',
    ],
    visible: ['that a private transaction happened'],
    hidden: ['the sender', 'the recipient', 'the amount', 'the token'],
    fee: 'Free, plus gas',
    note: 'To receive at a 0x address, the owner registers their public key once with one small transaction.',
  },
  {
    id: 'address',
    name: 'Private address',
    jp: 'プライベート',
    line: 'An fx1… address you can post anywhere, with nothing linking it to your wallet.',
    flow: ['Payer', 'fx1… address', 'Your balance'],
    steps: [
      'fractal derives a second identity from the same signature, with its own keys, and encodes it as an fx1… address.',
      'Share it on a profile, an invoice or in a chat. Payers send to it like any private payment.',
      'Payments arrive as notes only your keys can find. Spending them still needs your wallet’s signature.',
    ],
    visible: ['nothing that names you'],
    hidden: ['your wallet', 'who paid you', 'how much'],
    fee: 'Free, plus gas',
  },
  {
    id: 'swap',
    name: 'Private swap',
    jp: 'スワップ',
    line: 'Trade ETH and tokens through Uniswap from inside your private balance.',
    flow: ['Note in token A', 'Vault swaps on Uniswap', 'Note in token B'],
    steps: [
      'Choose what to sell and what to buy, and set the minimum you’ll accept.',
      'Your proof spends the input notes. The vault, not you, trades on Uniswap v3 on Robinhood Chain.',
      'The output lands as a new private note in the token you bought.',
      'If the trade can’t meet your minimum, it doesn’t happen and the full amount returns as a note, with no swap fee.',
    ],
    visible: ['that the vault traded', 'the tokens and amounts'],
    hidden: ['who asked for the trade', 'where the result went'],
    fee: '0.3%, plus the Uniswap pool fee and gas',
  },
  {
    id: 'terminal',
    name: 'Private terminal',
    jp: 'ターミナル',
    line: 'Buy and sell any Robinhood Chain token with ETH from your private balance. Nobody can see which wallets are buying.',
    flow: ['Your private ETH', 'Vault buys on Uniswap', 'Private token note'],
    steps: [
      'Open the terminal at /terminal. Live prices and charts come from DexScreener, with search by name or contract address.',
      'Pick a token, an amount and your maximum slippage. One click buys or sells; presets cover the usual sizes.',
      'Your proof spends private ETH and the vault makes the trade. With private gas on, the transaction comes from the vault, so no wallet is linked to the buy.',
      'Your positions and profit or loss are worked out on your device from your own notes. Nobody else can see them.',
      'Any token with a Uniswap v3 pool against ETH can be traded. A token is added to the vault automatically the first time someone buys it.',
    ],
    visible: ['that the vault bought or sold', 'the token and amounts'],
    hidden: ['who bought', 'which wallet holds it now', 'your positions'],
    fee: '0.3%, plus the Uniswap pool fee and gas',
    note: 'Tokens on other DEXs or launchpads show in the list but can’t be traded privately yet.',
  },
  {
    id: 'bridge',
    name: 'Private bridge',
    jp: 'ブリッジ',
    line: 'Move ETH between your private balance and Ethereum, Base, Arbitrum or Optimism through Across.',
    flow: ['ETH on another chain', 'Across', 'Private note on Robinhood Chain'],
    steps: [
      'Bridge in: deposit ETH on another chain. Across delivers it straight into the vault as a private note, so your Robinhood Chain address never appears.',
      'Bridge out: your proof spends private ETH and the vault pays Across, which delivers to any address on the chain you pick.',
      'Quotes come live from Across, with the time to arrive and the exact amount received.',
      'If a bridge-out can’t be filled, it fails safely: the full amount returns to your private balance as a note.',
    ],
    visible: ['your wallet on the other chain when bridging in', 'the receiving address when bridging out'],
    hidden: ['the link between the two chains and your Robinhood Chain wallet'],
    fee: 'Bridge in: Across fee only. Bridge out: 1% plus the Across fee',
    note: 'Leave time between bridging in and out, and vary amounts.',
  },
  {
    id: 'withdraw',
    name: 'Withdraw',
    jp: 'ヒキダシ',
    line: 'Send funds from your private balance to any public address.',
    flow: ['Your notes', 'Proof', 'Any 0x address'],
    steps: [
      'Enter the address to receive the funds and the amount.',
      'Sign and prove as with a private payment. The vault pays the address directly.',
      'Above a set amount per token, the withdrawal waits 24 hours in public view before it pays out.',
    ],
    visible: ['the receiving address', 'the token', 'the amount'],
    hidden: ['which deposit it came from'],
    fee: '1% of the amount, plus gas',
    note: 'Withdraw to a fresh address, wait between deposit and withdrawal, and vary amounts. Same amount in and out a few minutes apart is easy to match.',
  },
  {
    id: 'links',
    name: 'Payment links',
    jp: 'リンク',
    line: 'Turn an amount into a link anyone can claim, with no address needed.',
    flow: ['Your notes', 'Secret link', 'Whoever opens it'],
    steps: [
      'Enter an amount in ETH or a listed token and create the link. The funds move into a note that the link’s secret controls.',
      'The secret sits after the # in the link, a part browsers never send to a server.',
      'Whoever opens the link connects a wallet and claims the funds into their own private balance.',
      'Until it’s claimed, you can open it from your history and take the funds back.',
    ],
    visible: ['that a private transaction happened'],
    hidden: ['who paid', 'who claimed', 'the amount'],
    fee: 'Free, plus gas',
    note: 'A link works like cash: anyone who sees it can claim it, once. Send it through an end-to-end encrypted chat.',
  },
  {
    id: 'receipts',
    name: 'Receipts',
    jp: 'レシート',
    line: 'Prove one payment without opening up the rest of your balance.',
    flow: ['Your history', 'Receipt link', 'Anyone can check'],
    steps: [
      'In your history, choose a payment you made and copy its receipt link.',
      'Share it with whoever needs proof: a shop, a client, an accountant.',
      'The receipt page checks it against the chain and confirms the amount and the recipient, nothing else.',
    ],
    visible: ['to the person you share it with: one payment’s amount and recipient'],
    hidden: ['your balance', 'your other payments'],
    fee: 'Free',
    note: 'Receipts cover payments to registered 0x addresses.',
  },
  {
    id: 'gas',
    name: 'Private gas',
    jp: 'ガス',
    line: 'Pay network fees from your private ETH, so your address never appears.',
    flow: ['Your private ETH', 'Bundler', 'Vault pays the network'],
    steps: [
      'The vault is its own ERC-4337 smart account. Private actions go to a bundler as user operations instead of transactions from your wallet.',
      'The proof includes the gas payment, which comes out of your private ETH.',
      'On-chain, the transaction comes from the vault. Your wallet address isn’t in it at all.',
    ],
    visible: ['a transaction from the vault'],
    hidden: ['your wallet address'],
    fee: 'Gas only, paid from your private ETH',
    note: 'Keep some ETH in your private balance, since token actions pay gas in ETH too.',
  },
];

/** Tabbed deep-dive on each function: steps, what the chain sees, what stays hidden, and fees. */
export function Functions() {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const f = FNS[active];

  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = FNS.length;
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <div className="fns">
      <div className="fns-tabs" role="tablist" aria-label="Functions" aria-orientation="vertical">
        {FNS.map((x, i) => (
          <button
            key={x.id}
            ref={(b) => { tabs.current[i] = b; }}
            role="tab"
            id={`fn-tab-${x.id}`}
            aria-selected={i === active}
            aria-controls={`fn-panel-${x.id}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <span className="fn-jp" aria-hidden="true">{x.jp}</span>
            <span className="fn-name">{x.name}</span>
          </button>
        ))}
      </div>

      <div className="panel fns-panel" role="tabpanel" id={`fn-panel-${f.id}`} aria-labelledby={`fn-tab-${f.id}`} key={f.id}>
        <span className="fns-ghost" aria-hidden="true">{f.jp}</span>
        <h3>{f.name}</h3>
        <p className="fns-line">{f.line}</p>

        <ol className="fns-flow" aria-label="Flow">
          {f.flow.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>

        <div className="fns-grid">
          <div>
            <h4>How it works</h4>
            <ol className="fns-steps">
              {f.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
          <div className="fns-side">
            <div className="fns-box">
              <h4>The chain sees</h4>
              <ul>{f.visible.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
            <div className="fns-box dark">
              <h4>Stays hidden</h4>
              <ul>{f.hidden.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
            <div className="fns-fee"><span>Fee</span><strong>{f.fee}</strong></div>
          </div>
        </div>
        {f.note && <p className="fns-note">{f.note}</p>}
      </div>
    </div>
  );
}
