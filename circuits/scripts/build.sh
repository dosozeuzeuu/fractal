#!/usr/bin/env bash
# Builds the transact circuit, its verification key and the Solidity verifier, and copies the
# artifacts to the contracts, the SDK and the web app.
#
#   CRS_PATH=~/.bb-crs bash circuits/scripts/build.sh        # production: Aztec's CRS (bb downloads it)
#   CRS_PATH=~/.bb-crs-dev bash circuits/scripts/build.sh    # local testing only (dev-crs.mjs)
#
# The script checks the CRS against Aztec's Ignition G2 point. With any other CRS it marks the
# verifier DEV-ONLY, and the deploy script refuses to deploy it to anything but a local chain.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$ROOT/.toolchain/bin:$PATH"
CRS_PATH="${CRS_PATH:-$HOME/.bb-crs}"
cd "$ROOT/circuits"

echo "› nargo $(nargo --version | head -1 | awk '{print $4}'), bb $(bb --version)"
nargo test
nargo compile
bb gates -b target/transact.json | grep -E 'circuit_size|acir_opcodes'

# Make sure the CRS is present (bb fetches Aztec's CRS on first use when it can reach the host).
bb write_vk -b target/transact.json -o target -t evm -c "$CRS_PATH" >/dev/null
bb write_solidity_verifier -k target/vk -o target/HonkVerifier.sol -t evm -c "$CRS_PATH" >/dev/null

CHECK="$(node scripts/check-crs.mjs "$CRS_PATH")"
if [[ "$CHECK" == *'"official":true'* ]]; then
  echo "› CRS: Aztec Ignition (official)"
  MODE=official
else
  echo "› CRS: NOT Aztec's — building a DEV-ONLY verifier for local chains"
  MODE=dev
  node -e '
    const fs = require("fs");
    const [file, json] = process.argv.slice(1);
    const g2 = JSON.parse(json).devG2;
    let src = fs.readFileSync(file, "utf8");
    const aztec = ["0x260e01b251f6f1c7e7ff4e580791dee8ea51d87a358e038b4efe30fac09383c1","0x0118c4d5b837bcc2bc89b5b398b5974e9f5944073b32078b7e231fec938883b0","0x04fc6369f7110fe3d25156c1bb9a72859cf2a04641f99ba4ee413c80da6a5fe4","0x22febda3c0c0632a56475b4214e5615e11e6dd3f96e6cea2854a87d4dacc5e55"];
    aztec.forEach((a, i) => { if (!src.includes(a)) throw new Error("verifier layout changed"); src = src.replace(a, g2[i]); });
    src = src.replace("pragma solidity", "// DEV-ONLY VERIFIER: built on a CRS whose secret is public. Never deploy to a real network.\nbool constant HUSHPOOL_DEV_VERIFIER = true;\npragma solidity");
    fs.writeFileSync(file, src);
  ' target/HonkVerifier.sol "$CHECK"
fi

cp target/HonkVerifier.sol "$ROOT/contracts/src/verifier/HonkVerifier.sol"
mkdir -p "$ROOT/packages/sdk/circuit" "$ROOT/apps/web/public/circuit"
cp target/transact.json "$ROOT/packages/sdk/circuit/transact.json"
cp target/transact.json "$ROOT/apps/web/public/circuit/transact.json"
printf '{"mode":"%s","vkHash":"0x%s"}\n' "$MODE" "$(od -An -tx1 target/vk_hash | tr -d ' \n')" > "$ROOT/packages/sdk/circuit/build.json"
cp "$ROOT/packages/sdk/circuit/build.json" "$ROOT/apps/web/public/circuit/build.json"
node "$ROOT/circuits/scripts/publish-crs.mjs" "$CRS_PATH" "$ROOT"
echo "› done ($MODE): verifier → contracts/src/verifier, circuit → packages/sdk/circuit and apps/web/public/circuit"
