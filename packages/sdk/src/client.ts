import {
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  hexToBytes,
  keccak256,
  parseEventLogs,
  zeroAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPointAbi, vaultAbi } from './abi.js';
import { FIELD, MAX_AMOUNT, fromHex, randomBytes, randomField, toHex32 } from './field.js';
import {
  activationMessage,
  decodeBase64Url,
  deriveKeys,
  encodeBase64Url,
  encodePrivateAddress,
  linkAccount,
  ownerKey,
  privateAddressKeys,
  type PrivacyKeys,
} from './keys.js';
import {
  NoteKind,
  decryptNote,
  encryptNote,
  newSecrets,
  noteCommitment,
  noteNullifier,
  noteStub,
  plaintext,
  type NotePlaintext,
} from './note.js';
import { initPoseidon, h } from './poseidon.js';
import type { ProverLike } from './prover.js';
import { DEPTH, NoteTree } from './tree.js';
import { bridgeOutInput, encodeBridgeOutRoute, type BridgeOutRoute } from './bridge.js';

export const ETH: Address = zeroAddress;

export interface VaultConfig {
  chainId: number;
  vault: Address;
  entryPoint: Address;
  /** Block the vault was deployed in; scanning starts here. */
  startBlock: bigint;
  /** The app's domain, part of the activation message (changing it changes every key). */
  domain: string;
  /** Largest block range per eth_getLogs call. */
  logRange?: bigint;
}

export interface RecipientKeys {
  opk: bigint;
  viewKey: Uint8Array;
}

export interface OwnedNote extends NotePlaintext {
  index: number;
  commitment: bigint;
  nk: bigint;
  nullifier: bigint;
  spent: boolean;
  blockNumber: bigint;
  /** Notes paid to the private address rather than the main identity. */
  viaPrivateAddress: boolean;
}

export interface ExtData {
  recipient: Address;
  caller: Address;
  data: Hex;
  swapTokenOut: Address;
  swapMinOut: bigint;
  swapAdapter: Address;
  swapData: Hex;
  ciphertext0: Hex;
  ciphertext1: Hex;
  ciphertext2: Hex;
  ciphertextSwap: Hex;
}

export interface Transaction {
  root: bigint;
  nullifiers: readonly [bigint, bigint, bigint];
  commitments: readonly [bigint, bigint, bigint];
  token: Address;
  exitAmount: bigint;
  swapAmount: bigint;
  swapOutStub: bigint;
  gasFee: bigint;
  ext: ExtData;
}

export interface GasSettings {
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface PreparedSpend {
  tx: Transaction;
  proof: Hex;
  spent: OwnedNote[];
  /** Set when the spend funds a payment link: the claim URL fragment. */
  linkSeed?: Uint8Array;
}

export type SubmitMode =
  /** The connected wallet submits `transact` and pays gas: simple, but its address is visible. */
  | { kind: 'direct' }
  /** An ERC-4337 bundler submits; gas comes out of the notes and no user address appears. */
  | { kind: 'bundler'; bundlerUrl: string; gas: GasSettings }
  /** Any funded account calls EntryPoint.handleOps itself (a self-run bundler). */
  | { kind: 'handleOps'; submitter: WalletClient<Transport, Chain, Account>; gas: GasSettings };

export interface SwapRequest {
  tokenOut: Address;
  amountIn: bigint;
  minOut: bigint;
  adapter: Address;
  /** Adapter route data, e.g. abi.encode(uint24 fee) for a Uniswap v3 pool. */
  data?: Hex;
  /** Shown in this wallet's history (bridge out: the recipient on the other chain). */
  memoTo?: Address;
  /** A bridge-out: ETH leaves through a bridge adapter instead of becoming another token. */
  bridge?: boolean;
}

/** Signs EIP-712 spends. The wallet normally; a link's throwaway key when claiming a link. */
export interface SpendSigner {
  signTypedData: WalletClient<Transport, Chain, Account>['signTypedData'];
  account: Account;
}

const EXT_DATA_COMPONENTS = [
  { name: 'recipient', type: 'address' },
  { name: 'caller', type: 'address' },
  { name: 'data', type: 'bytes' },
  { name: 'swapTokenOut', type: 'address' },
  { name: 'swapMinOut', type: 'uint256' },
  { name: 'swapAdapter', type: 'address' },
  { name: 'swapData', type: 'bytes' },
  { name: 'ciphertext0', type: 'bytes' },
  { name: 'ciphertext1', type: 'bytes' },
  { name: 'ciphertext2', type: 'bytes' },
  { name: 'ciphertextSwap', type: 'bytes' },
] as const;

const TX_AND_PROOF_TYPE = [
  {
    type: 'tuple',
    components: [
      { name: 'root', type: 'uint256' },
      { name: 'nullifiers', type: 'uint256[3]' },
      { name: 'commitments', type: 'uint256[3]' },
      { name: 'token', type: 'address' },
      { name: 'exitAmount', type: 'uint256' },
      { name: 'swapAmount', type: 'uint256' },
      { name: 'swapOutStub', type: 'uint256' },
      { name: 'gasFee', type: 'uint256' },
      { name: 'ext', type: 'tuple', components: EXT_DATA_COMPONENTS },
    ],
  },
  { type: 'bytes' },
] as const;

export const EXIT_FEE_BPS = 100n;
/** Gas the ERC-4337 execution step needs: paying an exit, or settling a swap (DEX + tree insert). */
export const CALL_GAS_EXIT = 250_000n;
export const CALL_GAS_SWAP = 1_400_000n;

export function extDataHash(ext: ExtData): bigint {
  return fromHex(keccak256(encodeAbiParameters([{ type: 'tuple', components: EXT_DATA_COMPONENTS }], [ext]))) % FIELD;
}

export function exitFee(amount: bigint): bigint {
  return (amount * EXIT_FEE_BPS) / 10_000n;
}

/** Maximum wei an ERC-4337 operation may cost, which the notes must pay up front. */
export function gasFeeFor(g: GasSettings): bigint {
  return (g.verificationGasLimit + g.callGasLimit + g.preVerificationGas) * g.maxFeePerGas;
}

// ------------------------------------------------------------- receipts

/** Proof that a specific note — and so a specific payment — exists, shareable as a URL fragment. */
export interface Receipt {
  chainId: number;
  vault: Address;
  index: number;
  rho: bigint;
  r: bigint;
  amount: bigint;
  token: Address;
  /** The recipient's owner key; checked against the registry when `to` is a registered address. */
  opk: bigint;
  to: Address;
}

export function encodeReceipt(x: Receipt): string {
  const json = JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? `0x${v.toString(16)}` : v));
  return encodeBase64Url(new TextEncoder().encode(json));
}

