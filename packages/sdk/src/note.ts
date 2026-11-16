import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, getAddress, zeroAddress, type Address } from 'viem';
import { MAX_AMOUNT, fromBytes, randomBytes, randomField, toBytes32 } from './field.js';
import { h } from './poseidon.js';

export const enum NoteKind {
  Received = 0, // paid to us, or shielded by us
  Change = 1, // change of a private payment; memo: whom it paid, how much; pay secrets for a receipt
  Empty = 2, // zero-value padding output
  ExitChange = 3, // change of a withdrawal; memo: the receiving address and amount
  SwapChange = 4, // change of a swap; memo: amount in, token out
  SwapOut = 5, // secrets of a swap's output note (sent with the swap request; amount set by the vault)
  LinkChange = 6, // change of a payment-link funding; memo: amount; paySecret holds the link seed
}

/** What a ciphertext carries. */
export interface NotePlaintext {
  rho: bigint;
  r: bigint;
  amount: bigint;
  token: Address;
  kind: NoteKind;
  memoTo: Address;
  memoAmount: bigint;
  /** For a Change note: rho and r of the payment note, so the sender can prove the payment later.
   *  For a LinkChange note: payRho is the link seed. */
  payRho: bigint;
  payR: bigint;
  memoToken: Address;
}

export const PLAINTEXT_LEN = 224;
export const CIPHERTEXT_LEN = 32 + PLAINTEXT_LEN + 16; // ephemeral key + body + tag = 272

export const tokenField = (token: Address): bigint => BigInt(token);
export const noteStub = (opk: bigint, rho: bigint, r: bigint) => h(opk, rho, r);
export const noteCommitment = (stub: bigint, amount: bigint, token: Address) => h(1n, stub, amount, tokenField(token));
export const noteNullifier = (nk: bigint, cm: bigint, index: bigint) => h(2n, nk, cm, index);

export function newSecrets(): { rho: bigint; r: bigint } {
  return { rho: randomField(), r: randomField() };
}

export function plaintext(p: Partial<NotePlaintext> & Pick<NotePlaintext, 'rho' | 'r' | 'amount' | 'kind'>): NotePlaintext {
  return {
    token: zeroAddress,
    memoTo: zeroAddress,
    memoAmount: 0n,
    payRho: 0n,
    payR: 0n,
    memoToken: zeroAddress,
    ...p,
  };
}

const addr20 = (a: Address) => toBytes32(BigInt(a)).slice(12);
const u128 = (x: bigint) => toBytes32(x).slice(16);

function encodePlaintext(p: NotePlaintext): Uint8Array {
  if (p.amount < 0n || p.amount >= MAX_AMOUNT) throw new Error('amount out of range');
  const out = new Uint8Array(PLAINTEXT_LEN);
  let o = 0;
  const put = (b: Uint8Array) => {
    out.set(b, o);
    o += b.length;
  };
  put(toBytes32(p.rho));
  put(toBytes32(p.r));
  put(u128(p.amount));
  put(addr20(p.token));
  put(new Uint8Array([p.kind]));
  put(addr20(p.memoTo));
  put(u128(p.memoAmount));
  put(toBytes32(p.payRho));
  put(toBytes32(p.payR));
  put(addr20(p.memoToken));
  return out;
}

function decodePlaintext(b: Uint8Array): NotePlaintext {
  let o = 0;
  const take = (n: number) => b.slice(o, (o += n));
  const addr = () => getAddress(bytesToHex(take(20)));
  return {
    rho: fromBytes(take(32)),
    r: fromBytes(take(32)),
    amount: fromBytes(take(16)),
    token: addr(),
    kind: take(1)[0] as NoteKind,
    memoTo: addr(),
    memoAmount: fromBytes(take(16)),
    payRho: fromBytes(take(32)),
    payR: fromBytes(take(32)),
    memoToken: addr(),
  };
}

function noteKey(shared: Uint8Array, ephPub: Uint8Array, viewPub: Uint8Array): Uint8Array {
  const salt = new Uint8Array(64);
  salt.set(ephPub, 0);
  salt.set(viewPub, 32);
  return hkdf(sha256, shared, salt, new TextEncoder().encode('fractal/v1/note'), 32);
}

/** ECIES to an X25519 viewing key: fresh ephemeral key, HKDF-SHA256, ChaCha20-Poly1305. */
export function encryptNote(viewPub: Uint8Array, p: NotePlaintext): Uint8Array {
  const eph = randomBytes(32);
  const ephPub = x25519.getPublicKey(eph);
  const key = noteKey(x25519.getSharedSecret(eph, viewPub), ephPub, viewPub);
  // The key is unique per note (fresh ephemeral key), so a zero nonce is safe.
  const body = chacha20poly1305(key, new Uint8Array(12)).encrypt(encodePlaintext(p));
  const out = new Uint8Array(CIPHERTEXT_LEN);
  out.set(ephPub, 0);
  out.set(body, 32);
  return out;
}

export function decryptNote(viewSecret: Uint8Array, viewPub: Uint8Array, ct: Uint8Array): NotePlaintext | null {
  if (ct.length !== CIPHERTEXT_LEN) return null;
  const ephPub = ct.slice(0, 32);
  try {
    const key = noteKey(x25519.getSharedSecret(viewSecret, ephPub), ephPub, viewPub);
    return decodePlaintext(chacha20poly1305(key, new Uint8Array(12)).decrypt(ct.slice(32)));
  } catch {
    return null;
  }
}
