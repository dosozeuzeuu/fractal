// End-to-end test against a local anvil chain with REAL proofs (no mocks except the local DEX):
//   ETH and token shields · private sends (ETH, token, to a private address) via ERC-4337 and
//   direct · private swaps (ETH→token through ERC-4337, token→token direct, slippage refund) ·
//   payment links (create, claim) · payment receipts (verify, reject a forged one) · withdrawals
//   (ETH, token, large-exit hold) · fee sweep per token · and attacks: replay, tampered recipient,
//   tampered swap minimum, wrong signer. Per-token solvency is checked after every step.
//
//   bash scripts/local-chain.sh && CRS_PATH=~/.bb-crs-dev npm -w @fractal/sdk run e2e
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  parseEther,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import {
  CALL_GAS_EXIT,
  CALL_GAS_SWAP,
  ETH,
  NoteKind,
  PrivacyClient,
  bridgeOutInput,
  Prover,
  decodePrivateAddress,
  decodeReceipt,
  encodeReceipt,
  exitFee,
  feeCollectorAbi,
  gasFeeFor,
  vaultAbi,
  verifyReceipt,
  type GasSettings,
  type SubmitMode,
} from '../src/index.js';

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const root = new URL('../../../', import.meta.url);
const d = JSON.parse(readFileSync(new URL('contracts/deployments/31337.json', root), 'utf8'));
const circuit = JSON.parse(readFileSync(new URL('packages/sdk/circuit/transact.json', root), 'utf8'));

const KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // deployer / admin / team
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // alice
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // bob
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // relayer (self-run bundler)
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // carol (public recipient)
];
const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
const testClient = createTestClient({ chain: foundry, mode: 'anvil', transport: http(RPC) });
const wallet = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain: foundry, transport: http(RPC) });
const [adminW, aliceW, bobW, relayerW, carolW] = KEYS.map(wallet);
const vault = d.vault as Address;
const USD = d.tokenA as Address; // tUSD, 6 decimals
const GOLD = d.tokenB as Address; // tGOLD, 18 decimals
const DEX = d.swapAdapter as Address;
const MEME = d.tokenC as Address; // tMEME, unlisted until its first private buy
const config = { chainId: foundry.id, vault, entryPoint: d.entryPoint as Address, startBlock: 0n, domain: 'localhost:5173' };
const usd = (s: string) => parseUnits(s, 6);

async function gas(callGasLimit: bigint): Promise<GasSettings> {
  const block = await publicClient.getBlock();
  return {
    verificationGasLimit: 8_000_000n,
    callGasLimit,
    preVerificationGas: 80_000n,
    maxFeePerGas: (block.baseFeePerGas ?? 1_000_000_000n) * 2n + 1_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
  };
}
const viaBundler = async (cg = CALL_GAS_EXIT): Promise<SubmitMode> => ({ kind: 'handleOps', submitter: relayerW, gas: await gas(cg) });
const direct: SubmitMode = { kind: 'direct' };

const view = <T>(functionName: string, args: unknown[] = []) =>
  publicClient.readContract({ address: vault, abi: vaultAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
const tokenBal = (token: Address, who: Address) =>
  token === ETH ? publicClient.getBalance({ address: who }) : publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });

async function expectRevert(p: Promise<unknown>, name: string) {
  try {
    await p;
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    assert.ok(msg.includes(name), `expected "${name}", got: ${msg.slice(0, 300)}`);
    return;
  }
  assert.fail(`expected "${name}", but it succeeded`);
}

async function solvent(label: string) {
  for (const token of [ETH, USD, GOLD, MEME]) {
    const [b, pe, ps, f] = await Promise.all(
      ['backing', 'pendingExitTotal', 'pendingSwapTotal', 'feesAccrued'].map((fn) => view<bigint>(fn, [token])),
    );
    assert.equal(await tokenBal(token, vault), b + pe + ps + f, `solvency ${label} (${token})`);
  }
}

const step = (s: string) => console.log(`\n▸ ${s}`);
const t0 = Date.now();

