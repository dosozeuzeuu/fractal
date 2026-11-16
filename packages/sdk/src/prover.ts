import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import { Noir, type CompiledCircuit, type InputMap } from '@noir-lang/noir_js';
import { bytesToHex, type Hex } from 'viem';

export interface Proof {
  proof: Hex;
  publicInputs: Hex[];
}

/** Anything that can prove the transact circuit. */
export interface ProverLike {
  prove(inputs: InputMap): Promise<Proof>;
}

/**
 * Proves the `transact` circuit on this device: noir_js solves the witness, bb.js proves
 * with UltraHonk for the EVM verifier (zero-knowledge, keccak transcript). The witness,
 * which holds the note secrets, the nullifier key and the signature, never leaves it.
 */
export class Prover implements ProverLike {
  private noir: Noir;
  private backend?: UltraHonkBackend;
  private api?: Barretenberg;

  /**
   * @param options.srs  BN254 CRS points to prove with (uncompressed G1, 64 bytes each, and the G2 point).
   *                     When given, bb.js does not fetch any CRS itself. Browsers should pass this.
   * @param options.crsPath  Node only: directory holding bn254_g1.dat / bn254_g2.dat.
   */
  constructor(
    private circuit: CompiledCircuit,
    private options: { threads?: number; crsPath?: string; srs?: { g1: Uint8Array; g2: Uint8Array } } = {},
  ) {
    this.noir = new Noir(circuit);
  }

  private async init(): Promise<UltraHonkBackend> {
    if (!this.backend) {
      const { threads, crsPath, srs } = this.options;
      this.api = await Barretenberg.new({ threads, crsPath, skipSrsInit: Boolean(srs) } as never);
      if (srs) {
        await this.api.srsInitSrs({ pointsBuf: srs.g1, numPoints: srs.g1.length / 64, g2Point: srs.g2 });
      }
      this.backend = new UltraHonkBackend(this.circuit.bytecode, this.api);
    }
    return this.backend;
  }

  async prove(inputs: InputMap): Promise<Proof> {
    const backend = await this.init();
    const { witness } = await this.noir.execute(inputs);
    const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: 'evm' });
    return { proof: bytesToHex(proof), publicInputs: publicInputs as Hex[] };
  }

  async verify(p: Proof): Promise<boolean> {
    const backend = await this.init();
    const { hexToBytes } = await import('viem');
    return backend.verifyProof({ proof: hexToBytes(p.proof), publicInputs: p.publicInputs }, { verifierTarget: 'evm' });
  }

  async destroy(): Promise<void> {
    await this.api?.destroy();
  }
}
