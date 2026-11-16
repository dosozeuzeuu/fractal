import type { GasSettings, PrivacyClient, ProverLike, SubmitMode } from '@fractal/sdk';
import { CALL_GAS_EXIT } from '@fractal/sdk/src/client';
import type { Account, Chain, Transport, WalletClient } from 'viem';
import { loadCrs } from './crs';
import type { AppConfig, TokenInfo } from './config';
import { publicClientFor } from './wallet';

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

let proverPromise: Promise<ProverLike> | undefined;
async function prover(): Promise<ProverLike> {
  proverPromise ??= (async () => {
    if (import.meta.env.VITE_TEST_PROVER_URL) return testProver(import.meta.env.VITE_TEST_PROVER_URL);
    const [{ Prover }, circuit, srs] = await Promise.all([
      import('@fractal/sdk'),
      fetch('/circuit/transact.json').then((r) => r.json()),
      loadCrs(),
    ]);
    return new Prover(circuit, { threads: Math.min(navigator.hardwareConcurrency || 4, 8), srs });
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
