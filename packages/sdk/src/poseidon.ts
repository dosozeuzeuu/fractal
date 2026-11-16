import { BarretenbergSync } from '@aztec/bb.js';
import { fromBytes, toBytes32, FIELD } from './field.js';

let bb: BarretenbergSync | undefined;

/** Loads Barretenberg's Poseidon2 (BN254, t=4) — the same hash as the circuit and the on-chain hasher. */
export async function initPoseidon(): Promise<void> {
  if (!bb) bb = await BarretenbergSync.new();
}

/** H(x1, ..., xn): Poseidon2 sponge with IV = n << 64, as noir-lang/poseidon and poseidon2-evm. */
export function h(...inputs: bigint[]): bigint {
  if (!bb) throw new Error('call initPoseidon() first');
  for (const x of inputs) if (x < 0n || x >= FIELD) throw new Error('hash input is not a field element');
  return fromBytes(bb.poseidon2Hash({ inputs: inputs.map(toBytes32) }).hash);
}
