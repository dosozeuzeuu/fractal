import { Suspense, lazy, useState } from 'react';
import { Brand } from './components/Logo';
import { ChainDemo, SpeedLines } from './components/FractalCanvas';
import { Loader, shouldPlayIntro } from './components/Loader';
import { SplitText } from './components/SplitText';
import { Functions } from './components/Functions';

const Fractal3D = lazy(() => import('./components/Fractal3D'));

const MARQUEE = ['shield', 'シールド', 'send', 'ソウキン', 'swap', 'スワップ', 'withdraw', 'ヒキダシ', 'link', 'リンク'];

export default function Landing() {
  const [intro] = useState(shouldPlayIntro);
  const [introDone, setIntroDone] = useState(!intro);

  return (
    <>
      {intro && !introDone && <Loader onDone={() => setIntroDone(true)} />}

      <div className="hero" data-ready={introDone}>
        <SpeedLines fx={0.7} fy={0.45} count={90} />
        <Suspense fallback={null}>
          <Fractal3D start={introDone} />
        </Suspense>
        <div className="hero-vignette" />
        <header className="wrap nav">
          <Brand />
          <nav className="nav-links" aria-label="Sections">
            <a href="#episodes">What it does</a>
            <a href="#functions">How it works</a>
            <a href="#demo">What stays private</a>
            <a href="#faq">Questions</a>
            <a href="/terminal">Terminal</a>
          </nav>
          <a className="btn" href="/app">Open app</a>
        </header>
        <span className="vertical-jp" aria-hidden="true">フラクタル</span>
        <div className="wrap hero-body">
          <p className="hero-kicker">private money on robinhood chain</p>
          <SplitText as="h1" text="Hide in the pattern." play={introDone} />
          <p className="lede">
            Hold, send, trade, bridge and withdraw ETH and tokens from a private balance. The chain checks a zero-knowledge
            proof made in your browser, and never learns who paid whom.
          </p>
          <div className="hero-actions">
            <a className="btn" href="/app">Open the app</a>
            <a className="btn ghost" href="/terminal">Open the terminal</a>
          </div>
        </div>
        <span className="hanko" aria-hidden="true">秘</span>
        <aside className="hero-hud" aria-label="Vault status">
          <span className="t">システム ／ status</span>
          <div className="row"><span className="k">network</span><span>Robinhood Chain</span></div>
          <div className="row"><span className="k">vault</span><span>launching soon</span></div>
          <div className="row"><span className="k">circuit</span><span>91,187 gates</span></div>
          <div className="row"><span className="k">proof</span><span>seconds, in browser</span></div>
        </aside>
      </div>

      <div className="marquee" aria-hidden="true">
        <div className="marquee-track">
          {[0, 1].map((k) => MARQUEE.map((w, i) => (
            <span key={`${k}-${i}`} className={i % 2 ? 'jp' : i % 4 === 2 ? 'fill' : ''}>{w}</span>
          )))}
        </div>
      </div>

      <main>
        <section className="block" id="episodes">
          <div className="wrap">
            <div className="section-head">
              <SplitText text="Everything a wallet does, out of sight." />
              <span className="tag-jp" aria-hidden="true">第一章 機能</span>
            </div>
            <div className="page episodes">
              <article className="panel tone ep-1">
                <span className="ep-label">episode 1</span>
                <h3>Shield</h3>
                <p>Deposit ETH or a listed token. It becomes an encrypted note that only your keys can read.</p>
                <span className="ep-sfx" aria-hidden="true">シュッ</span>
              </article>
              <article className="panel ep-2">
                <span className="ep-label">episode 2</span>
                <h3>Send privately</h3>
                <p>Pay any registered address, or a private <span className="mono">fx1…</span> address that reveals nothing at all. Sender, recipient and amount stay hidden.</p>
                <span className="ep-sfx" aria-hidden="true">スッ</span>
              </article>
              <article className="panel invert ep-3">
                <span className="ep-label" style={{ color: '#555' }}>episode 3</span>
                <h3>Swap without a trail</h3>
                <p>Trade ETH and tokens through Uniswap from inside the pool. The DEX sees a swap by the vault; the result lands in your private balance, and nobody learns it was you.</p>
              </article>
              <article className="panel tone ep-4">
                <span className="ep-label">episode 4</span>
                <h3>Withdraw</h3>
                <p>To any address, whenever you like.</p>
              </article>
              <article className="panel ep-5">
                <span className="ep-label">side stories</span>
                <h3>Payment links and receipts</h3>
                <p style={{ maxWidth: '72ch' }}>
                  Turn an amount into a link anyone can claim, with no address needed. When you need to show you paid,
                  share a receipt that proves one payment and reveals nothing else about your balance.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="block" id="functions">
          <div className="wrap">
            <div className="section-head">
              <SplitText text="Inside every function." />
              <p>Pick one to see each step, what the chain can see, what stays hidden, and what it costs.</p>
            </div>
            <Functions />
          </div>
        </section>

        <section className="block" id="demo">
          <div className="wrap">
            <div className="section-head">
              <SplitText text="What the chain sees, and what it doesn’t." />
              <p>Press the button. Privacy has edges, and the panel on the right lists them.</p>
            </div>
            <div className="page demo">
              <ChainDemo />
              <div className="panel invert demo-side">
                <div>
                  <h3 style={{ marginBottom: 14 }}>Still public</h3>
                  <ul className="ledger">
                    <li><span className="k">deposits</span><span>the depositing address, token and amount</span></li>
                    <li><span className="k">withdrawals</span><span>the receiving address, token and amount</span></li>
                    <li><span className="k">swaps</span><span>the tokens and amounts traded by the vault, never who asked</span></li>
                    <li><span className="k">register</span><span>that an address can receive privately</span></li>
                  </ul>
                </div>
              </div>
            </div>
            <p className="speech">
              The same amount going in and coming out a few minutes apart is easy to connect. Leave time between them,
              and vary the amounts.
            </p>
          </div>
        </section>

        <section className="block" id="stack">
          <div className="wrap">
            <div className="section-head">
              <SplitText text="Under the hood." />
              <span className="tag-jp" aria-hidden="true">第三章 技術</span>
            </div>
            <div className="panel tone">
              <ul className="stack-list">
                <li><span className="k">Noir + UltraHonk</span><span className="v">The zero-knowledge proof for each action, built in your browser in seconds, on the public setup from Aztec’s Ignition ceremony. Your keys never reach a server.</span></li>
                <li><span className="k">Wallet signature</span><span className="v">Every spend carries your wallet’s signature, checked inside the proof. Someone who learns your viewing key still can’t move your funds.</span></li>
                <li><span className="k">One sign-in</span><span className="v">Your privacy keys come from a single wallet signature. Same wallet, same keys, on any device. No new seed phrase.</span></li>
                <li><span className="k">ERC-4337 gas</span><span className="v">With a bundler, gas is paid from your private ETH, so your address never appears on a private action.</span></li>
                <li><span className="k">Uniswap v3</span><span className="v">Private swaps route through Uniswap on Robinhood Chain. If a swap can’t meet your minimum, the full amount returns to your balance.</span></li>
                <li><span className="k">Guardrails</span><span className="v">Withdrawals above a threshold wait 24 hours. A guardian can pause spending or hold a withdrawal in that window, and the vault is upgradeable. All of it happens on-chain, in public.</span></li>
              </ul>
            </div>
          </div>
        </section>

        <section className="block" id="fees">
          <div className="wrap">
            <div className="section-head">
              <SplitText text="Fees, in full." />
              <p>Plus network gas. Fees go to a collector that sends half to the team and half to buybacks.</p>
            </div>
            <div className="page fee-grid">
              <div className="panel"><span className="ep-label">shield</span><p className="big">0%</p></div>
              <div className="panel"><span className="ep-label">send, links</span><p className="big">0%</p></div>
              <div className="panel tone"><span className="ep-label">private swap</span><p className="big">0.30%</p><p className="muted" style={{ fontSize: 14 }}>plus the DEX fee</p></div>
              <div className="panel invert"><span className="ep-label" style={{ color: '#555' }}>withdraw</span><p className="big">1%</p></div>
            </div>
          </div>
        </section>

        <section className="block faq" id="faq">
          <div className="wrap">
            <div className="section-head">
              <SplitText text="Questions people ask first." />
              <span className="tag-jp" aria-hidden="true">第五章 質問</span>
            </div>
            <div className="panel">
              <details>
                <summary>What do I need?</summary>
                <p>A browser wallet such as MetaMask or Rabby on Robinhood Chain, and some ETH. You sign one message to create your privacy keys. To receive private payments at your address, one small transaction registers your public key.</p>
              </details>
              <details>
                <summary>Can anyone freeze or take my funds?</summary>
                <p>No one else can spend your notes: every spend needs your wallet’s signature. They can be delayed. Large withdrawals wait 24 hours, during which the guardian can hold them, and in an emergency the guardian can pause spending until it resumes.</p>
              </details>
              <details>
                <summary>Is it audited?</summary>
                <p>Not yet. fractal will launch as a beta with a deposit cap. Only deposit what you can afford to lose until an independent audit of the circuit and contracts is published.</p>
              </details>
              <details>
                <summary>What happens if a swap’s price moves?</summary>
                <p>You set a minimum. If the DEX can’t deliver it, the swap doesn’t happen and the full amount comes back to your private balance, with no swap fee.</p>
              </details>
              <details>
                <summary>Is fractal part of Robinhood?</summary>
                <p>No. fractal is an independent project on Robinhood Chain, a public network anyone can build on. It is not affiliated with or endorsed by Robinhood.</p>
              </details>
            </div>
          </div>
        </section>

        <div className="wrap">
          <section className="panel invert finale">
            <span className="sfx" aria-hidden="true">ドン</span>
            <SplitText text="One signature, and you’re in the pattern." />
            <a className="btn" href="/app">Open fractal</a>
          </section>
        </div>
      </main>

      <footer>
        <div className="wrap">
          <Brand />
          <a href="/app">App</a>
          <a href="/terminal">Terminal</a>
          <a href="/app#bridge">Bridge</a>
          <a href="/receipt">Check a receipt</a>
          <p>Beta software, unaudited. Not affiliated with Robinhood. Privacy tools may be restricted where you live; you are responsible for following your local laws.</p>
        </div>
      </footer>
    </>
  );
}
