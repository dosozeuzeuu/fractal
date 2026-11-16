import { encodeAbiParameters, type Address, type Hex, type PublicClient } from 'viem';
import type { AppConfig, TokenInfo } from './config';

const mockAbi = [{ type: 'function', name: 'price', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] }] as const;
const quoterAbi = [{
  type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
  inputs: [{ type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'amountIn', type: 'uint256' },
    { name: 'fee', type: 'uint24' }, { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ] }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'uint256' }],
}] as const;

/** Expected output of swapping `amountIn` (after the vault's swap fee) — for display and minOut. */
export async function quote(pc: PublicClient, c: AppConfig, tin: TokenInfo, tout: TokenInfo, amountIn: bigint): Promise<bigint> {
  const s = c.swap!;
  const net = amountIn - (amountIn * BigInt(c.swapFeeBps)) / 10_000n;
  if (s.kind === 'mock') {
    const [num, den] = await Promise.all([0n, 1n].map((i) =>
      pc.readContract({ address: s.adapter, abi: mockAbi, functionName: 'price', args: [tin.address, tout.address, i] }),
    ));
    if (den === 0n) throw new Error(`No ${tin.symbol} → ${tout.symbol} market on this DEX.`);
    return (net * num) / den;
  }
  const w = (a: Address) => (a === '0x0000000000000000000000000000000000000000' ? s.weth! : a);
  const { result } = await pc.simulateContract({
    address: s.quoter!, abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: w(tin.address), tokenOut: w(tout.address), amountIn: net, fee: s.feeTier!, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

export function routeData(c: AppConfig): Hex {
  return c.swap?.kind === 'uniswap-v3' ? encodeAbiParameters([{ type: 'uint24' }], [c.swap.feeTier!]) : '0x';
}