export function decodeReceipt(s: string): Receipt {
  const o = JSON.parse(new TextDecoder().decode(decodeBase64Url(s)));
  return { ...o, rho: BigInt(o.rho), r: BigInt(o.r), amount: BigInt(o.amount), opk: BigInt(o.opk) };
}

export type ReceiptCheck =
  | { valid: true; blockNumber: bigint; recipientRegistered: boolean }
  | { valid: false; reason: string };

/** Checks a receipt against the chain: the note at `index` must be exactly H(1, H(opk, rho, r), amount, token). */
export async function verifyReceipt(publicClient: PublicClient, receipt: Receipt, startBlock = 0n): Promise<ReceiptCheck> {
  await initPoseidon();
  const logs = await publicClient.getContractEvents({
    address: receipt.vault,
    abi: vaultAbi,
    eventName: 'NoteAdded',
    args: { index: receipt.index },
    fromBlock: startBlock,
  });
  const log = logs[0] as unknown as { args: { commitment: bigint }; blockNumber: bigint } | undefined;
  if (!log) return { valid: false, reason: 'No note exists at that position in the vault.' };
  const expected = noteCommitment(noteStub(receipt.opk, receipt.rho, receipt.r), receipt.amount, receipt.token);
  if (expected !== log.args.commitment) return { valid: false, reason: 'The note on-chain does not match this receipt.' };
  let recipientRegistered = false;
  if (receipt.to !== zeroAddress) {
    const [opk] = (await publicClient.readContract({
      address: receipt.vault,
      abi: vaultAbi,
      functionName: 'keysOf',
      args: [receipt.to],
    })) as readonly [bigint, Hex];
    if (opk !== receipt.opk) return { valid: false, reason: 'The note was not paid to the address this receipt names.' };
    recipientRegistered = true;
  }
  return { valid: true, blockNumber: log.blockNumber, recipientRegistered };
}

// ---------------------------------------------------------------- client

interface PendingSwapNote {
  secrets: NotePlaintext;
  keys: PrivacyKeys;
  viaPrivateAddress: boolean;
}

export class PrivacyClient {
  keys?: PrivacyKeys;
  privateKeys?: PrivacyKeys;
  /** Signs spends. Defaults to the wallet. */
  signer: SpendSigner;
  readonly notes: OwnedNote[] = [];
  readonly tree: NoteTree;
  /** Swaps requested by this wallet that the vault has not settled yet, by swap id. */
  readonly pendingSwaps = new Map<Hex, { tokenIn: Address; tokenOut: Address; amountIn: bigint }>();
  /** This wallet's private bridge-outs that left the vault (amount sent to the bridge, exit fee). */
  readonly bridgedOut: { id: Hex; amount: bigint; fee: bigint; blockNumber: bigint }[] = [];
  private scannedTo: bigint;
  private nullifierIndex = new Map<bigint, OwnedNote>();
  private spentNullifiers = new Set<bigint>();
  private swapSecrets = new Map<Hex, PendingSwapNote>();
  private settledAt = new Map<number, { id: Hex; token: Address; amount: bigint }>();

  private constructor(
    readonly config: VaultConfig,
    readonly publicClient: PublicClient,
    readonly wallet: WalletClient<Transport, Chain, Account>,
    readonly prover: ProverLike,
  ) {
    this.tree = new NoteTree();
    this.scannedTo = config.startBlock - 1n;
    this.signer = { signTypedData: wallet.signTypedData.bind(wallet), account: wallet.account };
  }

