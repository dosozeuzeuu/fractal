import { createPublicClient, createWalletClient, custom, http, type Account, type Chain, type EIP1193Provider, type PublicClient, type Transport, type WalletClient } from 'viem';
import { chainOf, type AppConfig } from './config';

declare global {
  interface Window { ethereum?: EIP1193Provider }
}

export function publicClientFor(c: AppConfig): PublicClient {
  return createPublicClient({ chain: chainOf(c), transport: http(c.rpc) }) as PublicClient;
}

export async function connectWallet(c: AppConfig): Promise<WalletClient<Transport, Chain, Account>> {
  const eth = window.ethereum;
  if (!eth) throw new Error('No wallet found. Install MetaMask or Rabby, then reload this page.');
  const [address] = (await eth.request({ method: 'eth_requestAccounts' })) as `0x${string}`[];
  if (!address) throw new Error('The wallet did not share an account.');
  await ensureChain(c);
  return createWalletClient({ account: address, chain: chainOf(c), transport: custom(eth) });
}

export async function ensureChain(c: AppConfig): Promise<void> {
  const eth = window.ethereum!;
  const current = Number(await eth.request({ method: 'eth_chainId' }));
  if (current === c.chainId) return;
  const chainId = `0x${c.chainId.toString(16)}` as const;
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch {
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId,
        chainName: c.name,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [c.rpc],
        blockExplorerUrls: c.explorer ? [c.explorer] : undefined,
      }],
    });
  }
}

const CHAIN_PARAMS: Record<number, { chainName: string; rpcUrls: string[]; blockExplorerUrls: string[] }> = {
  1: { chainName: 'Ethereum', rpcUrls: ['https://eth.llamarpc.com'], blockExplorerUrls: ['https://etherscan.io'] },
  10: { chainName: 'OP Mainnet', rpcUrls: ['https://mainnet.optimism.io'], blockExplorerUrls: ['https://optimistic.etherscan.io'] },
  8453: { chainName: 'Base', rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
  42161: { chainName: 'Arbitrum One', rpcUrls: ['https://arb1.arbitrum.io/rpc'], blockExplorerUrls: ['https://arbiscan.io'] },
};

/**
 * Sends one transaction from the connected wallet on another chain (a bridge deposit), then switches
 * the wallet back to fractal's chain. Returns the transaction hash.
 */
export async function sendOnChain(
  c: AppConfig,
  from: `0x${string}`,
  tx: { chainId: number; to: `0x${string}`; data: `0x${string}`; value: bigint },
): Promise<`0x${string}`> {
  const eth = window.ethereum;
  if (!eth) throw new Error('No wallet found.');
  const chainId = `0x${tx.chainId.toString(16)}` as const;
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (e) {
    const p = CHAIN_PARAMS[tx.chainId];
    if (!p || (e as { code?: number }).code !== 4902) throw e;
    await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, ...p }] });
  }
  try {
    const current = Number(await eth.request({ method: 'eth_chainId' }));
    if (current !== tx.chainId) throw new Error('The wallet did not switch networks.');
    return (await eth.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: tx.to, data: tx.data, value: `0x${tx.value.toString(16)}` }],
    })) as `0x${string}`;
  } finally {
    await ensureChain(c).catch(() => undefined);
  }
}
