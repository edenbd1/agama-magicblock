#!/bin/zsh
# Keeper wrapper for launchd. The rollup only accrues while this runs: stop it and
# the agYLD price freezes at whatever the last tick marked.
# launchd starts with no PATH and no working directory, so both are set here.
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$HOME/.local/share/solana/install/active_release/bin:/opt/homebrew/bin:/usr/bin:/bin"
cd "$(cd "$(dirname "$0")/.." && pwd)"
export TICK_MS=${TICK_MS:-1000}
export ABSORB_EVERY=${ABSORB_EVERY:-15}
# The validator accepts 10 plain commits per delegation, so commit slowly and let
# the session close by re-delegating rather than paying for a commit stream.
export COMMIT_EVERY=${COMMIT_EVERY:-600}
exec ./node_modules/.bin/tsx scripts/keeper.ts