  static async create(
    config: VaultConfig,
    publicClient: PublicClient,
    wallet: WalletClient<Transport, Chain, Account>,
    prover: ProverLike,
  ): Promise<PrivacyClient> {
    await initPoseidon();
    return new PrivacyClient(config, publicClient, wallet, prover);
  }

  /**
   * A client for a payment link: its keys and signer come from the link seed; `wallet` only submits
   * (direct mode) and pays no part of the value.
   */
  static async forLink(
    config: VaultConfig,
    publicClient: PublicClient,
    wallet: WalletClient<Transport, Chain, Account>,
    prover: ProverLike,
    seed: Uint8Array,
  ): Promise<PrivacyClient> {
    await initPoseidon();
    const c = new PrivacyClient(config, publicClient, wallet, prover);
    const { privateKey, keys } = linkAccount(seed);
    const account = privateKeyToAccount(privateKey);
    c.keys = keys;
    c.signer = { account, signTypedData: ((args: Parameters<typeof account.signTypedData>[0]) => account.signTypedData(args)) as never };
    return c;
  }

  get address(): Address {
    return this.wallet.account.address;
  }

  private requireKeys(): PrivacyKeys {
    if (!this.keys) throw new Error('privacy is not active: call activate() first');
    return this.keys;
  }

  // ------------------------------------------------------------ activation

  /**
   * Signs the fixed activation message and derives the privacy keys. A wallet whose signatures are
   * not deterministic (RFC 6979) is refused, because it would derive different keys next time.
   */
  async activate(): Promise<PrivacyKeys> {
    const message = activationMessage({
      domain: this.config.domain,
      address: this.address,
      chainId: this.config.chainId,
      vault: this.config.vault,
    });
    const sign = () => this.wallet.signMessage({ account: this.wallet.account, message });
    const keys = await deriveKeys(message, await sign());

    const [registeredOpk] = await this.keysOf(this.address);
    if (registeredOpk !== 0n) {
      if (registeredOpk !== keys.opk) throw new Error('these keys do not match the keys registered for this address');
    } else {
      const again = await deriveKeys(message, await sign());
      if (again.opk !== keys.opk) throw new Error('this wallet does not sign deterministically; it cannot hold keys');
    }
    this.keys = keys;
    this.privateKeys = privateAddressKeys(keys);
    return keys;
  }

  async keysOf(owner: Address): Promise<readonly [bigint, Hex]> {
    return this.publicClient.readContract({
      address: this.config.vault,
      abi: vaultAbi,
      functionName: 'keysOf',
      args: [owner],
    }) as Promise<readonly [bigint, Hex]>;
  }

  async isRegistered(): Promise<boolean> {
    const [opk] = await this.keysOf(this.address);
    return opk !== 0n;
  }

  /** Publishes the owner key and viewing key so others can pay this address privately. */
  async register(): Promise<Hex> {
    const k = this.requireKeys();
    const hash = await this.wallet.writeContract({
      address: this.config.vault,
      abi: vaultAbi,
      functionName: 'register',
      args: [k.opk, bytesToHex(k.viewPublic)],
    });
    await this.waitOk(hash);
    return hash;
  }

  /** Keys of this wallet's main identity, for paying yourself. */
  selfKeys(): RecipientKeys {
    const k = this.requireKeys();
    return { opk: k.opk, viewKey: k.viewPublic };
  }

  /** A shareable private address (`fx1…`): receives without registering or revealing anything. */
  privateAddress(): string {
    const k = this.privateKeys;
    if (!k) throw new Error('privacy is not active');
    return encodePrivateAddress(k.opk, k.viewPublic);
  }

  private async waitOk(hash: Hex) {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('transaction reverted');
    return receipt;
  }

  // -------------------------------------------------------------- scanning

  /** Reads new vault events, rebuilds the note tree and finds this wallet's notes. */
  async sync(): Promise<void> {
    // cacheTime 0: viem otherwise reuses a block number for a few seconds and the scan stops short.
    const latest = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    if (latest <= this.scannedTo) return;
    const step = this.config.logRange ?? 10_000n;
    for (let from = this.scannedTo + 1n; from <= latest; from += step) {
      const to = from + step - 1n > latest ? latest : from + step - 1n;
      const logs = await this.publicClient.getLogs({ address: this.config.vault, fromBlock: from, toBlock: to });
      const events = parseEventLogs({
        abi: vaultAbi,
        logs,
        eventName: ['NoteAdded', 'NullifierSpent', 'SwapRequested', 'SwapSettled', 'BridgedOut'],
      });
      events.sort((a, b) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
      );
      for (const e of events) this.apply(e.eventName, e.args as Record<string, unknown>, e.blockNumber);
      this.scannedTo = to;
    }
    const onchainRoot = (await this.publicClient.readContract({
      address: this.config.vault,
      abi: vaultAbi,
      functionName: 'getLastRoot',
      blockNumber: latest,
    })) as bigint;
    if (onchainRoot !== this.tree.root()) {
      throw new Error('local note tree does not match the vault root; resync from the start block');
    }
  }

  private identities(): [PrivacyKeys, boolean][] {
    const out: [PrivacyKeys, boolean][] = [];
    if (this.keys) out.push([this.keys, false]);
    if (this.privateKeys) out.push([this.privateKeys, true]);
    return out;
  }

