import { encodeAbiParameters, erc20Abi, type Address, type Hex, type PublicClient } from 'viem';
import type { AppConfig } from './config';

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/** A market the terminal can show. `tradable` = the vault can route it privately (Uniswap v3 vs WETH). */
export interface Market {
  pair: Address; // pool address ('' for the local mock DEX)
  token: Address;
  symbol: string;
  name: string;
  priceUsd?: number;
  change24h?: number;
  volume24h?: number;
  liquidityUsd?: number;
  marketCap?: number;
  imageUrl?: string;
  dex: string;
  tradable: boolean;
  why?: string; // why it isn't tradable privately yet
}

interface DsPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  info?: { imageUrl?: string };
}

const DS = 'https://api.dexscreener.com';

function toMarket(p: DsPair, weth: Address): Market | null {
  const w = weth.toLowerCase();
  const baseIsWeth = p.baseToken.address.toLowerCase() === w;
  const quoteIsWeth = p.quoteToken.address.toLowerCase() === w;
  const t = baseIsWeth ? p.quoteToken : p.baseToken;
  if (t.address.toLowerCase() === w) return null;
  const v3 = p.dexId === 'uniswap' && (p.labels ?? []).includes('v3');
  const tradable = v3 && (baseIsWeth || quoteIsWeth);
  return {
    pair: p.pairAddress as Address,
    token: t.address as Address,
    symbol: t.symbol,
    name: t.name,
    priceUsd: baseIsWeth ? undefined : p.priceUsd ? Number(p.priceUsd) : undefined,
    change24h: baseIsWeth ? undefined : p.priceChange?.h24,
    volume24h: p.volume?.h24,
    liquidityUsd: p.liquidity?.usd,
    marketCap: p.marketCap ?? p.fdv,
    imageUrl: p.info?.imageUrl,
    dex: `${p.dexId}${p.labels?.length ? ` ${p.labels.join('/')}` : ''}`,
    tradable,
    why: tradable ? undefined : !(baseIsWeth || quoteIsWeth) ? 'not paired with ETH' : 'not a Uniswap v3 pool yet',
  };
}

/** One market per token: the deepest tradable pool, else the deepest pool. */
function dedupe(ms: Market[]): Market[] {
  const best = new Map<string, Market>();
  for (const m of ms) {
    const k = m.token.toLowerCase();
    const cur = best.get(k);
    const score = (x: Market) => (x.tradable ? 1e15 : 0) + (x.liquidityUsd ?? 0);
    if (!cur || score(m) > score(cur)) best.set(k, m);
  }
  return [...best.values()];
}

export async function trending(c: AppConfig): Promise<Market[]> {
  if (!c.dexscreener) return localMarkets(c);
  const weth = c.swap!.weth!;
  const r = await fetch(`${DS}/token-pairs/v1/${c.dexscreener}/${weth}`);
  if (!r.ok) throw new Error('Market data is unavailable right now.');
  const pairs = (await r.json()) as DsPair[];
  return dedupe(pairs.filter((p) => p.chainId === c.dexscreener).map((p) => toMarket(p, weth)).filter((m): m is Market => !!m))
    .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
    .slice(0, 40);
}

