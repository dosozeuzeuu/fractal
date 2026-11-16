// Writes public/config.json for a network from its deployment file.
//   node scripts/config.mjs local
//   node scripts/config.mjs testnet [bundlerUrl]
//   node scripts/config.mjs mainnet [bundlerUrl]   (default bundler: this site's /api/bundler)
import { readFileSync, writeFileSync } from 'fs';
const ZERO = '0x0000000000000000000000000000000000000000';
const NETWORKS = {
  local: { chainId: 31337, name: 'Local chain', rpc: 'http://127.0.0.1:8545', explorer: '' },
  testnet: { chainId: 46630, name: 'Robinhood Chain Testnet', rpc: 'https://rpc.testnet.chain.robinhood.com', explorer: 'https://explorer.testnet.chain.robinhood.com' },
  mainnet: { chainId: 4663, name: 'Robinhood Chain', rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com' },
};
const [net = 'local', bundlerArg] = process.argv.slice(2);
const bundlerUrl = bundlerArg ?? (net === 'local' ? '' : '/api/bundler');
const n = NETWORKS[net];
if (!n) throw new Error(`unknown network ${net}`);
const d = JSON.parse(readFileSync(new URL(`../../../contracts/deployments/${n.chainId}.json`, import.meta.url)));
const tokens = [{ address: ZERO, symbol: 'ETH', decimals: 18 }];
let swap;
if (net === 'local') {
  tokens.push({ address: d.tokenA, symbol: 'tUSD', decimals: 6 }, { address: d.tokenB, symbol: 'tGOLD', decimals: 18 });
  swap = { adapter: d.swapAdapter, kind: 'mock' };
} else if (net === 'mainnet') {
  // List a token here only after vault.setToken(token, true, threshold, cap) for it.
  tokens.push({ address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', decimals: 6 });
  swap = d.swapAdapter !== ZERO && {
    adapter: d.swapAdapter, kind: 'uniswap-v3', feeTier: 3000,
    quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7', weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  };
}
if (net === 'local' && d.tokenC) tokens.push({ address: d.tokenC, symbol: 'tMEME', decimals: 18 });
const bridge = d.bridgeAdapter && d.bridgeAdapter !== ZERO
  ? { adapter: d.bridgeAdapter, depositHandler: d.depositHandler, weth: d.weth, acrossApi: net === 'local' ? '' : '/api/across' }
  : undefined;
const config = {
  ...n, vault: d.vault, entryPoint: d.entryPoint, feeCollector: d.feeCollector, startBlock: String(d.startBlock),
  devVerifier: d.devVerifier, bundlerUrl, tokens, swap: swap || undefined, swapFeeBps: 30,
  bridge, autoList: true, dexscreener: net === 'mainnet' ? 'robinhood' : '',
};
writeFileSync(new URL('../public/config.json', import.meta.url), JSON.stringify(config, null, 2) + '\n');
console.log(`public/config.json → ${n.name}, vault ${d.vault}`);
