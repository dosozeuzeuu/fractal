// DEV-ONLY structured reference string for local testing in environments that cannot reach
// Aztec's CRS host. Its secret `tau` is PUBLIC (below), so anyone could forge proofs against a
// verifier built from it. NEVER deploy a verifier built on this CRS to a real network:
// contracts/script/Deploy.s.sol refuses any verifier that does not embed Aztec's Ignition G2 point.
import { bn254 } from '@noble/curves/bn254';
import { mkdirSync, openSync, writeSync, closeSync, writeFileSync } from 'fs';

const dir = process.argv[2];
const n = Number(process.argv[3] ?? (1 << 17) + 64);
if (!dir) throw new Error('usage: node dev-crs.mjs <dir> [points]');
const TAU = 0x5eed_c0ffee_dead_beefn; // PUBLIC — dev only

const be = (x) => { const b = Buffer.alloc(32); b.write(x.toString(16).padStart(64, '0'), 'hex'); return b; };
mkdirSync(dir, { recursive: true });
const fd = openSync(`${dir}/bn254_g1.dat`, 'w');
const G = bn254.G1.ProjectivePoint.BASE;
const r = bn254.fields.Fr.ORDER;
let s = 1n;
const CHUNK = 4096;
let buf = Buffer.alloc(64 * CHUNK), k = 0;
for (let i = 0; i < n; i++) {
  const p = G.multiply(s).toAffine();
  be(p.x).copy(buf, k * 64); be(p.y).copy(buf, k * 64 + 32);
  if (++k === CHUNK) { writeSync(fd, buf); k = 0; }
  s = (s * TAU) % r;
  if (i % 16384 === 0) process.stderr.write(`g1 ${i}/${n}\n`);
}
if (k) writeSync(fd, buf.subarray(0, k * 64));
closeSync(fd);
const g2 = bn254.G2.ProjectivePoint.BASE.multiply(TAU).toAffine();
// x = c0 + c1·u, y likewise; written c0, c1 per coordinate (big-endian 32 bytes each).
writeFileSync(`${dir}/bn254_g2.dat`, Buffer.concat([be(g2.x.c0), be(g2.x.c1), be(g2.y.c0), be(g2.y.c1)]));
console.log(`wrote ${n} G1 points and tau·G2 to ${dir}`);
