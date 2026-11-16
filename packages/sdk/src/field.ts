import { hexToBytes, bytesToHex, type Hex } from 'viem';

/** BN254 scalar field modulus. Every note value, key and hash lives below it. */
export const FIELD = 21888242871839275222246405745257275088548364400416663434500807173575808495617n;
export const MAX_AMOUNT = 1n << 120n;

export function toBytes32(x: bigint): Uint8Array {
  if (x < 0n || x >= 1n << 256n) throw new Error('value out of range for bytes32');
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function fromBytes(b: Uint8Array): bigint {
  let x = 0n;
  for (const byte of b) x = (x << 8n) | BigInt(byte);
  return x;
}

export const toHex32 = (x: bigint): Hex => bytesToHex(toBytes32(x));
export const fromHex = (h: Hex): bigint => fromBytes(hexToBytes(h));

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** A uniformly random field element: 64 random bytes reduced mod p (bias < 2^-250). */
export function randomField(): bigint {
  return fromBytes(randomBytes(64)) % FIELD;
}

/** Splits a 32-byte big-endian value into its high and low 128-bit halves. */
export function limbs(b: Uint8Array): [bigint, bigint] {
  if (b.length !== 32) throw new Error('expected 32 bytes');
  return [fromBytes(b.slice(0, 16)), fromBytes(b.slice(16))];
}
