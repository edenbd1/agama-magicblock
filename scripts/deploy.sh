#!/bin/zsh
# Deploy Agama to Solana devnet, then initialise it and hand the lending book to
# MagicBlock's TEE validator. Waits for the payer to be funded first, because a
# 599 kB program needs ~3.8 SOL of rent-exempt balance and a half-funded deploy
# leaves an orphan buffer behind.
set -e
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/.."

RPC=${RPC:-https://api.devnet.solana.com}
NEED=${NEED:-4.2}

echo "payer  $(solana address)"
echo "waiting for at least ${NEED} SOL on devnet…"
while true; do
  BAL=$(solana balance --url "$RPC" 2>/dev/null | awk '{print $1}')
  if [ -n "$BAL" ] && [ "$(echo "$BAL >= $NEED" | bc -l)" = "1" ]; then
    echo "funded: ${BAL} SOL"
    break
  fi
  echo "  ...${BAL:-0} SOL"
  sleep 15
done

echo "\n=== deploy ==="
solana program deploy target/deploy/agama_magicblock.so \
  --program-id target/deploy/agama_magicblock-keypair.json \
  --url "$RPC"

echo "\n=== initialise + delegate ==="
npx tsx scripts/setup.ts