  private apply(name: string, a: Record<string, unknown>, blockNumber: bigint): void {
    if (name === 'NoteAdded') {
      const index = Number(a.index);
      const commitment = a.commitment as bigint;
      this.tree.insert(index, commitment);
      if (commitment === 0n) return;
      const settled = this.settledAt.get(index);
      if (settled) return this.ownSwapOutput(index, commitment, settled, blockNumber);
      this.tryOwn(index, commitment, a.ciphertext as Hex, blockNumber);
    } else if (name === 'NullifierSpent') {
      const nf = a.nullifier as bigint;
      this.spentNullifiers.add(nf);
      const note = this.nullifierIndex.get(nf);
      if (note) note.spent = true;
    } else if (name === 'SwapRequested') {
      const ct = hexToBytes(a.ciphertext as Hex);
      for (const [k, via] of this.identities()) {
        const p = decryptNote(k.viewSecret, k.viewPublic, ct);
        if (p && p.kind === NoteKind.SwapOut) {
          const id = a.swapId as Hex;
          this.swapSecrets.set(id, { secrets: p, keys: k, viaPrivateAddress: via });
          this.pendingSwaps.set(id, {
            tokenIn: a.tokenIn as Address,
            tokenOut: a.tokenOut as Address,
            amountIn: a.amountIn as bigint,
          });
          break;
        }
      }
    } else if (name === 'BridgedOut') {
      // The ETH left through the bridge: no output note will come.
      const id = a.swapId as Hex;
      if (this.swapSecrets.has(id)) {
        this.swapSecrets.delete(id);
        this.pendingSwaps.delete(id);
        this.bridgedOut.push({ id, amount: a.amount as bigint, fee: a.fee as bigint, blockNumber });
      }
    } else if (name === 'SwapSettled') {
      const id = a.swapId as Hex;
      if (this.swapSecrets.has(id)) {
        this.settledAt.set(Number(a.index), { id, token: a.token as Address, amount: a.amount as bigint });
      }
    }
  }

  private ownSwapOutput(index: number, commitment: bigint, s: { id: Hex; token: Address; amount: bigint }, blockNumber: bigint) {
    const pending = this.swapSecrets.get(s.id)!;
    this.swapSecrets.delete(s.id);
    this.pendingSwaps.delete(s.id);
    this.settledAt.delete(index);
    const k = pending.keys;
    const p = { ...pending.secrets, amount: s.amount, token: s.token };
    if (noteCommitment(noteStub(k.opk, p.rho, p.r), p.amount, p.token) !== commitment) return;
    this.addNote(index, commitment, p, k, blockNumber, pending.viaPrivateAddress);
  }

  private tryOwn(index: number, commitment: bigint, ciphertext: Hex, blockNumber: bigint): void {
    const ct = hexToBytes(ciphertext);
    for (const [k, via] of this.identities()) {
      const p = decryptNote(k.viewSecret, k.viewPublic, ct);
      if (!p) continue;
      if (noteCommitment(noteStub(k.opk, p.rho, p.r), p.amount, p.token) !== commitment) continue;
      this.addNote(index, commitment, p, k, blockNumber, via);
      return;
    }
  }

  private addNote(index: number, commitment: bigint, p: NotePlaintext, k: PrivacyKeys, blockNumber: bigint, via: boolean) {
    const nullifier = noteNullifier(k.nk, commitment, BigInt(index));
    const note: OwnedNote = {
      ...p,
      index,
      commitment,
      nk: k.nk,
      nullifier,
      spent: this.spentNullifiers.has(nullifier),
      blockNumber,
      viaPrivateAddress: via,
    };
    this.notes.push(note);
    this.nullifierIndex.set(nullifier, note);
  }

  unspent(token?: Address): OwnedNote[] {
    return this.notes.filter((n) => !n.spent && n.amount > 0n && (token === undefined || n.token === token));
  }

  balance(token: Address = ETH): bigint {
    return this.unspent(token).reduce((s, n) => s + n.amount, 0n);
  }

  /** Private balances by token. */
  balances(): Map<Address, bigint> {
    const m = new Map<Address, bigint>();
    for (const n of this.unspent()) m.set(n.token, (m.get(n.token) ?? 0n) + n.amount);
    return m;
  }

  // ----------------------------------------------------------------- shield

