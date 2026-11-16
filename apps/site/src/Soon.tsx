import { Brand } from './components/Logo';

/** App pages before the contracts are live on a public network. */
export default function Soon() {
  return (
    <div className="wrap">
      <header className="nav"><Brand /></header>
      <section className="soon">
        <p className="hero-kicker">準備中 ／ coming to robinhood chain</p>
        <h1>The vault opens soon.</h1>
        <p>
          fractal’s contracts are going through testing before they go live on Robinhood Chain. When they do, this is where
          you’ll shield, send, swap and withdraw privately.
        </p>
        <div className="hero-actions"><a className="btn" href="/">Back to the site</a></div>
      </section>
    </div>
  );
}
