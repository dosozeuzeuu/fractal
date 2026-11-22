// fractal's own minimal ERC-4337 bundler (a Vercel serverless function at /api/bundler).
//
// It accepts user operations for the fractal vault only, simulates EntryPoint.handleOps first (so a
// bad operation costs the relayer nothing), then submits it from a relayer key. The vault pays the
// gas back from the user's private ETH through the EntryPoint, so the relayer is reimbursed and no
// user address ever appears on-chain.
//
// Env (set in the Vercel project, never in code):
//   RELAYER_PRIVATE_KEY  a dedicated hot wallet with a little ETH on Robinhood Chain (required)
//   VAULT                the vault proxy address (required)
//   RPC_URL              default https://rpc.mainnet.chain.robinhood.com
//   ENTRY_POINT          default the canonical v0.8 EntryPoint
import { createPublicClient, createWalletClient, defineChain, http, isAddress, isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const ENTRY_POINT = (process.env.ENTRY_POINT || '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108').toLowerCase();
const VAULT = (process.env.VAULT || '').toLowerCase();

const entryPointAbi = [
  {
    type: 'function', name: 'handleOps', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'ops', type: 'tuple[]', components: [
        { name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' },
        { name: 'callData', type: 'bytes' }, { name: 'accountGasLimits', type: 'bytes32' },
        { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' },
        { name: 'paymasterAndData', type: 'bytes' }, { name: 'signature', type: 'bytes' },
      ] },
      { name: 'beneficiary', type: 'address' },
    ],
  },
  {
    type: 'function', name: 'getUserOpHash', stateMutability: 'view', outputs: [{ type: 'bytes32' }],
    inputs: [{ name: 'op', type: 'tuple', components: [
      { name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' },
      { name: 'callData', type: 'bytes' }, { name: 'accountGasLimits', type: 'bytes32' },
      { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' },
      { name: 'paymasterAndData', type: 'bytes' }, { name: 'signature', type: 'bytes' },
    ] }],
  },
];

const pack128 = (hi, lo) => `0x${hi.toString(16).padStart(32, '0')}${lo.toString(16).padStart(32, '0')}`;
const big = (x) => {
  if (typeof x !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(x)) throw new Error('bad quantity');
  return BigInt(x);
};

function packed(op) {
  if (!isAddress(op.sender) || op.sender.toLowerCase() !== VAULT) throw new Error('this bundler only relays the fractal vault');
  if (op.factory || op.paymaster) throw new Error('no factory or paymaster');
  if (!isHex(op.callData) || !isHex(op.signature)) throw new Error('bad callData or signature');
  const verificationGasLimit = big(op.verificationGasLimit);
  const callGasLimit = big(op.callGasLimit);
  const preVerificationGas = big(op.preVerificationGas);
  const maxFeePerGas = big(op.maxFeePerGas);
  const maxPriorityFeePerGas = big(op.maxPriorityFeePerGas);
  if (verificationGasLimit > 12_000_000n || callGasLimit > 3_000_000n || preVerificationGas > 1_000_000n) {
    throw new Error('gas limits too high');
  }
  return {
    op: {
      sender: op.sender, nonce: big(op.nonce), initCode: '0x', callData: op.callData,
      accountGasLimits: pack128(verificationGasLimit, callGasLimit), preVerificationGas,
      gasFees: pack128(maxPriorityFeePerGas, maxFeePerGas), paymasterAndData: '0x', signature: op.signature,
    },
    gas: verificationGasLimit + callGasLimit + preVerificationGas + 300_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const reply = (id, body) => res.status(200).send(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
  if (req.method !== 'POST') return res.status(405).send(JSON.stringify({ error: 'POST only' }));
  const { id = 1, method, params = [] } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  console.log(JSON.stringify({ fractal: 'bundler', method }));
  try {
    if (!process.env.RELAYER_PRIVATE_KEY || !VAULT) throw new Error('private gas is not configured on this site yet');
    const publicClient = createPublicClient({ transport: http(RPC) });
    const chainId = await publicClient.getChainId();
    if (method === 'eth_chainId') return reply(id, { result: `0x${chainId.toString(16)}` });
    if (method === 'eth_supportedEntryPoints') return reply(id, { result: [ENTRY_POINT] });
    if (method !== 'eth_sendUserOperation') throw new Error(`unsupported method ${method}`);
    if (String(params[1] || '').toLowerCase() !== ENTRY_POINT) throw new Error('unsupported EntryPoint');

    const p = packed(params[0] || {});
    const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY);
    const chain = defineChain({ id: chainId, name: 'chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
    const wallet = createWalletClient({ account, chain, transport: http(RPC) });

    // Simulate first: a failing operation is refused here, before the relayer pays anything.
    await publicClient.simulateContract({
      account, address: ENTRY_POINT, abi: entryPointAbi, functionName: 'handleOps', args: [[p.op], account.address], gas: p.gas,
    });
    const userOpHash = await publicClient.readContract({ address: ENTRY_POINT, abi: entryPointAbi, functionName: 'getUserOpHash', args: [p.op] });
    const hash = await wallet.writeContract({
      address: ENTRY_POINT, abi: entryPointAbi, functionName: 'handleOps', args: [[p.op], account.address], gas: p.gas,
      maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== 'success') throw new Error(`handleOps reverted (${hash})`);
    return reply(id, { result: userOpHash, transactionHash: hash });
  } catch (e) {
    const message = (e && (e.shortMessage || e.message)) || String(e);
    console.log(JSON.stringify({ fractal: 'bundler', method, error: message.split('\n')[0].replace(/0x[0-9a-fA-F]{6,}/g, '0x…').slice(0, 300) }));
    return reply(id, { error: { code: -32500, message: message.split('\n')[0] } });
  }
}