  /** Moves ETH or a listed token from the wallet into a new private note. Sender and amount are public. */
  async shield(amount: bigint, token: Address = ETH, to?: RecipientKeys): Promise<Hex> {
    if (amount <= 0n || amount >= MAX_AMOUNT) throw new Error('amount out of range');
    const owner = to ?? this.selfKeys();
    const { rho, r } = newSecrets();
    const stub = noteStub(owner.opk, rho, r);
    const ciphertext = bytesToHex(encryptNote(owner.viewKey, plaintext({ rho, r, amount, token, kind: NoteKind.Received })));
    if (token === ETH) {
      const hash = await this.wallet.writeContract({
        address: this.config.vault,
        abi: vaultAbi,
        functionName: 'shield',
        args: [stub, ciphertext],
        value: amount,
      });
      await this.waitOk(hash);
      return hash;
    }
    const allowance = await this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [this.address, this.config.vault],
    });
    if (allowance < amount) {
      const approve = await this.wallet.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [this.config.vault, amount],
      });
      await this.waitOk(approve);
    }
    const hash = await this.wallet.writeContract({
      address: this.config.vault,
      abi: vaultAbi,
      functionName: 'shieldToken',
      args: [token, amount, stub, ciphertext],
    });
    await this.waitOk(hash);
    return hash;
  }

  // -------------------------------------------------------- spending notes

  async recipientKeys(address: Address): Promise<RecipientKeys> {
    const [opk, viewKey] = await this.keysOf(address);
    if (opk === 0n) throw new Error(`${address} has not registered for private payments`);
    return { opk, viewKey: hexToBytes(viewKey) };
  }

  private sortedAsc(token: Address, exclude: Set<OwnedNote>, nk?: bigint): OwnedNote[] {
    return this.unspent(token)
      .filter((n) => !exclude.has(n) && (nk === undefined || n.nk === nk))
      .sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
  }

  /** Smallest set of at most `max` notes covering `needed`, all owned by one identity. */
  private pick(token: Address, needed: bigint, max: number, exclude = new Set<OwnedNote>(), nk?: bigint): OwnedNote[] {
    if (needed === 0n) return [];
    const notes = this.sortedAsc(token, exclude, nk);
    const single = notes.find((n) => n.amount >= needed);
    if (single) return [single];
    for (const id of new Set(notes.map((n) => n.nk))) {
      const mine = notes.filter((n) => n.nk === id).slice(-max).reverse();
      let sum = 0n;
      for (let i = 0; i < mine.length; i++) {
        sum += mine[i].amount;
        if (sum >= needed) return mine.slice(0, i + 1);
      }
    }
    const total = notes.reduce((s, n) => s + n.amount, 0n);
    if (total >= needed) throw new Error('your balance is split over too many notes for one transaction; merge notes first');
    throw new Error('insufficient private balance');
  }

  /**
   * Builds, signs and proves one private transaction in `token` (ETH = zero address). Exactly one of:
   * - `pay`: a private payment to recipient keys (amount, sender and recipient stay hidden)
   * - `link`: funds a new payment link with `amount` (returned as `linkSeed`)
   * - `exit`: a public payout to an address (1% exit fee)
   * - `swap`: a private swap into another token; the vault creates the output note
   * - `merge`: spend the given notes into one
   * `mode` decides who submits and whether gas comes out of the notes (always ETH notes).
   */
  async prepare(params: {
    token?: Address;
    pay?: { to: RecipientKeys; amount: bigint; memoTo?: Address };
    link?: { amount: bigint };
    exit?: { recipient: Address; amount: bigint };
    swap?: SwapRequest;
    merge?: OwnedNote[];
    mode: SubmitMode;
  }): Promise<PreparedSpend> {
    const k = this.requireKeys();
    const token = params.token ?? ETH;
    const { exit, swap, mode } = params;
    let pay = params.pay;
    const actions = [params.pay, params.link, exit, swap, params.merge].filter(Boolean).length;
    if (actions !== 1) throw new Error('a transaction does exactly one of: pay, link, exit, swap, merge');

    let linkSeed: Uint8Array | undefined;
    if (params.link) {
      linkSeed = randomBytes(32);
      const lk = linkAccount(linkSeed).keys;
      pay = { to: { opk: lk.opk, viewKey: lk.viewPublic }, amount: params.link.amount };
    }
    if (swap && !swap.bridge && swap.tokenOut === token) throw new Error('swap into a different token');
    if (swap?.bridge && (token !== ETH || swap.tokenOut !== ETH)) throw new Error('bridging out is ETH only');

    const viaEntryPoint = mode.kind !== 'direct';
    const gasFee = viaEntryPoint ? gasFeeFor(mode.gas) : 0n;
    const exitAmount = exit?.amount ?? 0n;
    const swapAmount = swap?.amountIn ?? 0n;
    const mainNeeded = (pay?.amount ?? 0n) + exitAmount + swapAmount;

    // ---- choose inputs: [main, main, gas lane]
    let main: OwnedNote[];
    let gasNotes: OwnedNote[] = [];
    if (params.merge) {
      main = params.merge;
      if (main.length < 2 || main.length > (token === ETH ? 3 : 2)) throw new Error('merge two notes (three for ETH)');
      if (main.some((n) => n.token !== token || n.nk !== main[0].nk || n.spent)) throw new Error('cannot merge these notes');
    } else if (token === ETH) {
      main = this.pick(ETH, mainNeeded + gasFee, 3);
    } else {
      main = this.pick(token, mainNeeded, 2);
      gasNotes = gasFee > 0n ? this.pick(ETH, gasFee, 1, new Set(), main[0]?.nk) : [];
      if (gasFee > 0n && gasNotes.length === 0) throw new Error('private gas needs an ETH note');
    }
    const nk0 = (main[0] ?? gasNotes[0])?.nk;
    if (nk0 === undefined) throw new Error('nothing to spend');
    if ([...main, ...gasNotes].some((n) => n.nk !== nk0)) {
      throw new Error('notes of the main and private address cannot be spent together');
    }
    const ins: (OwnedNote | null)[] =
      token === ETH ? [main[0] ?? null, main[1] ?? null, main[2] ?? null] : [main[0] ?? null, main[1] ?? null, gasNotes[0] ?? null];

    const inMain = (token === ETH ? main : main).reduce((s, n) => s + n.amount, 0n);
    const inGas = gasNotes.reduce((s, n) => s + n.amount, 0n);
    const mainChange = token === ETH ? inMain - mainNeeded - gasFee : inMain - mainNeeded;
    const gasChange = token === ETH ? 0n : inGas - gasFee;
    if (mainChange < 0n || gasChange < 0n) throw new Error('insufficient private balance');

    // ---- outputs: [main 0, main 1, ETH lane]
    const self = this.selfKeys();
    // A note change goes back to the identity whose notes were spent (main or private address).
    const spender = nk0 === this.privateKeys?.nk ? { opk: this.privateKeys.opk, viewKey: this.privateKeys.viewPublic } : self;
    type Out = { to: RecipientKeys; p: NotePlaintext };
    const zero = (tok: Address): Out => ({ to: spender, p: plaintext({ ...newSecrets(), amount: 0n, token: tok, kind: NoteKind.Empty }) });
    let outs: Out[];
    if (pay) {
      const paySecrets = newSecrets();
      const kind = params.link ? NoteKind.LinkChange : NoteKind.Change;
      outs = [
        { to: pay.to, p: plaintext({ ...paySecrets, amount: pay.amount, token, kind: NoteKind.Received }) },
        {
          to: spender,
          p: plaintext({
            ...newSecrets(),
            amount: mainChange,
            token,
            kind,
            memoTo: pay.memoTo ?? zeroAddress,
            memoAmount: pay.amount,
            payRho: params.link ? fromHex(bytesToHex(linkSeed!)) : paySecrets.rho,
            payR: params.link ? 0n : paySecrets.r,
            memoToken: token,
          }),
        },
        zero(ETH),
      ];
    } else if (exit) {
      outs = [
        {
          to: spender,
          p: plaintext({ ...newSecrets(), amount: mainChange, token, kind: NoteKind.ExitChange, memoTo: exit.recipient, memoAmount: exit.amount, memoToken: token }),
        },
        zero(token),
        zero(ETH),
      ];
    } else if (swap) {
      outs = [
        {
          to: spender,
          p: plaintext({ ...newSecrets(), amount: mainChange, token, kind: NoteKind.SwapChange, memoTo: swap.memoTo ?? zeroAddress, memoAmount: swap.amountIn, memoToken: swap.tokenOut }),
        },
        zero(token),
        zero(ETH),
      ];
    } else {
      outs = [{ to: spender, p: plaintext({ ...newSecrets(), amount: mainChange, token, kind: NoteKind.Received }) }, zero(token), zero(ETH)];
    }
    if (token !== ETH && gasChange > 0n) {
      outs[2] = { to: spender, p: plaintext({ ...newSecrets(), amount: gasChange, token: ETH, kind: NoteKind.Received }) };
    }

    const outStubs = outs.map((o) => noteStub(o.to.opk, o.p.rho, o.p.r));
    const commitments = outs.map((o, i) => noteCommitment(outStubs[i], o.p.amount, o.p.token)) as [bigint, bigint, bigint];
    const ciphertexts = outs.map((o) => bytesToHex(encryptNote(o.to.viewKey, o.p)));

    // Swap output note: its secrets travel encrypted with the request; the vault fills in the amount.
    let swapOutStub = 0n;
    let ciphertextSwap: Hex = '0x';
    if (swap) {
      const s = newSecrets();
      swapOutStub = noteStub(spender.opk, s.rho, s.r);
      ciphertextSwap = bytesToHex(
        encryptNote(spender.viewKey, plaintext({ ...s, amount: 0n, token: swap.tokenOut, kind: NoteKind.SwapOut, memoAmount: swap.amountIn, memoToken: token })),
      );
    }

    // ---- input witnesses, with zero-value dummies
    const laneToken = (i: number) => (i === 2 ? ETH : token);
    const witness = ins.map((n, i) => {
      if (n) {
        return { nk: n.nk, rho: n.rho, r: n.r, amount: n.amount, index: BigInt(n.index), path: this.tree.path(n.index), nullifier: n.nullifier };
      }
      const nk = randomField();
      const { rho, r } = newSecrets();
      const cm = noteCommitment(noteStub(ownerKey(nk, k.pkX, k.pkY), rho, r), 0n, laneToken(i));
      return { nk, rho, r, amount: 0n, index: 0n, path: Array<bigint>(DEPTH).fill(0n), nullifier: noteNullifier(nk, cm, 0n) };
    });

    const ext: ExtData = {
      recipient: exit?.recipient ?? zeroAddress,
      caller: viaEntryPoint ? this.config.vault : zeroAddress,
      data: viaEntryPoint ? encodeAbiParameters([{ type: 'uint256' }], [mode.gas.callGasLimit]) : '0x',
      swapTokenOut: swap?.tokenOut ?? zeroAddress,
      swapMinOut: swap?.minOut ?? 0n,
      swapAdapter: swap?.adapter ?? zeroAddress,
      swapData: swap?.data ?? '0x',
      ciphertext0: ciphertexts[0],
      ciphertext1: ciphertexts[1],
      ciphertext2: ciphertexts[2],
      ciphertextSwap,
    };
    const root = this.tree.root();
    const nullifiers = witness.map((w) => w.nullifier) as [bigint, bigint, bigint];
    const tx: Transaction = { root, nullifiers, commitments, token, exitAmount, swapAmount, swapOutStub, gasFee, ext };

    // The spend key signs exactly this transaction (EIP-712); the proof checks that signature.
    const edh = extDataHash(ext);
    const tokenF = BigInt(token);
    const transaction = h(root, ...nullifiers, ...commitments, tokenF, exitAmount, swapAmount, swapOutStub, gasFee, edh);
    const signature = await this.signer.signTypedData({
      account: this.signer.account,
      domain: { name: 'fractal', version: '1', chainId: this.config.chainId, verifyingContract: this.config.vault },
      types: { Spend: [{ name: 'transaction', type: 'bytes32' }] },
      primaryType: 'Spend',
      message: { transaction: toHex32(transaction) },
    });
    const domain = fromHex(
      (await this.publicClient.readContract({ address: this.config.vault, abi: vaultAbi, functionName: 'domainSeparator' })) as Hex,
    );

    const f = (x: bigint) => toHex32(x);
    const { proof } = await this.prover.prove({
      root: f(root),
      nullifiers: nullifiers.map(f),
      out_commitments: commitments.map(f),
      token: f(tokenF),
      exit_amount: f(exitAmount),
      swap_amount: f(swapAmount),
      swap_out_stub: f(swapOutStub),
      gas_fee: f(gasFee),
      ext_data_hash: f(edh),
      domain_hi: f(domain >> 128n),
      domain_lo: f(domain & ((1n << 128n) - 1n)),
      in_nk: witness.map((w) => f(w.nk)),
      in_rho: witness.map((w) => f(w.rho)),
      in_r: witness.map((w) => f(w.r)),
      in_amount: witness.map((w) => f(w.amount)),
      in_index: witness.map((w) => f(w.index)),
      in_path: witness.map((w) => w.path.map(f)),
      out_stub: outStubs.map(f),
      out_amount: outs.map((o) => f(o.p.amount)),
      pk_x: Array.from(k.pkX),
      pk_y: Array.from(k.pkY),
      signature: Array.from(hexToBytes(signature).slice(0, 64)),
    });
    return { tx, proof, spent: [...main, ...gasNotes], linkSeed };
  }

  /** Submits a prepared spend. Returns the transaction hash (or user operation hash for a bundler). */
  async submit(p: PreparedSpend, mode: SubmitMode): Promise<Hex> {
    if (mode.kind === 'direct') {
      const hash = await this.wallet.writeContract({
        address: this.config.vault,
        abi: vaultAbi,
        functionName: 'transact',
        args: [p.tx, p.proof],
      });
      await this.waitOk(hash);
      return hash;
    }
    const userOp = this.userOperation(p, mode.gas);
    if (mode.kind === 'handleOps') {
      const hash = await mode.submitter.writeContract({
        address: this.config.entryPoint,
        abi: entryPointAbi,
        functionName: 'handleOps',
        args: [[packUserOp(userOp)], mode.submitter.account.address],
        gas: userOp.verificationGasLimit + userOp.callGasLimit + userOp.preVerificationGas + 300_000n,
      });
      const receipt = await this.waitOk(hash);
      const failed = parseEventLogs({ abi: entryPointAbi, logs: receipt.logs, eventName: 'UserOperationEvent' }).find(
        (e) => !(e.args as { success: boolean }).success,
      );
      if (failed) throw new Error('user operation execution failed');
      return hash;
    }
    const res = await fetch(mode.bundlerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendUserOperation', params: [rpcUserOp(userOp), this.config.entryPoint] }),
    });
    const body = (await res.json()) as { result?: Hex; error?: { message: string } };
    if (body.error || !body.result) throw new Error(`bundler: ${body.error?.message ?? 'no result'}`);
    return body.result;
  }

  userOperation(p: PreparedSpend, gas: GasSettings): UserOperation {
    const id = p.tx.nullifiers[0];
    return {
      sender: this.config.vault,
      nonce: (id & ((1n << 192n) - 1n)) << 64n,
      callData: encodeFunctionData({ abi: vaultAbi, functionName: 'execute4337', args: [toHex32(id)] }),
      ...gas,
      signature: encodeAbiParameters(TX_AND_PROOF_TYPE, [p.tx, p.proof]),
    };
  }

  // -------------------------------------------------------- convenience

  /** Pays a registered address, or a private address's keys, privately. */
  async send(to: Address | RecipientKeys, amount: bigint, mode: SubmitMode, token: Address = ETH): Promise<Hex> {
    const keys = typeof to === 'string' ? await this.recipientKeys(to) : to;
    const p = await this.prepare({ token, pay: { to: keys, amount, memoTo: typeof to === 'string' ? to : zeroAddress }, mode });
    return this.submit(p, mode);
  }

  /** Moves funds out of the notes to any public address, minus the 1% exit fee. */
  async unshield(recipient: Address, amount: bigint, mode: SubmitMode, token: Address = ETH): Promise<Hex> {
    return this.submit(await this.prepare({ token, exit: { recipient, amount }, mode }), mode);
  }

  /** Swaps privately: `swap.amountIn` of `tokenIn` from the notes becomes a new note of `swap.tokenOut`. */
  async swapPrivately(tokenIn: Address, swap: SwapRequest, mode: SubmitMode): Promise<Hex> {
    return this.submit(await this.prepare({ token: tokenIn, swap, mode }), mode);
  }

  /**
   * Private bridge out: `amount` ETH leaves the notes through the bridge adapter (1% exit fee) and
   * Across delivers `route.outputAmount` to `route.recipient` on another chain. If Across never fills,
   * the ETH goes to `route.refundTo` on this chain; if the adapter refuses, the full amount returns as
   * a note. Build `route` from a fresh Across quote for `bridgeOutInput(amount)`.
   */
  async bridgeOut(amount: bigint, adapter: Address, route: BridgeOutRoute, mode: SubmitMode): Promise<Hex> {
    const data = encodeBridgeOutRoute({ ...route, inputAmount: bridgeOutInput(amount) });
    const swap: SwapRequest = { tokenOut: ETH, amountIn: amount, minOut: 0n, adapter, data, memoTo: route.recipient, bridge: true };
    return this.submit(await this.prepare({ token: ETH, swap, mode }), mode);
  }

  /**
   * Private bridge in: the Across `message` that makes the deposit handler shield exactly
   * `outputAmount` (the quote's output) as a new note of this wallet. Send it with an Across deposit
   * whose recipient is the deposit handler.
   */
  bridgeInMessage(outputAmount: bigint): Hex {
    if (outputAmount <= 0n || outputAmount >= MAX_AMOUNT) throw new Error('amount out of range');
    const owner = this.selfKeys();
    const { rho, r } = newSecrets();
    const stub = noteStub(owner.opk, rho, r);
    const ciphertext = bytesToHex(encryptNote(owner.viewKey, plaintext({ rho, r, amount: outputAmount, token: ETH, kind: NoteKind.Received })));
    return encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [stub, ciphertext]);
  }

  /** Funds a payment link. Returns the link seed; share it as `/claim#<base64url(seed)>`. */
  async createLink(amount: bigint, mode: SubmitMode, token: Address = ETH): Promise<{ seed: Uint8Array; hash: Hex }> {
    const p = await this.prepare({ token, link: { amount }, mode });
    return { seed: p.linkSeed!, hash: await this.submit(p, mode) };
  }

  /** Payment links this wallet funded, recovered from its own change notes. */
  linksCreated(): { seed: Uint8Array; amount: bigint; token: Address; blockNumber: bigint }[] {
    return this.notes
      .filter((n) => n.kind === NoteKind.LinkChange)
      .map((n) => ({ seed: hexToBytes(toHex32(n.payRho)), amount: n.memoAmount, token: n.memoToken, blockNumber: n.blockNumber }));
  }

  /** Receipt for a private payment this wallet made (from the payment's change note). */
  receiptFor(change: OwnedNote, recipientOpk: bigint): Receipt {
    if (change.kind !== NoteKind.Change) throw new Error('not the change of a private payment');
    return {
      chainId: this.config.chainId,
      vault: this.config.vault,
      index: change.index - 1, // the payment is the first output, inserted next to its change
      rho: change.payRho,
      r: change.payR,
      amount: change.memoAmount,
      token: change.token,
      opk: recipientOpk,
      to: change.memoTo,
    };
  }
}

