# fractal

Private money on **Robinhood Chain**. Shield ETH or listed tokens into encrypted notes, then send,
**swap**, withdraw, create payment links and share payment receipts — each action a zero-knowledge
proof built in the user's browser. Same architecture as voidcash (Elysium), rebuilt from its public
spec for Robinhood Chain (chain 4663, testnet 46630, gas in ETH). The code is original.

> **Status: beta, unaudited.** Do not hold real users' funds before an independent audit of the
> circuit and contracts. The vault caps ETH deposits (default 50 ETH) for exactly this reason.

## Features

| | What happens | On-chain you can see |
| --- | --- | --- |
| Shield | ETH or a listed ERC-20 becomes an encrypted note | depositor, token, amount |
| Send privately | pay a registered `0x` address or an `fx1…` private address | nothing about the payment |
| Private swap | notes of token A → vault swaps via Uniswap v3 → new note of token B; refunded in full if the minimum isn't met | the tokens and amounts, not who |
| Withdraw | to any address, 1% exit fee; above a per-token threshold, held 24 h | recipient, token, amount |
| Payment link | funds a secret URL (`/claim#…`); whoever opens it claims into their private balance | nothing about the payment |
| Receipt | `/receipt#…` proves one payment (amount, recipient) and nothing else | — |
| Private gas | with an ERC-4337 bundler, gas comes from private ETH; the user's address never appears | — |

## Layout

| Path | What it is |
| --- | --- |
| `circuits/transact` | Noir circuit v2: 3 notes in, 3 out; a main lane in any token plus an ETH gas lane; Poseidon2 tree (depth 24); nullifiers; per-lane value conservation; swap amount + output stub; ECDSA check of the wallet's EIP-712 `Spend`. 91,187 gates (2^17). |
| `circuits/scripts/build.sh` | Builds circuit, VK and Solidity verifier; detects whether the CRS is Aztec's official one; publishes the CRS into the app. |
| `contracts/src/PrivateVault.sol` | UUPS vault: notes, ETH/ERC-20 shield, per-token accounting, private transact, swaps through allowlisted adapters (refund on failure), exits with 1% fee and per-token 24 h hold, guardian pause/stop, caps, its own ERC-4337 account. |
| `contracts/src/adapters/UniswapV3Adapter.sol` | Swaps through Uniswap SwapRouter02 on Robinhood Chain (`0xCaf6…5cb2`), wrapping/unwrapping WETH. |
| `contracts/src/Poseidon2Sponge.sol` | 4-input Poseidon2 for commitments on the fast Yul permutation (52k gas; matches Noir). |
| `contracts/src/FeeCollector.sol` | Splits fees per token: half team, half buyback sink. |
| `packages/sdk` | TypeScript SDK: keys from one signature, note encryption, tree sync, proving, shield/send/swap/withdraw, payment links, receipts, private addresses, ERC-4337 user operations. |
| `apps/web` | The fractal website and app (Vite + React): `/`, `/app`, `/claim`, `/receipt`. Self-hosts fonts and the proving CRS. |

**Stack:** Noir 1.0.0 · Barretenberg / bb.js 5.2.1 (UltraHonk) · Poseidon2 (BN254) · X25519 + ChaCha20-Poly1305 ·
EIP-712 · Solidity 0.8.38 + Foundry · OpenZeppelin 5.4 · ERC-4337 EntryPoint v0.8 · Uniswap v3 · viem · React.

## What was tested

- **40 Foundry tests**: shield (ETH, tokens, unlisted, fee-on-transfer, caps), withdrawals, fuzzed fees,
  double spends, all three swap directions, slippage and broken-adapter refunds, swap validation, per-token
  large-exit hold/stop/resume, delisting, roles, upgrades, ERC-4337 (token withdraw with ETH gas, private
  swap, underpaid gas, starved call gas, wrong caller/nonce, bad proof), Poseidon2 vs Noir.
- **End-to-end with real proofs** (`packages/sdk/test/e2e.ts`): every feature above plus attacks (replay,
  tampered recipient, tampered swap minimum, stolen keys without the wallet, forged receipts), with
  per-token solvency checked after each step. Private send via ERC-4337: ~5.7M gas; private swap: ~6.5M.
