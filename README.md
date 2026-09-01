# Agama on MagicBlock

The Agama protocol, deployed the way MagicBlock is meant to be used: a public,
composable token on Solana, with the machinery that moves it running on an
Ephemeral Rollup inside a TEE.

Same product as the Starknet, Sui and Stellar deployments. Deposit USDC, mint
agYLD, watch its price rise as four private-credit lending pools accrue. What
changes here is where each part of it executes.

## The rule

> Do not delegate the token. Delegate the machinery.

A delegated account is not writable on Solana. If agYLD's mint or its holder
balances were delegated, agYLD would stop composing with the rest of Solana, and
a yield-bearing token that cannot be used as collateral is not a product. So the
split is:

| Layer | What lives there | Why |
|---|---|---|
| **Solana devnet** | agYLD SPL mint, USDC custody, `deposit`, `redeem` | Must stay tradable, LP-able, usable as collateral |
| **Ephemeral Rollup** (public, EU) | The `PoolBook`: four pools, their principals, APRs, the marked NAV | Accrual per tick instead of per block, and ticking is free |
| **Private ER (TEE)** | Per-depositor `Position` ledgers, gated by an `EphemeralPermission` | Position detail should not be public |

Note that the book runs on an *open* rollup, not the TEE one. Pool marks, APRs and
NAV are things Agama publishes; putting them behind an enclave would hide the
wrong thing. Only per-depositor positions go to the TEE.

Short form: **public token, public book, private positions.**

This is hardware-verified confidentiality (Intel TDX), not zero-knowledge. The
trust assumption is the enclave and its attestation. Nothing in this repo should
be described as a proof system.

## What the program does

```
programs/agama-magicblock/src/lib.rs
```

**Base layer**

| Instruction | Effect |
|---|---|
| `initialize` | Vault PDA, a devnet USDC mint, the agYLD mint, custody ATA |
| `init_book` | Registers the four pools and their allocation weights |
| `faucet` | 1,000 test USDC, once a minute per wallet |
| `deposit` | USDC in, agYLD out at the current share price |
| `redeem` | agYLD burned, USDC out at the current share price |
| `init_position` | Opens a position ledger, pre-funded for its permission rent |
| `delegate_book` / `delegate_position` | Hands an account to the TEE validator |

**Ephemeral rollup**

| Instruction | Effect |
|---|---|
| `tick` | Accrues every pool to now and re-marks the NAV. Touches only the book |
| `absorb` | Deploys capital Solana has taken into the pools by weight, or pulls it back |
| `set_apr` | Moves a pool's rate, locking in yield at the old one first |
| `commit_book` | Pushes the ticked NAV back to Solana |
| `undelegate_book` | Commits and returns the book to the base layer |

**Private ephemeral rollup**

| Instruction | Effect |
|---|---|
| `init_permission` | Gates a position behind an `EphemeralPermission` |
| `set_permission` | Replaces the viewer set (absolute: omission revokes) |
| `close_permission` | Drops the gate and refunds its rent |
| `sync_position` | Recomputes marked value, cost basis and yield inside the enclave |
| `undelegate_position` | Returns the ledger to Solana |

## Two things worth reading the code for

**Pricing across the commit boundary.** `book.nav` only counts capital the rollup
has marked into a pool. Between a deposit landing on Solana and the tick that
absorbs it, those dollars sit in custody at par. `nav_for_pricing` adds them back
and subtracts payouts not yet unmarked, so the share price is exact between
commits instead of stepping every time the ER settles. The frontend uses the same
expression, so the UI and the chain never disagree.

**`tick` touches nothing but the book, on purpose.** The first version had it read
the base-layer vault directly, to work out how much new capital to deploy. That is
supposed to work (every Solana account is readable from a rollup) and it does,
right up until the account starts changing. Each deposit dirtied the vault, the
rollup had to re-clone it, and every tick in flight during a re-clone died with:

```
Cloner error: Failed to clone regular account <vault>:
TransactionError(InsufficientFundsForRent { account_index: 1 })
```

