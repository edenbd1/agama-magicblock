#!/bin/zsh
# Bring the whole thing up from nothing.
#
#   1. build         the Anchor program
#   2. deploy.sh     deploy, initialise, fund the accounts the rollup clones, delegate
#   3. topup.sh      fund the keeper's ephemeral escrow on the rollup
#   4. keeper        tick, absorb, commit. Leave this running
#
# Steps 1 to 3 are idempotent; re-running them on a live deployment is safe.
set -e
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/.."

anchor build
./scripts/deploy.sh
./node_modules/.bin/tsx scripts/topup.ts
./node_modules/.bin/tsx scripts/state.ts

echo "\nstarting keeper (ctrl-c to stop)"
exec ./node_modules/.bin/tsx scripts/keeper.ts