- **Browser** (headless Chrome, built app): every tab, an `fx1` payment, both swap paths, link claimed by a
  second wallet, receipt confirmed and a forged receipt rejected.

**Built on Aztec's official CRS.** The verifier, the VK (hash `0x18c57e5b…c64b9`) and `apps/web/public/crs`
come from Aztec's Ignition CRS (`g1_compressed.dat` bytes 0–8,388,607, SHA-256 `5107a792…684934`;
`g2.dat`, SHA-256 `01797bfc…69c32f`). All 262,144 points were decompressed and checked against Ignition's
G2 point with one batched pairing (`P[i+1] = x·P[i]` for every i). The same check rejects the dev CRS.
The Foundry suite and the real-proof e2e pass on this build.

**Not exercised here (sandbox network limits):** in-browser proving with the official CRS (the browser
test proved through a localhost native prover in a test-only build), a live Alto bundler (ERC-4337 was
tested through `EntryPoint.handleOps`), and real Uniswap (the local chain uses a fixed-price mock DEX).
For the last one, run the included fork test:
`ROBINHOOD_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path 'test/fork/*'`.

## Run locally

Requirements: Node 22, [Foundry](https://getfoundry.sh), Noir 1.0.0 (`noirup -v 1.0.0`), bb 5.2.1 (`bbup -v 5.2.1`).

```bash
npm install && (cd contracts && npm install)
bash circuits/scripts/build.sh                 # Aztec's CRS (bb downloads it to ~/.bb-crs)
bash scripts/local-chain.sh                    # anvil + deploy + test tokens + mock DEX
npm -w @fractal/sdk run e2e                    # real-proof end-to-end test
(cd contracts && forge test)
npm -w @fractal/web run config local && npm -w @fractal/web run dev    # http://localhost:5173
```

## Deploy to Robinhood Chain

1. **Build with Aztec's CRS** (done): `bash circuits/scripts/build.sh` printed `CRS: Aztec Ignition (official)`,
   and the checked-in verifier and `apps/web/public/crs` are official builds. If you rebuild, it must print that
   line again, or the deploy script will refuse any real chain.
2. **Fork-test the swap adapter** against mainnet (command above), and confirm the pool fee tier you'll route
   through (the app defaults to 0.3%, `feeTier` in `apps/web/scripts/config.mjs`).
3. **Deploy** (testnet first): `PRIVATE_KEY=… ADMIN=0xYourSafe TEAM=… forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast`.
   On mainnet (4663) it also deploys the Uniswap adapter. List tokens with `vault.setToken(token, true, largeExitThreshold, cap)`.
4. **Configure and host the app**: `npm -w @fractal/web run config mainnet https://your-bundler`, build, host `apps/web/dist`
   (Vercel works as-is; `vercel.json` sets the isolation headers the prover needs).
5. **Run a bundler** ([Alto](https://github.com/pimlicolabs/alto)) for private gas. Swaps need a 1.4M call-gas limit.
6. **Before mainnet:** independent audit, legal review, a multisig admin and a timelock on upgrades.

## Not built yet

Private-address receipts (receipts cover payments to registered addresses), multi-hop swap routing in the
UI (the adapter supports paths), the buy-and-burn contract behind the buyback sink, an event indexer (the app
reads logs from the RPC), and an MCP server.

## Trust model

Only a note's owner can spend it: every spend needs a fresh wallet signature that the circuit verifies. The
admin can pause spending, hold large withdrawals during their 24-hour window, list tokens and swap adapters,
set fees within bounds, and **upgrade the vault**, which reaches every rule; upgrades have no timelock in this
version. A malicious swap adapter could only lose the amount being swapped, and only admins can allowlist one.
fractal is independent and not affiliated with Robinhood.

## Public site (pre-launch)

`apps/site` is the standalone landing page deployed to Vercel (project `fractal`,
https://fractal-eta.vercel.app). App pages show a launch screen until the contracts are live. Once
the vault is on Robinhood Chain, deploy `apps/web` instead (`npm -w @fractal/web run config mainnet <bundler>`,
then build), which includes the full app, claim and receipt pages.