Ticks resumed the moment the vault stopped changing, which is a fine property for a
demo and a terrible one for a protocol whose whole point is taking deposits. So the
cross-layer read moved off-chain into the keeper, and allocation became `absorb`,
an owner-only instruction, which is also exactly what the Starknet deployment does.
Accrual is now a pure function of elapsed time on a single account, so a replayed
tick advances nothing and a missed one is caught up by the next. That is what makes
it a legitimate crank target.

**Entry price without a public trail.** A private position needs a cost basis, but
storing deposit amounts anywhere public defeats the point. Instead `sync_position`
reads the owner's agYLD balance and the ticked NAV, both on-chain, and carries a
share-weighted average entry price. Accrued yield is derived from that, entirely
inside the enclave, with nothing attested by the user.

## Running it

```bash
# everything, from nothing: build, deploy, initialise, delegate, then keep ticking
./scripts/run.sh

# or step by step
anchor build
./scripts/deploy.sh            # deploy + initialise + fund clones + delegate
npx tsx scripts/topup.ts       # fund the keeper's ephemeral escrow (once)
npx tsx scripts/state.ts       # read both layers and print the drift
npx tsx scripts/smoke.ts       # faucet, deposit, read the book back off the rollup

# keep the book ticking (free) and commit on a slow cadence (paid)
npx tsx scripts/keeper.ts
```

`scripts/common.ts` holds the endpoint wiring. Three endpoints, three jobs:

| | Endpoint | Used for |
|---|---|---|
| Base | `https://rpc.magicblock.app/devnet` | deploy, init, delegation, deposits |
| Router | `https://devnet-router.magicblock.app/` | *where* is a delegated account right now |
| ER | whatever the router's `fqdn` says | anything writing delegated state |

Never hardcode the ER endpoint. A re-delegation can move an account to a
different validator, and the router is the only thing that knows.

## Contracts

Solana has one program, not many contracts: what would be a separate address per
contract on an EVM chain is a PDA of a single program here. Everything below is on
**Solana devnet**.

### Agama

| | Address | What |
|---|---|---|
| Program | `GVHsSaFUkVAZJdRKWtK1SxYUhW2P7a7z1xBL5SaFj5vC` | 20 instructions, upgradeable |
| Vault | `RzouyB4AkAiBP1JvYUmNoEPpK8x77p2hMRAh27NJj6M` | PDA `[agama-vault]`. Mint authority and share accounting |
| Pool book | `y7QJuSwhnEvA6JLs5uiHWmpbYi2GHtJ6QmMENnv6b6x` | PDA `[lending-book, vault]`. The four pools. Delegated |
| agYLD mint | `5v2dRhbcEBWH5YUapkeQV9d3C84Ek4P8hH7tfWPxWCPA` | PDA `[agyld-mint]`, 6 decimals |
| Test USDC mint | `DuiuxGrD1iQJnuZKw1muqDgYRaV2QGvcqymM8ay4gy4Q` | PDA `[usdc-mint]`, 6 decimals |
| USDC custody | `ehxmrwjm5WoCMoh3KEe8WwXY35mj5oFbGRcJYF1qiyN` | The vault's ATA, where the collateral sits |

On an explorer the pool book reads as owned by `DELeGGvX…`. That is what a delegated
account looks like, not a mistake.

### Per depositor

Derived, one set per wallet.

| | Seeds | Program |
|---|---|---|
| Position | `[b"position", owner]` | Agama |
| Permission | `[b"permission:", position]` | Permission program. Note the colon |
| Faucet claim | `[b"faucet-claim", owner]` | Agama |

A live gated position, if you want to check the permission rather than take its word
for it: `AqLimuytaHz8WKdgJpcy2kDjxDMFQskdVDmTwavHp7cB`. Call `getAccountInfo` on it
against `devnet-tee.magicblock.app` and it returns null, with or without a valid
login token, unless you are the owner.

### MagicBlock

