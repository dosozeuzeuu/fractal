// Checks whether a CRS directory is Aztec's Ignition CRS by pairing:  e([x]₁, G₂) == e(G₁, [x]₂)
// where [x]₂ is the Ignition G2 point that bb hard-codes into every Solidity verifier.
// Prints a JSON line: {"official":bool, "devG2":[x.c1,x.c0,y.c1,y.c0]} (EVM order).
import { bn254 } from '@noble/curves/bn254';
import { openSync, readSync, readFileSync, closeSync } from 'fs';

const dir = process.argv[2];
const AZTEC_G2 = { // EVM order: x.c1, x.c0, y.c1, y.c0
  x1: 0x260e01b251f6f1c7e7ff4e580791dee8ea51d87a358e038b4efe30fac09383c1n,
  x0: 0x0118c4d5b837bcc2bc89b5b398b5974e9f5944073b32078b7e231fec938883b0n,
  y1: 0x04fc6369f7110fe3d25156c1bb9a72859cf2a04641f99ba4ee413c80da6a5fe4n,
  y0: 0x22febda3c0c0632a56475b4214e5615e11e6dd3f96e6cea2854a87d4dacc5e55n,
};
const { Fp2 } = bn254.fields;
const hex = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const fd = openSync(`${dir}/bn254_g1.dat`, 'r');
const buf = Buffer.alloc(128);
readSync(fd, buf, 0, 128, 0);
closeSync(fd);
const g1_0 = bn254.G1.ProjectivePoint.fromAffine({ x: hex(buf.subarray(0, 32)), y: hex(buf.subarray(32, 64)) });
const g1_1 = bn254.G1.ProjectivePoint.fromAffine({ x: hex(buf.subarray(64, 96)), y: hex(buf.subarray(96, 128)) });
if (!g1_0.equals(bn254.G1.ProjectivePoint.BASE)) throw new Error('CRS does not start with the BN254 generator');
const aztecG2 = bn254.G2.ProjectivePoint.fromAffine({
  x: Fp2.fromBigTuple([AZTEC_G2.x0, AZTEC_G2.x1]),
  y: Fp2.fromBigTuple([AZTEC_G2.y0, AZTEC_G2.y1]),
});
const lhs = bn254.pairing(g1_1, bn254.G2.ProjectivePoint.BASE);
const rhs = bn254.pairing(bn254.G1.ProjectivePoint.BASE, aztecG2);
const official = bn254.fields.Fp12.eql(lhs, rhs);
const g2 = readFileSync(`${dir}/bn254_g2.dat`);
const c = [0, 1, 2, 3].map((i) => '0x' + g2.subarray(i * 32, i * 32 + 32).toString('hex'));
// file order is x.c0, x.c1, y.c0, y.c1 → EVM order x.c1, x.c0, y.c1, y.c0
console.log(JSON.stringify({ official, devG2: [c[1], c[0], c[3], c[2]] }));
