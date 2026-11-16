// Builds a one-file page that deploys fractal to Robinhood Chain mainnet from a browser wallet.
//   node tools/deploy-page/build.mjs      (after circuits/scripts/build.sh and `forge build`)
// Refuses to build from a dev verifier. Output: tools/deploy-page/dist/index.html
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const root = new URL('../../', import.meta.url);
const art = (file, name) => JSON.parse(readFileSync(new URL(`contracts/out/${file}/${name}.json`, root), 'utf8'));
const src = readFileSync(new URL('contracts/src/verifier/HonkVerifier.sol', root), 'utf8');
if (src.includes('DEV-ONLY VERIFIER')) throw new Error('dev verifier: rebuild with Aztec CRS first');
const build = JSON.parse(readFileSync(new URL('packages/sdk/circuit/build.json', root), 'utf8'));
if (build.mode !== 'official') throw new Error('circuit build is not official');

const bc = (a) => a.bytecode.object;
const honk = art('HonkVerifier.sol', 'HonkVerifier');
const links = [];
for (const [, libs] of Object.entries(honk.bytecode.linkReferences)) {
  for (const [lib, refs] of Object.entries(libs)) links.push({ lib, offsets: refs.map((r) => r.start) });
}
const A = {
  RelationsLib: bc(art('HonkVerifier.sol', 'RelationsLib')),
  ZKTranscriptLib: bc(art('HonkVerifier.sol', 'ZKTranscriptLib')),
  HonkVerifier: bc(honk),
  Poseidon2Yul: bc(art('Poseidon2Yul.sol', 'Poseidon2Yul_BN254')),
  Poseidon2Sponge: bc(art('Poseidon2Sponge.sol', 'Poseidon2Sponge')),
  FeeCollector: bc(art('FeeCollector.sol', 'FeeCollector')),
  PrivateVault: bc(art('PrivateVault.sol', 'PrivateVault')),
  ERC1967Proxy: bc(art('ERC1967Proxy.sol', 'ERC1967Proxy')),
  UniswapV3Adapter: bc(art('UniswapV3Adapter.sol', 'UniswapV3Adapter')),
};
for (const [k, v] of Object.entries(A)) if (k !== 'HonkVerifier' && v.includes('__$')) throw new Error(`${k} needs linking`);
if (links.map((l) => l.lib).sort().join() !== 'RelationsLib,ZKTranscriptLib') throw new Error('unexpected verifier libraries');

const template = readFileSync(new URL('./page.html', import.meta.url), 'utf8');
const html = template
  .replace('/*__ARTIFACTS__*/', `const ART = ${JSON.stringify(A)};\nconst LINKS = ${JSON.stringify(links)};\nconst VK_HASH = ${JSON.stringify(build.vkHash)};`);
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('./dist/index.html', import.meta.url), html);
console.log(`deploy page built (vk ${build.vkHash}), ${(html.length / 1024).toFixed(0)} KB`);
