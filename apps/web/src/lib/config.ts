import { defineChain, formatUnits, parseUnits, type Address, type Chain } from 'viem';

export interface TokenInfo {
  address: Address; // 0x0…0 = ETH
  symbol: string;
  decimals: number;
}

export interface SwapConfig {
  adapter: Address;
  /** 'mock' = the local fixed-price DEX; 'uniswap-v3' = Uniswap v3 through UniswapV3Adapter */
  kind: 'mock' | 'uniswap-v3';
  feeTier?: number; // Uniswap v3 pool fee, e.g. 3000 = 0.3%
  quoter?: Address; // Uniswap QuoterV2
  weth?: Address;
}

export interface BridgeConfig {
  /** AcrossBridgeAdapter: private bridge out */
  adapter: Address;
  /** AcrossDepositHandler: private bridge in */
  depositHandler: Address;
  /** WETH on this chain (the adapter's) */
  weth: Address;
  /** Across suggested-fees endpoint ('' = quotes unavailable, e.g. the local chain) */
  acrossApi: string;
}

export interface AppConfig {
  chainId: number;
  name: string;
  rpc: string;
  explorer: string;
  vault: Address;
  entryPoint: Address;
  feeCollector: Address;
  startBlock: string;
  devVerifier: boolean;
  bundlerUrl: string;
  tokens: TokenInfo[];
  swap?: SwapConfig;
  swapFeeBps: number;
  bridge?: BridgeConfig;
  /** Unlisted tokens can be bought privately (listed on first buy) */
  autoList?: boolean;
  /** DexScreener chain id for the terminal's market data ('' = none, e.g. the local chain) */
  dexscreener?: string;
}

let cached: Promise<AppConfig> | undefined;
export function loadConfig(): Promise<AppConfig> {
  cached ??= fetch('/config.json').then((r) => {
    if (!r.ok) throw new Error('config.json is missing: run `npm -w @fractal/web run config`');
    return r.json();
  });
  return cached;
}

export function chainOf(c: AppConfig): Chain {
  return defineChain({
    id: c.chainId,
    name: c.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [c.rpc] } },
    blockExplorers: c.explorer ? { default: { name: 'Explorer', url: c.explorer } } : undefined,
  });
}

export const fmt = (amount: bigint, t: TokenInfo, digits = 6) =>
  Number(formatUnits(amount, t.decimals)).toLocaleString(undefined, { maximumFractionDigits: digits });

export function parseAmount(s: string, t: TokenInfo): bigint | null {
  try {
    const v = parseUnits(s.trim() as `${number}`, t.decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}