export interface UserOperation extends GasSettings {
  sender: Address;
  nonce: bigint;
  callData: Hex;
  signature: Hex;
}

const pack128 = (hi: bigint, lo: bigint): Hex => toHex32((hi << 128n) | lo);

export function packUserOp(op: UserOperation) {
  return {
    sender: op.sender,
    nonce: op.nonce,
    initCode: '0x' as Hex,
    callData: op.callData,
    accountGasLimits: pack128(op.verificationGasLimit, op.callGasLimit),
    preVerificationGas: op.preVerificationGas,
    gasFees: pack128(op.maxPriorityFeePerGas, op.maxFeePerGas),
    paymasterAndData: '0x' as Hex,
    signature: op.signature,
  };
}

const q = (x: bigint): Hex => `0x${x.toString(16)}`;

/** ERC-4337 v0.7+ JSON-RPC shape for eth_sendUserOperation. */
export function rpcUserOp(op: UserOperation) {
  return {
    sender: op.sender,
    nonce: q(op.nonce),
    callData: op.callData,
    callGasLimit: q(op.callGasLimit),
    verificationGasLimit: q(op.verificationGasLimit),
    preVerificationGas: q(op.preVerificationGas),
    maxFeePerGas: q(op.maxFeePerGas),
    maxPriorityFeePerGas: q(op.maxPriorityFeePerGas),
    signature: op.signature,
  };
}
