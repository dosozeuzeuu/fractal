import { h } from './poseidon.js';

export const DEPTH = 24;

/** Off-chain replica of the vault's NoteTree (append-only, Poseidon2 nodes, zero leaf = 0). */
export class NoteTree {
  readonly zeros: bigint[] = [];
  private layers: Map<number, bigint>[] = [];
  size = 0;

  constructor() {
    let z = 0n;
    for (let i = 0; i <= DEPTH; i++) {
      this.zeros.push(z);
      this.layers.push(new Map());
      z = h(z, z);
    }
  }

  private node(level: number, index: number): bigint {
    return this.layers[level].get(index) ?? this.zeros[level];
  }

  /** Sets leaf `index` and recomputes its path to the root. Leaves must be added in order. */
  insert(index: number, leaf: bigint): void {
    if (index !== this.size) throw new Error(`tree out of sync: expected leaf ${this.size}, got ${index}`);
    this.layers[0].set(index, leaf);
    let idx = index;
    for (let level = 0; level < DEPTH; level++) {
      const parent = idx >> 1;
      const left = this.node(level, parent * 2);
      const right = this.node(level, parent * 2 + 1);
      this.layers[level + 1].set(parent, h(left, right));
      idx = parent;
    }
    this.size = index + 1;
  }

  root(): bigint {
    return this.node(DEPTH, 0);
  }

  leaf(index: number): bigint {
    return this.node(0, index);
  }

  path(index: number): bigint[] {
    const path: bigint[] = [];
    let idx = index;
    for (let level = 0; level < DEPTH; level++) {
      path.push(this.node(level, idx ^ 1));
      idx >>= 1;
    }
    return path;
  }
}
