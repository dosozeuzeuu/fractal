// Private bridge through Across (https://across.to).
//
// In:  from another chain, deposit ETH into Across with the vault's deposit handler as the recipient
//      and `client.bridgeInMessage(outputAmount)` as the message. The relayer's fill shields exactly
//      `outputAmount` into the vault as your note; your Robinhood Chain address never appears.
// Out: `client.bridgeOut(...)` sends ETH from your notes through the bridge adapter into Across on
//      Robinhood Chain; the vault pays the bridge, and the recipient receives on the other chain.
import { encodeAbiParameters, encodeFunctionData, type Address, type Hex } from 'viem';

export const ROBINHOOD_CHAIN_ID = 4663;

/** Across SpokePool per chain (docs.across.to, Chains & Contracts). */
export const ACROSS_SPOKE_POOLS: Record<number, Address> = {
  1: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5',
  10: '0x6f26Bf09B1C792e3228e5467807a900A503c0281',
  8453: '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',
  42161: '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A',
  4663: '0xD29C85F15DF544bA632C9E25829fd29d767d7978',
};

/** Wrapped ETH per chain: Across's input/output token for native ETH. */
export const WETH: Record<number, Address> = {
  1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  10: '0x4200000000000000000000000000000000000006',
  8453: '0x4200000000000000000000000000000000000006',
  42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  4663: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
};

export const BRIDGE_CHAINS: { id: number; name: string; explorer: string }[] = [
  { id: 1, name: 'Ethereum', explorer: 'https://etherscan.io' },
  { id: 8453, name: 'Base', explorer: 'https://basescan.org' },
  { id: 42161, name: 'Arbitrum', explorer: 'https://arbiscan.io' },
  { id: 10, name: 'Optimism', explorer: 'https://optimistic.etherscan.io' },
];

export const spokePoolAbi = [
  {
    type: 'function',
    name: 'depositV3',
    stateMutability: 'payable',
    inputs: [
      { name: 'depositor', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'inputToken', type: 'address' },
      { name: 'outputToken', type: 'address' },
      { name: 'inputAmount', type: 'uint256' },
      { name: 'outputAmount', type: 'uint256' },
      { name: 'destinationChainId', type: 'uint256' },
      { name: 'exclusiveRelayer', type: 'address' },
      { name: 'quoteTimestamp', type: 'uint32' },
      { name: 'fillDeadline', type: 'uint32' },
      { name: 'exclusivityDeadline', type: 'uint32' },
      { name: 'message', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

export interface AcrossQuote {
  outputAmount: bigint;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusiveRelayer: Address;
  exclusivityDeadline: number;
  spokePool: Address;
  estimatedFillTimeSec: number;
  isAmountTooLow: boolean;
  minDeposit: bigint;
  maxDeposit: bigint;
}

/**
 * Fetches an Across quote. `endpoint` is the suggested-fees URL: the app passes its own `/api/across`
 * proxy (no CORS issues, optional API key server-side); the default is Across's public API.
 */
export async function acrossQuote(
  q: { originChainId: number; destinationChainId: number; amount: bigint; recipient: Address; message?: Hex },
  endpoint = 'https://app.across.to/api/suggested-fees',
): Promise<AcrossQuote> {
  const inputToken = WETH[q.originChainId];
  const outputToken = WETH[q.destinationChainId];
  if (!inputToken || !outputToken) throw new Error('unsupported chain for the private bridge');
  const params = new URLSearchParams({
    inputToken,
    outputToken,
    originChainId: String(q.originChainId),
    destinationChainId: String(q.destinationChainId),
    amount: q.amount.toString(),
    recipient: q.recipient,
  });
  if (q.message && q.message !== '0x') params.set('message', q.message);
  const r = await fetch(`${endpoint}?${params}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message ? `Across: ${j.message}` : `Across quote failed (${r.status})`);
  return {
    outputAmount: BigInt(j.outputAmount),
    quoteTimestamp: Number(j.timestamp),
    fillDeadline: Number(j.fillDeadline),
    exclusiveRelayer: j.exclusiveRelayer as Address,
    exclusivityDeadline: Number(j.exclusivityDeadline ?? 0),
    spokePool: (j.spokePoolAddress ?? ACROSS_SPOKE_POOLS[q.originChainId]) as Address,
    estimatedFillTimeSec: Number(j.estimatedFillTimeSec ?? 0),
    isAmountTooLow: Boolean(j.isAmountTooLow),
    minDeposit: BigInt(j.limits?.minDeposit ?? 0),
    maxDeposit: BigInt(j.limits?.maxDeposit ?? 0),
  };
}

/** What the vault hands the bridge adapter for a bridge-out of `amount`: amount less the 1% exit fee. */
export function bridgeOutInput(amount: bigint): bigint {
  return amount - (amount * 100n) / 10_000n;
}

export interface BridgeOutRoute {
  /** Gets the ETH back on Robinhood Chain if Across never fills. */
  refundTo: Address;
  recipient: Address;
  destinationChainId: number;
  outputAmount: bigint;
  exclusiveRelayer: Address;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusivityDeadline: number;
  /** WETH on this chain (the adapter's); defaults to Robinhood Chain's. */
  weth?: Address;
}

/** The adapter's route data: depositV3's first eleven arguments, eleven ABI words. */
export function encodeBridgeOutRoute(r: BridgeOutRoute & { inputAmount: bigint }): Hex {
  const outputToken = WETH[r.destinationChainId];
  if (!outputToken) throw new Error('unsupported destination chain');
  return encodeAbiParameters(
    [
      { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' },
      { type: 'uint32' }, { type: 'uint32' }, { type: 'uint32' },
    ],
    [
      r.refundTo, r.recipient, r.weth ?? WETH[ROBINHOOD_CHAIN_ID], outputToken,
      r.inputAmount, r.outputAmount, BigInt(r.destinationChainId), r.exclusiveRelayer,
      r.quoteTimestamp, r.fillDeadline, r.exclusivityDeadline,
    ],
  );
}

/**
 * The origin-chain transaction for a private bridge in: ETH into Across, to the deposit handler on
 * Robinhood Chain with the shield message. `depositor` gets the refund if it never fills.
 */
export function bridgeInTransaction(p: {
  originChainId: number;
  depositor: Address;
  depositHandler: Address;
  amount: bigint;
  quote: AcrossQuote;
  message: Hex;
}): { to: Address; data: Hex; value: bigint; chainId: number } {
  const data = encodeFunctionData({
    abi: spokePoolAbi,
    functionName: 'depositV3',
    args: [
      p.depositor,
      p.depositHandler,
      WETH[p.originChainId],
      WETH[ROBINHOOD_CHAIN_ID],
      p.amount,
      p.quote.outputAmount,
      BigInt(ROBINHOOD_CHAIN_ID),
      p.quote.exclusiveRelayer,
      p.quote.quoteTimestamp,
      p.quote.fillDeadline,
      p.quote.exclusivityDeadline,
      p.message,
    ],
  });
  return { to: ACROSS_SPOKE_POOLS[p.originChainId], data, value: p.amount, chainId: p.originChainId };
}
