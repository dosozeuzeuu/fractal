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