| | Address |
|---|---|
| Delegation program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| Magic program | `Magic11111111111111111111111111111111111111` |
| Magic context | `MagicContext1111111111111111111111111111111` |
| Permission program (PER) | `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1` |
| Ephemeral vault | `MagicVau1t999999999999999999999999999999999` |

### Validators

| | Address | Holds |
|---|---|---|
| EU, public | `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` | the pool book |
| TEE, Intel TDX | `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` | every private position |

`scripts/e2e.ts` walks the whole thing from a keypair that has never existed, which
is the only test that catches all six problems below in the order a user hits them.
Its last step is the claim, stated as a measurement rather than an adjective:

```
[5] who can read the ledger
       owner (on the permission) 126 bytes
       stranger (valid login)    nothing
       anonymous (no login)      nothing
```

## Six things that cost an afternoon each

Every one of these is a MagicBlock-specific failure with an error message that
points somewhere other than the cause. Together they are the real integration
report.

**1. The devnet TEE write gate is self-serve, and undocumented where you look for
it.** `devnet-tee.magicblock.app` answers reads and rejects `sendTransaction` with
`401 {"error":"Missing token query param"}`. That reads like an allowlist. It is
not: the token is a 30-day JWT you mint yourself by signing a challenge with the
same keypair that will sign the transactions.

```
GET  {rpc}/auth/challenge?pubkey=<base58>   ->  { challenge }
POST {rpc}/auth/login  { pubkey, challenge, signature }  ->  { token, expiresAt }
     then append ?token=<jwt> to BOTH the http and the ws URL
```

`getAuthToken` in `@magicblock-labs/ephemeral-rollups-sdk` does it; `scripts/common.ts`
wraps it as `qfsToken` / `authedConnectionTo`, and the browser has its own copy in
`app/lib/magicblock/auth.ts` that signs with the wallet instead of a keypair.

The distinction worth keeping straight: **the token proves which pubkey you are and
nothing else.** Whether the rollup then shows you an account is decided by the
on-chain `EphemeralPermission`. Endpoint authentication and authorization are two
different layers, and conflating them is how you end up believing a gated account
is public.

**2. `PERMISSION_SEED` is `b"permission:"`, with the colon.** Derive it without and
you get a perfectly valid-looking PDA that the program rejects with Anchor error
2006, `ConstraintSeeds`, which says nothing about seeds you got almost right.

**3. The rollup charges clone rent to the cloned account.** The first rollup
transaction that touches an account re-creates it inside the rollup's own state and
bills that account, not the transaction payer. Solana's rent-exempt minimum is not
enough:

```
Cloner error: Failed to clone regular account <pubkey>:
TransactionError(InsufficientFundsForRent { account_index: 1 })
```

It applies to read-only clones and to plain SPL token accounts, which carry about
0.0019 SOL and get rejected. Empirically the floor is around 0.02 to 0.03 SOL per
account. That is the single most expensive thing about giving a user a private
position: at mainnet prices, roughly five dollars of rent for the position PDA and
the token account it reads. `prepare_for_rollup` makes that an explicit, opt-in
step rather than a surprise, and `scripts/setup.ts` does the same for the vault and
the book. **This is the number to ask MagicBlock about.**

**4. A cross-layer read of a hot account stalls the rollup.** `tick` originally read
the base-layer vault to work out how much new capital to deploy. Every deposit
dirtied the vault, the rollup re-cloned it, and every tick in flight during a
re-clone died with the same clone error as above. Ticks resumed the moment the
vault stopped changing, which is a fine property for a demo and a terrible one for a
protocol that takes deposits. The read moved off-chain into the keeper and
allocation became `absorb`, owner-only, which is also what the Starknet deployment
does. "Every Solana account is readable on a rollup" is true and quietly omits what
happens when it changes.

**4b. Moving that read off-chain costs you a trust assumption, and you have to buy
it back.** With the vault unreadable from the rollup, `absorb` takes the inflow as
an argument and the keeper is trusted to report it honestly. The Starknet version
does not have this problem: its `allocate` is owner-only too, but bounded by
`assert(self.idle >= amount)`, and there is no second layer to hide the vault.