async function main() {
  const prover = new Prover(circuit, { crsPath: process.env.CRS_PATH });
  const alice = await PrivacyClient.create(config, publicClient, aliceW, prover);
  const bob = await PrivacyClient.create(config, publicClient, bobW, prover);
  const sync = () => Promise.all([alice.sync(), bob.sync()]);

  // test tokens: anyone can mint
  const mintAbi = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }] as const;
  await publicClient.waitForTransactionReceipt({ hash: await aliceW.writeContract({ address: USD, abi: mintAbi, functionName: 'mint', args: [aliceW.account.address, usd('100000')] }) });

  step('activate and register');
  await alice.activate();
  await bob.activate();
  await alice.register();
  await bob.register();
  const again = await PrivacyClient.create(config, publicClient, aliceW, prover);
  assert.equal((await again.activate()).opk, alice.keys!.opk, 'same wallet, same keys');

  step('shield 3 ETH and 10,000 tUSD');
  await alice.shield(parseEther('3'));
  await alice.shield(usd('10000'), USD);
  await sync();
  assert.equal(alice.balance(ETH), parseEther('3'));
  assert.equal(alice.balance(USD), usd('10000'));
  await solvent('shield');

  step('private send: 0.5 ETH to bob via ERC-4337 (gas from notes)');
  let t = Date.now();
  const m1 = await viaBundler();
  const ethBefore = await publicClient.getBalance({ address: aliceW.account.address });
  const payHash = await alice.send(bobW.account.address, parseEther('0.5'), m1);
  console.log(`  proved + submitted in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  const r1 = await publicClient.getTransactionReceipt({ hash: payHash });
  console.log(`  handleOps gas used: ${r1.gasUsed}`);
  assert.equal(r1.from.toLowerCase(), relayerW.account.address.toLowerCase());
  assert.equal(await publicClient.getBalance({ address: aliceW.account.address }), ethBefore, "alice's wallet paid nothing");
  await sync();
  const g1 = gasFeeFor((m1 as { gas: GasSettings }).gas);
  assert.equal(bob.balance(ETH), parseEther('0.5'));
  assert.equal(alice.balance(ETH), parseEther('2.5') - g1);
  await solvent('send');

  step('payment receipt: alice proves she paid bob 0.5 ETH');
  const change = alice.notes.find((n) => n.kind === NoteKind.Change && n.memoAmount === parseEther('0.5'))!;
  const [bobOpk] = await alice.keysOf(bobW.account.address);
  const receipt = alice.receiptFor(change, bobOpk);
  const decoded = decodeReceipt(encodeReceipt(receipt));
  const ok = await verifyReceipt(publicClient, decoded);
  assert.ok(ok.valid && ok.recipientRegistered, 'receipt verifies');
  const forged = await verifyReceipt(publicClient, { ...decoded, amount: parseEther('5') });
  assert.ok(!forged.valid, 'forged amount rejected');
  const wrongTo = await verifyReceipt(publicClient, { ...decoded, to: carolW.account.address });
  assert.ok(!wrongTo.valid, 'wrong recipient rejected');

  step('private token send: 2,500 tUSD to bob via ERC-4337 (gas from an ETH note)');
  await alice.send(bobW.account.address, usd('2500'), await viaBundler(), USD);
  await sync();
  assert.equal(bob.balance(USD), usd('2500'));
  assert.equal(alice.balance(USD), usd('7500'));
  await solvent('token send');

  step('attack: replaying the same user operation is rejected');
  const replay = await alice.prepare({ pay: { to: bob.selfKeys(), amount: 1n }, mode: m1 });
  await alice.submit(replay, m1);
  await expectRevert(alice.submit(replay, m1), 'reverted');
  await sync();

  step('private swap: 1 ETH → tUSD via ERC-4337');
  const ms = await viaBundler(CALL_GAS_SWAP);
  const usdBefore = alice.balance(USD);
  const swapHash = await alice.swapPrivately(ETH, { tokenOut: USD, amountIn: parseEther('1'), minOut: usd('2900'), adapter: DEX }, ms);
  console.log(`  swap handleOps gas used: ${(await publicClient.getTransactionReceipt({ hash: swapHash })).gasUsed}`);
  await alice.sync();
  // 0.3% swap fee, 3000 tUSD per ETH
  assert.equal(alice.balance(USD) - usdBefore, usd('2991'));
  assert.equal(alice.pendingSwaps.size, 0, 'swap settled and its output note found');
  await solvent('swap eth→usd');

  step('private swap: 2,000 tUSD → tGOLD, direct');
  await alice.swapPrivately(USD, { tokenOut: GOLD, amountIn: usd('2000'), minOut: parseEther('0.99') , adapter: DEX }, direct);
  await alice.sync();
  assert.equal(alice.balance(GOLD), parseEther('0.997'));
  await solvent('swap usd→gold');

  step('private swap with an impossible minimum is refunded as a note');
  const goldBefore = alice.balance(GOLD);
  await alice.swapPrivately(GOLD, { tokenOut: USD, amountIn: parseEther('0.5'), minOut: usd('5000'), adapter: DEX }, direct);
  await alice.sync();
  assert.equal(alice.balance(GOLD), goldBefore, 'refunded in full');
  await solvent('swap refund');

  step('attack: changing the swap minimum after proving fails the proof');
  const sp = await alice.prepare({ token: USD, swap: { tokenOut: GOLD, amountIn: usd('100'), minOut: parseEther('0.04'), adapter: DEX }, mode: direct });
  sp.tx = { ...sp.tx, ext: { ...sp.tx.ext, swapMinOut: 0n } };
  await expectRevert(alice.submit(sp, direct), 'InvalidProof');

  step('payment link: alice funds a 0.2 ETH link, bob claims it into his notes');
  const { seed } = await alice.createLink(parseEther('0.2'), direct);
  await alice.sync();
  assert.equal(alice.linksCreated().length, 1);
  const link = await PrivacyClient.forLink(config, publicClient, bobW, prover, seed);
  await link.sync();
  assert.equal(link.balance(ETH), parseEther('0.2'), 'link holds 0.2 ETH');
  const bobEthBefore = bob.balance(ETH);
  await link.send(bob.selfKeys(), parseEther('0.2'), direct);
  await sync();
  assert.equal(bob.balance(ETH) - bobEthBefore, parseEther('0.2'));
  await link.sync();
  assert.equal(link.balance(ETH), 0n, 'link is empty after the claim');

  step('private address: bob pays alice’s fx1 address; she spends from it');
  const fx = alice.privateAddress();
  await bob.send(decodePrivateAddress(fx), parseEther('0.1'), direct);
  await alice.sync();
  const viaPa = alice.unspent(ETH).filter((n) => n.viaPrivateAddress);
  assert.equal(viaPa.reduce((s, n) => s + n.amount, 0n), parseEther('0.1'));
  const carolBefore = await publicClient.getBalance({ address: carolW.account.address });
  await alice.unshield(carolW.account.address, parseEther('0.1'), direct);
  await sync();
  assert.ok((await publicClient.getBalance({ address: carolW.account.address })) > carolBefore);
  await solvent('private address');

  step('attack: someone holding bob’s keys but not his wallet cannot spend');
  const thief = await PrivacyClient.create(config, publicClient, carolW, prover);
  await thief.activate();
  thief.keys = { ...bob.keys! };
  await thief.sync();
  await expectRevert(thief.unshield(carolW.account.address, parseEther('0.1'), direct), 'bad spend signature');

  step('attack: tampering with the recipient after proving fails the proof');
  await bob.sync();
  const tp = await bob.prepare({ exit: { recipient: carolW.account.address, amount: parseEther('0.05') }, mode: direct });
  tp.tx = { ...tp.tx, ext: { ...tp.tx.ext, recipient: relayerW.account.address } };
  await expectRevert(bob.submit(tp, direct), 'InvalidProof');

  step('withdraw tokens: bob withdraws 1,000 tUSD to carol via ERC-4337');
  const cu = await tokenBal(USD, carolW.account.address);
  await bob.unshield(carolW.account.address, usd('1000'), await viaBundler(), USD);
  assert.equal((await tokenBal(USD, carolW.account.address)) - cu, usd('990'));
  await sync();
  await solvent('token withdraw');

  step('large withdrawal: held 24 hours, then anyone releases it');
  await alice.shield(parseEther('12'));
  await alice.sync();
  const big = await alice.prepare({ exit: { recipient: carolW.account.address, amount: parseEther('11') }, mode: direct });
  await alice.submit(big, direct);
  const exitId = `0x${big.tx.nullifiers[0].toString(16).padStart(64, '0')}` as Hex;
  await expectRevert(relayerW.writeContract({ address: vault, abi: vaultAbi, functionName: 'releaseExit', args: [exitId] }), 'ExitNotDue');
  await testClient.increaseTime({ seconds: 24 * 3600 + 1 });
  await testClient.mine({ blocks: 1 });
  const c3 = await publicClient.getBalance({ address: carolW.account.address });
  await publicClient.waitForTransactionReceipt({ hash: await relayerW.writeContract({ address: vault, abi: vaultAbi, functionName: 'releaseExit', args: [exitId] }) });
  assert.equal((await publicClient.getBalance({ address: carolW.account.address })) - c3, parseEther('10.89'));
  await solvent('large exit');

  step('private terminal: buy an unlisted token (listed on first buy), then sell part back');
  const listedBefore = (await view<[boolean, bigint, bigint]>('tokens', [MEME]))[0];
  assert.equal(listedBefore, false, 'tMEME starts unlisted');
  await alice.sync();
  // 0.1 ETH, 0.3% fee, 1 ETH = 1,000,000 tMEME
  await alice.swapPrivately(ETH, { tokenOut: MEME, amountIn: parseEther('0.1'), minOut: parseEther('99000'), adapter: DEX }, await viaBundler(CALL_GAS_SWAP));
  await alice.sync();
  assert.equal(alice.balance(MEME), parseEther('99700'));
  const [listed, hold, cap] = await view<[boolean, bigint, bigint]>('tokens', [MEME]);
  assert.ok(listed && hold === 2n ** 128n - 1n && cap === 0n, 'listed on first buy: no hold, no cap');
  await alice.swapPrivately(MEME, { tokenOut: ETH, amountIn: parseEther('50000'), minOut: parseEther('0.049'), adapter: DEX }, direct);
  await alice.sync();
  assert.equal(alice.balance(MEME), parseEther('49700'));
  await solvent('terminal');

  step('private bridge out: alice sends 0.5 ETH to Base through Across; the vault pays the bridge');
  const spokeAbi = [
    { type: 'function', name: 'lastValue', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'arg', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'fill', stateMutability: 'payable', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }], outputs: [] },
  ] as const;
  const spoke = d.spokePool as Address;
  const ethBeforeBridge = alice.balance(ETH);
  const now = Number((await publicClient.getBlock()).timestamp);
  const out = bridgeOutInput(parseEther('0.5'));
  await alice.bridgeOut(parseEther('0.5'), d.bridgeAdapter as Address, {
    refundTo: carolW.account.address, recipient: carolW.account.address, destinationChainId: 8453,
    outputAmount: out - parseEther('0.001'), exclusiveRelayer: zeroAddress, quoteTimestamp: now,
    fillDeadline: now + 6 * 3600, exclusivityDeadline: 0, weth: d.weth as Address,
  }, await viaBundler(CALL_GAS_SWAP));
  await alice.sync();
  assert.equal(await publicClient.readContract({ address: spoke, abi: spokeAbi, functionName: 'lastValue' }), out, 'Across got the amount less the 1% fee');
  assert.equal(await publicClient.readContract({ address: spoke, abi: spokeAbi, functionName: 'arg', args: [1n] }), BigInt(carolW.account.address), 'recipient on Base');
  assert.equal(alice.bridgedOut.length, 1);
  assert.equal(alice.pendingSwaps.size, 0, 'no output note is awaited');
  assert.ok(alice.balance(ETH) < ethBeforeBridge - parseEther('0.5') + 1n, 'left the private balance');
  await solvent('bridge out');

  step('private bridge in: an Across fill shields 0.3 ETH straight into bob’s notes');
  await bob.sync();
  const bobEth = bob.balance(ETH);
  const msg = bob.bridgeInMessage(parseEther('0.3'));
  await publicClient.waitForTransactionReceipt({
    hash: await relayerW.writeContract({ address: spoke, abi: spokeAbi, functionName: 'fill', args: [d.depositHandler as Address, parseEther('0.3'), msg], value: parseEther('0.3') }),
  });
  await bob.sync();
  assert.equal(bob.balance(ETH) - bobEth, parseEther('0.3'), 'the bridged ETH is bob’s note');
  await solvent('bridge in');

  step('fees: sweep ETH and tUSD to the collector and split them');
  for (const token of [ETH, USD]) {
    const fees = await view<bigint>('feesAccrued', [token]);
    await publicClient.waitForTransactionReceipt({ hash: await relayerW.writeContract({ address: vault, abi: vaultAbi, functionName: 'sweepFees', args: [token] }) });
    const collected = await tokenBal(token, d.feeCollector);
    assert.ok(collected >= fees);
    const before = await tokenBal(token, adminW.account.address);
    await publicClient.waitForTransactionReceipt({ hash: await relayerW.writeContract({ address: d.feeCollector, abi: feeCollectorAbi, functionName: 'collect', args: [token] }) });
    assert.equal((await tokenBal(token, adminW.account.address)) - before, collected, 'team + sink (both admin locally)');
  }
  await solvent('sweep');
  assert.equal(exitFee(100n), 1n);

  console.log(`\n✓ all end-to-end checks passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(
    `  alice: ${formatEther(alice.balance(ETH))} ETH, ${formatUnits(alice.balance(USD), 6)} tUSD, ${formatEther(alice.balance(GOLD))} tGOLD private`,
  );
  void zeroAddress;
  await prover.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
