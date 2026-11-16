import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { x25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { getAddress, hashMessage, hexToBytes, keccak256, recoverPublicKey, type Address, type Hex } from 'viem';
import { FIELD, fromBytes, limbs, toBytes32 } from './field.js';
import { h } from './poseidon.js';

const enc = new TextEncoder();

export interface PrivacyKeys {
  /** Root secret. Never leaves the device. */
  sk: bigint;
  /** Nullifier key: proves ownership and computes nullifiers. */
  nk: bigint;
  /** The wallet's secp256k1 public key, 32-byte big-endian x and y. Every spend is signed by it. */
  pkX: Uint8Array;
  pkY: Uint8Array;
  /** Owner key, H(nk, x_hi, x_lo, y_hi, y_lo). Public, in the registry. */
  opk: bigint;
  /** X25519 viewing key pair. The public half is in the registry. */
  viewSecret: Uint8Array;
  viewPublic: Uint8Array;
}

/**
 * The fixed Sign-In with Ethereum (EIP-4361) message whose signature derives every privacy key.
 * Every field is fixed, so the same wallet always signs the same text and gets the same keys.
 */
export function activationMessage(p: { domain: string; address: Address; chainId: number; vault: Address }): string {
  const vault = p.vault.toLowerCase();
  const scheme = p.domain.startsWith('localhost') || p.domain.startsWith('127.0.0.1') ? 'http' : 'https';
  return [
    `${p.domain} wants you to sign in with your Ethereum account:`,
    getAddress(p.address),
    '',
    `Activate privacy for the fractal vault ${vault}. This signature derives the keys that reveal your private balance. Sign it only on ${p.domain}.`,
    '',
    `URI: ${scheme}://${p.domain}`,
    'Version: 1',
    `Chain ID: ${p.chainId}`,
    `Nonce: ${vault.slice(2, 18)}`,
    'Issued At: 2026-01-01T00:00:00.000Z',
  ].join('\n');
}

export function ownerKey(nk: bigint, pkX: Uint8Array, pkY: Uint8Array): bigint {
  const [xHi, xLo] = limbs(pkX);
  const [yHi, yLo] = limbs(pkY);
  return h(nk, xHi, xLo, yHi, yLo);
}

/** Derives the keys from the activation signature and the public key it recovers to. */
export function keysFromSeed(seed: Uint8Array, pkX: Uint8Array, pkY: Uint8Array): PrivacyKeys {
  const sk = fromBytes(hkdf(sha256, seed, undefined, enc.encode('fractal/v1/sk'), 64)) % FIELD;
  const nk = h(sk);
  const viewSecret = hkdf(sha256, seed, undefined, enc.encode('fractal/v1/view'), 32);
  return { sk, nk, pkX, pkY, opk: ownerKey(nk, pkX, pkY), viewSecret, viewPublic: x25519.getPublicKey(viewSecret) };
}

export async function deriveKeys(message: string, signature: Hex): Promise<PrivacyKeys> {
  const pub = hexToBytes(await recoverPublicKey({ hash: hashMessage(message), signature }));
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('unexpected public key encoding');
  return keysFromSeed(hexToBytes(keccak256(signature)), pub.slice(1, 33), pub.slice(33, 65));
}

/** A second, never-registered identity under the same wallet key, for shareable private addresses. */
export function privateAddressKeys(k: PrivacyKeys, n = 0): PrivacyKeys {
  const seed = sha256(new Uint8Array([...enc.encode(`fractal/v1/private-address/${n}`), ...toBytes32(k.sk)]));
  return keysFromSeed(seed, k.pkX, k.pkY);
}

// ------------------------------------------------------------ payment links

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * A payment link is a random 32-byte seed. It deterministically gives a throwaway wallet key (which
 * signs the claim) and privacy keys (which own the funded note). Whoever has the link can claim.
 */
export function linkAccount(seed: Uint8Array): { privateKey: Hex; keys: PrivacyKeys } {
  if (seed.length !== 32) throw new Error('a link seed is 32 bytes');
  const k = fromBytes(sha256(new Uint8Array([...enc.encode('fractal/v1/link-wallet'), ...seed]))) % (SECP256K1_N - 1n) + 1n;
  const privateKey = `0x${k.toString(16).padStart(64, '0')}` as Hex;
  const pub = secp256k1.getPublicKey(hexToBytes(privateKey), false);
  return { privateKey, keys: keysFromSeed(seed, pub.slice(1, 33), pub.slice(33, 65)) };
}

// --------------------------------------------------------- private addresses

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export const encodeBase64Url = b64url;
export const decodeBase64Url = fromB64url;

/** A shareable private address: `fx1…` = owner key + viewing key. Paying it reveals nothing on-chain. */
export function encodePrivateAddress(opk: bigint, viewKey: Uint8Array): string {
  return 'fx1' + b64url(new Uint8Array([...toBytes32(opk), ...viewKey]));
}

export function decodePrivateAddress(s: string): { opk: bigint; viewKey: Uint8Array } {
  const t = s.trim();
  if (!t.startsWith('fx1')) throw new Error('not a fractal private address');
  const b = fromB64url(t.slice(3));
  if (b.length !== 64) throw new Error('malformed private address');
  return { opk: fromBytes(b.slice(0, 32)), viewKey: b.slice(32) };
}