The base layer is the only place that can still check the arithmetic, so it does.
`vault.total_in` and `total_out` are monotonic and live on Solana, so a book
claiming to have absorbed more than the vault ever took in is impossible, and
`nav_for_pricing` rejects it (`BookAheadOfVault`) instead of clamping it. That does
not stop a bad keeper from over-marking on the rollup; it stops the over-mark from
ever pricing a deposit or a redemption. Both revert until the book is corrected,
rather than quietly minting against an inflated NAV.

Worth naming out loud because it generalises: **anything you move off-chain to dodge
a cross-layer read has to be re-verified somewhere, and the base layer is usually
the only place left.**

**5. The query-filtering service proxies JSON-RPC but not the websocket methods
`confirmTransaction` needs.** The transaction lands; the client then throws
`Unknown action 'undefined'` from deep inside `AnchorProvider.sendAndConfirm`, long
after the on-chain work succeeded. `sendAndPoll` in `scripts/common.ts` sends and
polls `getSignatureStatuses` instead, which also surfaces the real program error
when there is one.

**6. Permission rent has no headroom on the grow path.** `EphemeralPermission::size_of(n)`
is `35 + (1 + n) * 33`, and `rent(bytes)` is `(bytes + 60) * 32` lamports. A
permission created with one member and later grown to a four-member cap needs
exactly the difference and not one lamport more. The position now pre-funds one
spare slot.

## Costs

ER transactions are free, which is what makes a 1-second tick viable at all. The
delegation itself is not: 0.0003 SOL per session at undelegation, and 0.0001 SOL
per committed account from the 26th commit onward when a delegated fee payer is
attached. Without one, the validator accepts ten plain commits and then hard-fails,
so `keeper.ts` commits on a slow cadence and the session is closed by
re-delegating rather than by paying for an unbounded commit stream.

## Scripts

| | |
|---|---|
| `run.sh` | build, deploy, initialise, delegate, then keep ticking |
| `deploy.sh` | deploy, initialise, fund the accounts the rollup clones, delegate |
| `setup.ts` | vault, mints, the four pools, delegation |
| `topup.ts` | fund the keeper's ephemeral escrow |
| `keeper.ts` | tick, absorb, commit |
| `state.ts` | read both layers and print the drift |
| `smoke.ts` | faucet, deposit, read the book back off the rollup |
| `privacy.ts` | the position ledger walk, with the three-reader check |
| `e2e.ts` | the same from a brand-new keypair |
| `probe-qfs.ts` | which methods a private endpoint gates, and what it says |

Set `MB_ENV=local` on any of them to point the whole suite at `mb-stack`
(base 8899, rollup 7799, query-filtering 6699). The local query-filtering service
gates writes with the same token flow as devnet's TEE, so the permission logic is
exercised identically; what it cannot give you is the hardware attestation.

## Not done yet

- **Cranks.** `tick` is written to be a crank target and the keeper is a stand-in
  for one. Moving it to `MagicBlockInstruction::ScheduleTask` removes the last
  piece of infrastructure Agama operates itself.
- **Private USDC leg.** The position ledger is private; the deposit that created it
  is a public SPL transfer, and the agYLD balance is a public SPL balance. What is
  hidden today is the *shape* of the position: entry price, marked value, accrued
  yield, and who else is allowed to see them. Routing the USDC leg through Ephemeral
  SPL Token private payments is what would close the rest of the gap.
- **Attestation.** Nothing here verifies the enclave's quote. `verifyTeeRpcIntegrity`
  exists in the SDK and should run before a client trusts a TEE endpoint in
  production; skipping it means trusting DNS.
- **Magic Actions.** Nothing here needs a base-layer swap yet. It would, the moment
  the pools stop being marks and start holding real assets.
- **Closing the gate.** `close_permission` is implemented and reachable from the
  client, but no UI step calls it. A position that leaves the rollup with its
  permission still open strands the rent.
