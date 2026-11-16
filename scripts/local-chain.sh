#!/usr/bin/env bash
# Starts a fresh local chain and deploys fractal to it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/.toolchain/bin:$PATH"
pkill -f "anvil" 2>/dev/null || true
anvil --silent --gas-limit 60000000 > /dev/null 2>&1 &
sleep 2
cd "$ROOT/contracts"
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast > /dev/null
cat deployments/31337.json
