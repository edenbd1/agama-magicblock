# Agama on MagicBlock

The Agama protocol, deployed the way MagicBlock is meant to be used: a public,
composable token on Solana, with the machinery that moves it running on an
Ephemeral Rollup inside a TEE.

Same product as the Starknet, Sui and Stellar deployments. Deposit USDC, mint
agYLD, watch its price rise as four private-credit lending pools accrue. What
changes here is where each part of it executes.

And one thing the other deployments cannot do: a **fully private deposit**. The
USDC goes in through MagicBlock's private payments, comes back as shares that
exist only inside the TEE, and leaves through MagicBlock's private transfer
queue. Solana never sees an Agama instruction for it. See
[Fully private deposits](#fully-private-deposits).

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
| **Private ER (TEE)** | Per-depositor `Position` ledgers, gated by an `EphemeralPermission`; the private custody, its aggregate (`Shielded`) and its exit tickets (`ExitBook`) | Position detail should not be public, and a private deposit should not be either |

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
| `authorize_session` | Lets a browser-held key act on the position inside the rollup |
| `prepare_for_rollup` | Tops the ledger and the agYLD account up to the clone floor |
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
| `rotate_session` | Trusts a new session key, on an Ed25519 signature from the owner's wallet read next to it |
| `init_shielded_permission` | Gates `Shielded` and `ExitBook` to the vault authority |
| `deposit_private` | Credits private shares for a shielded transfer it reads in the same transaction |
| `redeem_private` | Burns private shares, opens an exit ticket to the owner's wallet |
| `settle_exit` | Closes a ticket, only next to the custody's actual payment of it |
| `commit_shielded` | Publishes the private aggregate to Solana, as one batched number |
| `undelegate_shielded` | Commits and returns the aggregate, to recycle its delegation |

Base layer, for the private side: `init_shielded` (aggregate + exit book, records
the custody key), `delegate_shielded`, `delegate_exits`. `deposit`, `redeem` and
`sync_position` now read `Shielded` too, because the share price counts both
custodies and both kinds of share.

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

## Fully private deposits

The ledger above hides the *shape* of a position, but on its own it hides little:
the deposit that created it is a public SPL transfer into Agama, `Deposited`
logs `user, assets, shares, nav` in clear, and the agYLD balance is public. Entry
price, value and yield are all recomputable from that. A private deposit closes
all three.

```
 Solana                          TEE (MagicBlock private rollup)               Solana
 ──────                          ───────────────────────────────               ──────
 wallet ── MagicBlock private transfer, destination sealed to the TEE ──┐
                                   queue: random delay, split in parts  │
 throwaway key <── delivered ───────────────────────────────────────────┘
   └─ shield (fees paid by the sponsor) ──> key's private eATA
                                   │  SPL transfer ──> Agama private custody
                                   │  deposit_private: reads that transfer,
                                   │    mints private shares in the Position
                                   │
                                   │  redeem_private: burns shares,
                                   │    opens an exit ticket (owner, amount)
                                   │  keeper: custody pays the ticket through
                                   │    MagicBlock's private queue, settle_exit  ──> USDC to the
                                   │    checks the payment in the same tx            wallet, from
                                   │                                                 MagicBlock
                                   └─ commit_shielded, every 10 min ───────────────> one aggregate
```

**What Solana sees, and does not**

| | Public deposit | Private deposit |
|---|---|---|
| An Agama instruction carrying the amount | yes | **no**: every public transaction on the way in is MagicBlock's Ephemeral SPL Token only |
| A public transaction naming both the wallet and the throwaway key | n/a | **no**: the wallet's send has the key sealed to the TEE validator; the key's shield is paid by a sponsor, so it never needs SOL from the wallet |
| `Deposited` / `Redeemed` event | yes | **none** |
| agYLD minted to the wallet | yes | **never** |
| Shares, entry price, value, yield | derivable | inside the TEE, owner (and admitted viewers) only |
| The redemption payout | from Agama's vault | from MagicBlock's queue, after the keeper's 20 s grace and a random delay |
| Agama's private side | n/a | one aggregate (`shares`, `total_in`, `total_out`) per batched commit |
| That the wallet has a private position | n/a | **yes**: `init_position` / `delegate_position` are Agama instructions |
| How much the wallet sent, and when | n/a | **yes**: a private send into MagicBlock, visible as such. The delivery to the key happens later (random 5 to 45 s by default) and in two parts |

So the gain is unlinkability, not invisibility. Anyone can see a wallet move N
USDC into MagicBlock, a service many apps share; nobody outside the enclave can
see that it went to Agama, what it bought or what it is worth. With few private
depositors per commit window, an observer can still match amounts between a
shield and the next aggregate, which is why the aggregate only moves in batches,
why the position setup and the shield are separate transactions, and why it is
worth stating.

**One wallet approval per deposit** (two the first time: opening the ledger, then
the private send, kept apart so "this wallet opened an Agama position" and "this
amount" are never in the same transaction). MagicBlock charges 0.1% on the
private send, on top of the amount.

**The sponsor.** The throwaway key receives USDC from MagicBlock's queue and has
to shield it into its eATA, which costs fees and rent (about 0.008 SOL). Sending
it SOL from the wallet would put the two in one public transfer, the link the
sealed destination exists to avoid. So `/api/magicblock/sponsor` in the app signs
as fee payer, and only for exactly the four instructions `sponsoredShieldIxs`
builds for that key and amount: it rebuilds them and refuses any other
instruction, account, data, payer or signer set. The keeper keeps it funded.
`scripts/check-app-espl.ts` checks the app's hand-built MagicBlock instructions
against the SDK's. Everything inside the enclave is
signed by browser-held keys: the session key and the shield key.

**Trust model.** `deposit_private` is trustless: it credits nothing unless the
instruction right before it is an SPL transfer of exactly that amount, from the
depositor, into the custody, read through the instructions sysvar. `redeem_private`
names the position's owner as the only destination, so a stolen session key can
trigger a redemption but not redirect it. `settle_exit` never closes a ticket
unless the matching payment (amount, destination, group id, delays, split, out of
the custody) is in the same transaction. What is *not* program-enforced: the
private custody is owned by an operator key (`.keys/private-custody.json`), not a
PDA, so that key could move custody funds outside a ticket. That is forced by #7
below, it is the same trust a custodian holds in a real credit vault, and on
mainnet it belongs in an MPC or multisig. The live aggregate and the exit book are
gated to the vault authority, which therefore sees who redeems what.

**A lost or expired session key.** `authorize_session` runs on Solana, and a
delegated ledger cannot be written there, so without a way round it a cleared
browser, a new device or simply day eight would lock a depositor out of their
private shares. `rotate_session` is that way round, inside the enclave: the
wallet signs a plain-text message (wallets sign messages, just not rollup
transactions), the Ed25519 precompile verifies it in the instruction before, and
the program checks it was the owner over exactly
`Authorize session key <key> for position <pda> until <expiry>`. The expiry only
moves forward, so an old signed message is worthless. The permission is rewritten
with the new key in place of the old one and every admitted viewer kept. In the
app it is one message prompt, no transaction, triggered by any private action
or by *Use this browser for this ledger*. The Ed25519 precompile works on the
devnet TEE: a valid signature lands, a forged one fails with `Custom: 2`.

**Run it**

```bash
npx tsx scripts/setup-private.ts   # once: Shielded, ExitBook, permissions, custody eATA, exit queue
npx tsx scripts/e2e-private.ts     # the whole loop from a new wallet, plus the refusals
```

The e2e checks eight refusals along the way: a credit with no transfer, a credit
larger than the transfer, a transfer to the wrong account, one transfer credited
twice, a stranger committing the aggregate, a stranger's session redeeming, a
ticket closed with no payment, and a ticket closed after paying one unit short or
paying someone else. Then it loses the session key and recovers: a rotation
signed by a stranger, one with an expiry that does not move forward and the same
signed message replayed are all refused; the new key reads the ledger, the old
one no longer can and cannot redeem, and the new key redeems the rest.

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
| Pool book | `G164MeGadQebj5zMipbEAm5ssCqoRfjUdiwjpexTCqaU` | PDA `[lending-book-v2, vault]`. The four pools. Delegated. The legacy `[lending-book, vault]` at `y7QJ…XRUTY`… is orphaned, see #9 |
| agYLD mint | `5v2dRhbcEBWH5YUapkeQV9d3C84Ek4P8hH7tfWPxWCPA` | PDA `[agyld-mint]`, 6 decimals |
| Test USDC mint | `DuiuxGrD1iQJnuZKw1muqDgYRaV2QGvcqymM8ay4gy4Q` | PDA `[usdc-mint]`, 6 decimals |
| USDC custody | `ehxmrwjm5WoCMoh3KEe8WwXY35mj5oFbGRcJYF1qiyN` | The vault's ATA, where the collateral sits |
| Shielded | `3FPYkJoCZBrb4vdC2hbjA7gMyXJTsJJFWXhv3y5gbEzu` | PDA `[shielded-v2, vault]`. The private aggregate. Delegated to the TEE, gated |
| Exit book | `3RCWrvpjTsAjEbNzupAJmchWJ3Ma4Czn9DJqHCemqFhJ` | PDA `[exits, vault]`. Open private redemptions. Delegated to the TEE, gated, never committed |
| Private custody | owner `4YMK9bLrj6mjZDwgcVsL1wSEyDbNBD2bBEweTwiVvBGQ`, eATA `Hf68zAmtRDRK3hcqqfYFEfpBh3WGzqQ92hALSNWwCDs6` | Operator key's private eATA on the TEE |
| Exit queue | `9zGHeRsgu1UHw9iWYDwfutKbFGp3FLPzmTEcHbiS9fXw` | MagicBlock transfer queue for (test USDC, TEE validator) |

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
is the only test that catches the problems below in the order a user hits them.
Its last step is the claim, stated as a measurement rather than an adjective:

```
[5] who can read the ledger
       owner (on the permission) 126 bytes
       stranger (valid login)    nothing
       anonymous (no login)      nothing
```

## Nine things that cost an afternoon each

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

**5b. A wallet will not sign a rollup transaction at all.** Not "warns about", not
"asks twice". Phantom inspects the transaction, cannot place its blockhash on any
cluster it knows, decides it is for mainnet, and renders a Network mismatch panel
whose only button is Close. There is nothing to approve.

So the owner authorises a browser-held session key once, on the base layer, in the
same transaction as their deposit, and that key signs everything that happens on
the rollup: the enclave login, the permission, the position marks. That takes a
private deposit from three wallet prompts, one of which was impossible to satisfy,
to a single approval. Later deposits are one approval with no rollup leg at all.

The key can read and re-mark a position. It cannot move a token: custody, minting
and redemption all live on Solana, where only the wallet signs. It is stored in
localStorage, expires in seven days, and losing it costs a click.

Note that it also has to be a member of the `EphemeralPermission`, because it reads
with its own login token, and a token minted for a non-member sees nothing.

**7. The TEE refuses any transaction that hands a private eATA to your program.**
A private eATA (an Ephemeral SPL Token balance with a permission) can appear in a
TEE transaction only inside an SPL Token or MagicBlock instruction at the top
level. Pass it to your own program, readable or writable, signer or not, under
any login token, and the query filter answers `403 {"error":"Access denied"}`
before anything executes. Accounts gated by an ER-local `EphemeralPermission`
(the `Position`, `Shielded`) behave differently: the gate stops *reads*, and
non-members can still write them through the program. Found by elimination
(`sync` + the eATA added as a spare account fails; an SPL transfer of the same
eATA in the same transaction passes).

That is why `deposit_private` reads the transfer next to it instead of making it,
and why the custody cannot be a PDA: a PDA can only sign through a CPI, and the
CPI would need the eATA passed to the program. Worth asking MagicBlock whether a
program can be allowlisted on an eATA's permission.

**8. A 1 kB Borsh account overflows the BPF stack.** `ExitBook` (16 tickets)
loaded as a plain `Account` dies with `Access violation in stack frame 5`. `Box`
it, or take it as `UncheckedAccount` where only its address matters.

**9. A rollup can lose a delegation the delegation program still records.** On 29
October the EU rollup started answering every tick, commit and undelegate on the
book with `ScheduleCommit ERR: account ... is required to be delegated to the
current validator` and `was illegally used as writable`, while the router and the
delegation record on Solana both said the book was delegated to that very
validator. No client transaction can undo it: only the validator can undelegate.
`migrate_book` copies the legacy book's last committed state into a new PDA
(`lending-book-v2`), which is then delegated afresh; accrual is a function of
elapsed time, so the first tick catches up the frozen yield exactly. It went
unnoticed for a while because the keeper's ticks were confirmed over a websocket
the proxy does not relay (#5), so failures and successes looked alike. Ticks are
now sent without waiting, the keeper warns when the book stops moving, and a
recycled delegation is only accepted once a tick lands on it.

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

## Tests

```bash
cargo test -p agama-magicblock --lib   # the checks the private path rests on
npx tsx scripts/e2e.ts                 # public path, from a new keypair
npx tsx scripts/e2e-private.ts         # private path, with every refusal
npx tsx scripts/check-app-espl.ts      # the app's MagicBlock instructions vs the SDK
```

The unit tests cover what a forged or mismatched neighbour instruction looks like
to `deposit_private` and `rotate_session` (wrong amount, destination, source,
authority, unsigned, wrong program, an approve instead of a transfer; another
signer, another message, offsets into another instruction), pricing across both
custodies, the book bound, and the entry-price average.

## Scripts

| | |
|---|---|
| `run.sh` | build, deploy, initialise, delegate, then keep ticking |
| `deploy.sh` | deploy, initialise, fund the accounts the rollup clones, delegate |
| `setup.ts` | vault, mints, the four pools, delegation |
| `topup.ts` | fund the keeper's ephemeral escrow |
| `migrate-book.ts` | move the book to its current PDA when a rollup has lost track of the old one's delegation (#9) |
| `keeper.ts` | tick, absorb (both custodies), commit; and the private side via `private-keeper.ts`: batched `commit_shielded`, paying exit tickets |
| `recycle.ts` | undelegate and re-delegate the book once its 10 sponsored commits are spent; the keeper calls it itself |
| `state.ts` | read both layers and print the drift |
| `smoke.ts` | faucet, deposit, read the book back off the rollup |
| `privacy.ts` | the position ledger walk, with the three-reader check |
| `e2e.ts` | the same from a brand-new keypair |
| `setup-private.ts` | the private side: `Shielded`, `ExitBook`, their gates, the custody eATA, the exit queue |
| `e2e-private.ts` | a fully private deposit and redemption from a brand-new wallet, with the refusals |
| `private.ts` | instruction builders for the private path, shared by the scripts |
| `probe-qfs.ts` | which methods a private endpoint gates, and what it says |

Set `MB_ENV=local` on any of them to point the whole suite at `mb-stack`
(base 8899, rollup 7799, query-filtering 6699). The local query-filtering service
gates writes with the same token flow as devnet's TEE, so the permission logic is
exercised identically; what it cannot give you is the hardware attestation.

## Not done yet

- **Cranks.** `tick` is written to be a crank target and the keeper is a stand-in
  for one. Moving it to `MagicBlockInstruction::ScheduleTask` removes the last
  piece of infrastructure Agama operates itself.
- **What the private path still leaks.** Participation (the ledger is opened by an
  Agama instruction) and the amount and time of the wallet's private send into
  MagicBlock. Opening ledgers through a relayer would hide participation; varying
  the split and splitting one deposit across several sends would blur amounts.
- **Custody key.** The private custody is an operator key (see #7). MPC or multisig
  on mainnet, or a program-owned custody if MagicBlock lets a program onto an
  eATA's permission.

- **Attestation.** Nothing here verifies the enclave's quote. `verifyTeeRpcIntegrity`
  exists in the SDK and should run before a client trusts a TEE endpoint in
  production; skipping it means trusting DNS.
- **Magic Actions.** Nothing here needs a base-layer swap yet. It would, the moment
  the pools stop being marks and start holding real assets.
- **Closing the gate.** `close_permission` is implemented and reachable from the
  client, but no UI step calls it. A position that leaves the rollup with its
  permission still open strands the rent.