export async function search(c: AppConfig, q: string): Promise<Market[]> {
  q = q.trim();
  if (!q) return trending(c);
  if (!c.dexscreener) {
    const s = q.toLowerCase();
    return localMarkets(c).filter((m) => m.symbol.toLowerCase().includes(s) || m.token.toLowerCase() === s);
  }
  const weth = c.swap!.weth!;
  const url = /^0x[0-9a-fA-F]{40}$/.test(q)
    ? `${DS}/token-pairs/v1/${c.dexscreener}/${q}`
    : `${DS}/latest/dex/search?q=${encodeURIComponent(q)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Search is unavailable right now.');
  const j = await r.json();
  const pairs = (Array.isArray(j) ? j : j.pairs ?? []) as DsPair[];
  return dedupe(pairs.filter((p) => p.chainId === c.dexscreener).map((p) => toMarket(p, weth)).filter((m): m is Market => !!m))
    .sort((a, b) => Number(b.tradable) - Number(a.tradable) || (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
    .slice(0, 40);
}

/** Local chain: the config's test tokens on the fixed-price mock DEX. */
function localMarkets(c: AppConfig): Market[] {
  return c.tokens
    .filter((t) => t.address !== ZERO)
    .map((t) => ({ pair: '' as Address, token: t.address, symbol: t.symbol, name: t.symbol, dex: 'mock DEX', tradable: true }));
}

export function chartUrl(c: AppConfig, m: Market): string | null {
  if (!c.dexscreener || !m.pair) return null;
  const params = 'embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=15';
  return `https://dexscreener.com/${c.dexscreener}/${m.pair}?${params}`;
}

// ---------------------------------------------------------------- on-chain

const poolAbi = [{ type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] }] as const;
const mockAbi = [{ type: 'function', name: 'price', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] }] as const;
const quoterAbi = [{
  type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
  inputs: [{ type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'amountIn', type: 'uint256' },
    { name: 'fee', type: 'uint24' }, { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ] }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'uint256' }],
}] as const;

const feeCache = new Map<string, number>();
export async function poolFee(pc: PublicClient, m: Market): Promise<number> {
  if (!m.pair) return 0;
  const k = m.pair.toLowerCase();
  if (!feeCache.has(k)) feeCache.set(k, Number(await pc.readContract({ address: m.pair, abi: poolAbi, functionName: 'fee' })));
  return feeCache.get(k)!;
}

const metaCache = new Map<string, { symbol: string; decimals: number }>();
export async function tokenMeta(pc: PublicClient, c: AppConfig, token: Address, fallbackSymbol = 'TOKEN') {
  const known = c.tokens.find((t) => t.address.toLowerCase() === token.toLowerCase());
  if (known) return { symbol: known.symbol, decimals: known.decimals };
  const k = token.toLowerCase();
  if (!metaCache.has(k)) {
    const [decimals, symbol] = await Promise.all([
      pc.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
      pc.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => fallbackSymbol),
    ]);
    metaCache.set(k, { symbol, decimals: Number(decimals) });
  }
  return metaCache.get(k)!;
}

/** Output for `amountIn` after the vault's swap fee, through the market's pool (or the mock DEX). */
export async function terminalQuote(
  pc: PublicClient,
  c: AppConfig,
  m: Market,
  side: 'buy' | 'sell',
  amountIn: bigint,
): Promise<bigint> {
  const s = c.swap!;
  const net = amountIn - (amountIn * BigInt(c.swapFeeBps)) / 10_000n;
  const tokenIn = side === 'buy' ? ZERO : m.token;
  const tokenOut = side === 'buy' ? m.token : ZERO;
  if (s.kind === 'mock') {
    const [num, den] = await Promise.all([0n, 1n].map((i) =>
      pc.readContract({ address: s.adapter, abi: mockAbi, functionName: 'price', args: [tokenIn, tokenOut, i] }),
    ));
    if (den === 0n) throw new Error('No market for this token on the local DEX.');
    return (net * num) / den;
  }
  const w = (a: Address) => (a === ZERO ? s.weth! : a);
  const { result } = await pc.simulateContract({
    address: s.quoter!, abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: w(tokenIn), tokenOut: w(tokenOut), amountIn: net, fee: await poolFee(pc, m), sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

/** The adapter's route data for this market: the pool's fee tier (none for the mock DEX). */
export async function terminalRoute(pc: PublicClient, c: AppConfig, m: Market): Promise<Hex> {
  if (c.swap?.kind !== 'uniswap-v3') return '0x';
  return encodeAbiParameters([{ type: 'uint24' }], [await poolFee(pc, m)]);
}

export const usd = (n?: number) =>
  n === undefined ? '–' : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toPrecision(3)}`;
