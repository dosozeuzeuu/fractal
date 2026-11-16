// Copies the CRS the circuit was built with into the web app, so browsers load it from the app's
// own origin (Aztec's CDN would otherwise see each user's IP when they prepare a transaction).
// The SHA-256 of each file is pinned into the app bundle (apps/web/src/crs-manifest.json).
import { createHash } from 'crypto';
import { existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, writeFileSync } from 'fs';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';

const [crsPath, root] = process.argv.slice(2);
const POINTS = (1 << 17) + 64; // circuit domain 2^17, plus headroom
const g1File = `${crsPath}/bn254_g1.dat`;

if (!existsSync(g1File)) {
  // bb.js decompresses Aztec's compressed CRS once and caches bn254_g1.dat next to it.
  const circuit = JSON.parse(readFileSync(`${root}/circuits/target/transact.json`, 'utf8'));
  const api = await Barretenberg.new({ crsPath });
  await new UltraHonkBackend(circuit.bytecode, api).getVerificationKey({ verifierTarget: 'evm' });
  await api.destroy();
}
const g1 = Buffer.alloc(POINTS * 64);
const fd = openSync(g1File, 'r');
const read = readSync(fd, g1, 0, g1.length, 0);
closeSync(fd);
if (read !== g1.length) throw new Error(`CRS has only ${read / 64} points, need ${POINTS}`);
const g2 = readFileSync(`${crsPath}/bn254_g2.dat`);

const out = `${root}/apps/web/public/crs`;
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/bn254_g1.dat`, g1);
writeFileSync(`${out}/bn254_g2.dat`, g2);
const sha = (b) => createHash('sha256').update(b).digest('hex');
writeFileSync(
  `${root}/apps/web/src/crs-manifest.json`,
  JSON.stringify({ points: POINTS, g1Sha256: sha(g1), g2Sha256: sha(g2) }, null, 2) + '\n',
);
console.log(`› CRS published to apps/web/public/crs (${POINTS} points)`);
