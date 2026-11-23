import type { GasSettings, PrivacyClient, ProverLike, SubmitMode } from '@fractal/sdk';
import { CALL_GAS_EXIT } from '@fractal/sdk/src/client';
import type { Account, Chain, Transport, WalletClient } from 'viem';
import { loadCrs } from './crs';
import type { AppConfig, TokenInfo } from './config';
import { publicClientFor } from './wallet';
import { report } from './report';

/**
 * TEST BUILDS ONLY (VITE_TEST_PROVER_URL set at build time; absent from normal builds): proves on a
 * local native prover so the UI can be tested where browser proving cannot run. It sends the
 * witness inputs over HTTP, so it accepts nothing but a localhost URL.
 */
function testProver(url: string): ProverLike {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(url)) throw new Error('test prover must be on localhost');
  return {
    async prove(inputs) {
      const r = await fetch(url, { method: 'POST', body: JSON.stringify(inputs) });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} took too long.`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

let proverPromise: Promise<ProverLike> | undefined;
async function prover(): Promise<ProverLike> {
  proverPromise ??= (async () => {
    if (import.meta.env.VITE_TEST_PROVER_URL) return testProver(import.meta.env.VITE_TEST_PROVER_URL);
    const [{ Prover }, circuit, srs] = await Promise.all([
      import('@fractal/sdk'),
      fetch('/circuit/transact.json').then((r) => r.json()),
      loadCrs(),
    ]);
    // Threads need a cross-origin isolated page (the wallet pages); elsewhere (the terminal, which
    // embeds a chart) bb.js proves on one thread. Some browsers and devices stall or run out of
    // memory with many threads, so a multi-threaded proof that fails or stalls is retried once on a
    // single thread, and the app stays on one thread after that.
    type Engine = InstanceType<typeof Prover>;
    const make = (n: number, backend: 'worker' | 'main') => {
      const t0 = performance.now();
      return new Prover(circuit, {
        threads: n, srs, backend,
        onStage: (stage) => report('proof', `${backend}:${stage}`, { threads: n, ms: performance.now() - t0 }),
      });
    };
    const pageThread = () => new Promise((r) => setTimeout(r, 60)); // let the status text paint first
    let forced: string | null = null;
    try { forced = localStorage.getItem('fractal-prover'); } catch { /* storage blocked */ }
    // Ways to run the engine, best first. Some browsers never start bb.js's Web Worker (seen on
    // Chrome for macOS): then the engine runs on the page's own thread, which always works but
    // freezes the page while it proves.
    const plans: { threads: number; backend: 'worker' | 'main' }[] = forced === 'main'
      ? [{ threads: 1, backend: 'main' }]
      : [
          ...(globalThis.crossOriginIsolated ? [{ threads: Math.min(navigator.hardwareConcurrency || 4, 4), backend: 'worker' as const }] : []),
          { threads: 1, backend: 'worker' },
          { threads: 1, backend: 'main' },
        ];
    report('proof', 'device', { message: `cores ${navigator.hardwareConcurrency ?? '?'} mem ${(navigator as { deviceMemory?: number }).deviceMemory ?? '?'} plans ${plans.map((p) => `${p.backend}${p.threads}`).join(',')}` });
    let engine: Engine | undefined;
    let plan = 0;

    /** An engine that has started, trying each plan in turn. The choice sticks for the session. */
    async function startedEngine(): Promise<Engine> {
      for (; plan < plans.length; plan++) {
        const { threads, backend } = plans[plan];
        engine ??= make(threads, backend);
        if (backend === 'main') await pageThread();
        try {
          await withTimeout(engine.ready(), backend === 'main' ? 120_000 : plan === 0 ? 20_000 : 10_000, 'Starting the proof engine');
          // Remember a browser that needs the page-thread engine, so later visits skip the wait.
          if (backend === 'main' && plans.length > 1) { try { localStorage.setItem('fractal-prover', 'main'); } catch { /* storage blocked */ } }
          return engine;
        } catch (e) {
          report('proof', 'engine-failed', { threads, message: `${backend}: ${(e as Error)?.message ?? e}` });
          engine.destroy().catch(() => undefined);
          engine = undefined;
        }
      }
      plan = plans.length - 1; // keep trying the last resort next time
      throw new Error('This browser could not start the proof engine. Try Chrome or Brave with extensions turned off.');
    }

    return {
      async prove(inputs) {
        const t0 = performance.now();
        report('proof', 'start');
        let e1: Engine;
        try {
          e1 = await startedEngine();
        } catch (e) {
          report('proof', 'failed', { ms: performance.now() - t0, message: e });
          throw e;
        }
        const { threads, backend } = plans[plan];
        if (backend === 'main') await pageThread();
        try {
          const out = await withTimeout(e1.prove(inputs), backend === 'main' || threads === 1 ? 300_000 : 90_000, 'Building the proof');
          report('proof', 'done', { threads, ms: performance.now() - t0, message: backend });
          return out;
        } catch (e) {
          report('proof', 'failed', { threads, ms: performance.now() - t0, message: `${backend}: ${(e as Error)?.message ?? e}` });
          throw e;
        }
      },
    };
  })();
  proverPromise.catch(() => (proverPromise = undefined));
  return proverPromise;
}

export function vaultConfig(c: AppConfig) {
  return {
    chainId: c.chainId,
    vault: c.vault,
    entryPoint: c.entryPoint,
    startBlock: BigInt(c.startBlock),
    domain: window.location.host,
  };
}

export async function createClient(c: AppConfig, wallet: WalletClient<Transport, Chain, Account>): Promise<PrivacyClient> {
  const { PrivacyClient } = await import('@fractal/sdk');
  return PrivacyClient.create(vaultConfig(c), publicClientFor(c), wallet, await prover());
}

export async function createLinkClient(c: AppConfig, wallet: WalletClient<Transport, Chain, Account>, seed: Uint8Array) {
  const { PrivacyClient } = await import('@fractal/sdk');
  return PrivacyClient.forLink(vaultConfig(c), publicClientFor(c), wallet, await prover(), seed);
}

async function gasSettings(client: PrivacyClient, callGasLimit: bigint): Promise<GasSettings> {
  const fees = await client.publicClient.estimateFeesPerGas();
  return {
    verificationGasLimit: 8_000_000n,
    callGasLimit,
    preVerificationGas: 300_000n,
    maxFeePerGas: ((fees.maxFeePerGas ?? 0n) * 3n) / 2n + 1n,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
  };
}

/** Bundler (private gas) when configured and chosen; otherwise the wallet submits. */
export async function submitMode(c: AppConfig, client: PrivacyClient, privateGas: boolean, callGas = CALL_GAS_EXIT): Promise<SubmitMode> {
  if (c.bundlerUrl && privateGas) return { kind: 'bundler', bundlerUrl: c.bundlerUrl, gas: await gasSettings(client, callGas) };
  return { kind: 'direct' };
}

export const tokenBy = (c: AppConfig, address: string): TokenInfo =>
  c.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase()) ?? { address: address as `0x${string}`, symbol: `${address.slice(0, 6)}…`, decimals: 18 };

export function errorText(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  const msg = err.shortMessage ?? err.message ?? String(e);
  if (/user rejected|denied/i.test(msg)) return 'You declined the request in your wallet.';
  if (/insufficient private balance/i.test(msg)) return 'Your private balance is too low for this amount plus gas.';
  if (/private gas needs an ETH note/i.test(msg)) return 'Private gas is paid in ETH. Shield a little ETH first, or turn private gas off.';
  if (/too many notes/i.test(msg)) return 'Your balance is spread over many small notes. Send yourself a payment to combine them, then try again.';
  if (/has not registered/i.test(msg)) return 'That address has not turned on private payments. Ask for their fx1 private address instead.';
  if (/insufficient funds/i.test(msg)) return 'Your wallet does not have enough ETH for this amount plus gas.';
  if (/not a fractal private address|malformed private address/i.test(msg)) return 'That private address is not valid. Check it was copied in full.';
  return msg.split('\n')[0];
}
