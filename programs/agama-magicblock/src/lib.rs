// Agama on MagicBlock.
//
// The same protocol Agama runs on Starknet, Sui and Stellar (deposit USDC, mint
// agYLD, watch its price rise as four private-credit lending pools accrue), but
// split across MagicBlock's execution model instead of a single settlement layer.
//
// The split is the whole point, and it follows one rule: **public token, private
// machinery.**
//
//   Solana base layer   agYLD SPL mint, USDC custody, deposit / redeem.
//                       agYLD stays a plain SPL token so it remains composable
//                       with every Solana venue. Nothing about it is delegated.
//
//   Ephemeral Rollup    The PoolBook: four lending pools, their principals, their
//                       APRs, the marked NAV. Yield accrues per *tick* instead of
//                       per block, so the NAV moves at 10 ms instead of 400 ms,
//                       and ticking is free. Committed back to base periodically:
//                       that committed NAV is what base-layer deposits price on.
//
//   Private ER (TEE)    Per-depositor Position accounts, gated by an ER-local
//                       EphemeralPermission: entry price, marked value and
//                       accrued yield, readable only by the owner and whoever
//                       they admit (an auditor, a fund administrator).
//
//                       And a fully private way in and out. USDC is shielded
//                       through MagicBlock's Ephemeral SPL Token program by a
//                       throwaway key, so Solana sees a deposit into MagicBlock,
//                       not into Agama. Inside the enclave it moves into Agama's
//                       private custody and is credited as *private shares* on
//                       the Position: no agYLD is minted, no event is emitted.
//                       Redemptions leave through MagicBlock's private transfer
//                       queue straight to the owner's wallet. Solana only ever
//                       sees the aggregate (`Shielded`), committed in batches.
//
//                       One constraint shapes all of it: the TEE's query filter
//                       refuses any transaction that hands a private eATA to a
//                       program other than SPL Token or MagicBlock's own. So
//                       this program never touches a token account in there.
//                       It checks, by instruction introspection, that the
//                       transfer it is about to credit really sits next to it in
//                       the same transaction.
//
// This is hardware-verified confidentiality (Intel TDX), not zero-knowledge. The
// trust assumption is the enclave, and it is stated as such.
use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as system_transfer, Transfer as SystemTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_lang::solana_program::instruction::Instruction;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{
    burn, mint_to, transfer_checked, Burn, Mint, MintTo, Token, TokenAccount, TransferChecked,
};

use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

use ephemeral_rollups_sdk::access_control::instructions::{
    CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
};
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, EphemeralPermission, Member, ACCOUNT_SIGNATURES_FLAG, AUTHORITY_FLAG,
    PERMISSION_SEED, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

declare_id!("GVHsSaFUkVAZJdRKWtK1SxYUhW2P7a7z1xBL5SaFj5vC");

pub const VAULT_SEED: &[u8] = b"agama-vault";
/// v2 since 29 October 2026, when the EU validator stopped treating the v1 book
/// as delegated to it while the delegation program still said it was. Nothing
/// on the client side can undo that, so the book moved. See `migrate_book`.
pub const BOOK_SEED: &[u8] = b"lending-book-v2";
pub const LEGACY_BOOK_SEED: &[u8] = b"lending-book";
/// v3: positions now carry private shares. v2 ledgers are left where they are.
pub const POSITION_SEED: &[u8] = b"position-v3";
/// v2: the custody is owned by an operator key, recorded here. See `Shielded`.
pub const SHIELDED_V2_SEED: &[u8] = b"shielded-v2";
/// Pending private redemptions, waiting for the custody to pay them.
pub const EXITS_SEED: &[u8] = b"exits";
pub const EXIT_SLOTS: usize = 16;
pub const USDC_SEED: &[u8] = b"usdc-mint";
pub const AGYLD_SEED: &[u8] = b"agyld-mint";
pub const CLAIM_SEED: &[u8] = b"faucet-claim";

/// MagicBlock's Ephemeral SPL Token program (MIMD 0013): eATAs, the per-mint
/// Global Vault, and the private transfer queue redemptions leave through.
pub const EPHEMERAL_SPL_TOKEN_PROGRAM_ID: Pubkey =
    pubkey!("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");
/// `DepositAndQueueTransfer` in that program.
const ESPL_DEPOSIT_AND_QUEUE_TRANSFER: u8 = 16;
/// Solana's Ed25519 signature-verification precompile.
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
/// SPL Token `Transfer` and `TransferChecked`.
const SPL_TRANSFER: u8 = 3;
const SPL_TRANSFER_CHECKED: u8 = 12;
/// Upper bound on the random delay a private redemption may ask for.
pub const MAX_EXIT_DELAY_MS: u64 = 24 * 3600 * 1000;

pub const POOL_COUNT: usize = 4;
pub const DECIMALS: u8 = 6;
pub const ONE: u64 = 1_000_000;
pub const BPS: u128 = 10_000;
pub const SECONDS_PER_YEAR: u128 = 31_536_000;

/// Faucet drip and cooldown (devnet only).
pub const FAUCET_AMOUNT: u64 = 1_000 * ONE;
pub const FAUCET_COOLDOWN: i64 = 60;

/// How long a browser session key stays valid. Long enough not to nag, short
/// enough that a stolen one expires on its own.
pub const SESSION_TTL: i64 = 7 * 24 * 3600;

/// Lamports every account must hold before a rollup will clone it.
///
/// The rollup re-creates each account it touches inside its own state and bills
/// the rent to that account, not to the transaction payer. Solana's rent-exempt
/// minimum is not enough: a fresh SPL token account carries ~0.0019 SOL and gets
/// rejected. This figure is empirical, measured against devnet, and it is the
/// single most expensive thing about putting a per-user account on a rollup.
pub const ROLLUP_CLONE_FLOOR: u64 = 30_000_000; // 0.03 SOL

/// Owner plus this many admitted viewers. Sized up front because the Position PDA
/// pre-funds its own permission rent before it ever leaves the base layer.
pub const MAX_PERMISSION_MEMBERS: usize = 4;

/// Everything an admitted viewer is allowed to observe about a private position.
const VIEWER_FLAGS: u8 = TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG;
/// The owner additionally controls the permission itself.
const OWNER_FLAGS: u8 = AUTHORITY_FLAG | VIEWER_FLAGS | ACCOUNT_SIGNATURES_FLAG;

#[ephemeral]
#[program]
pub mod agama_magicblock {
    use super::*;

    // ---------------------------------------------------------------- base layer

    /// Stand up the vault: agYLD mint, a devnet USDC mint, and the custody ATA.
    /// Both mints are program-owned PDAs so the whole stack is reproducible from
    /// the program id alone.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.payer.key();
        vault.usdc_mint = ctx.accounts.usdc_mint.key();
        vault.agyld_mint = ctx.accounts.agyld_mint.key();
        vault.shares = 0;
        vault.total_in = 0;
        vault.total_out = 0;
        vault.bump = ctx.bumps.vault;
        Ok(())
    }

    /// Register the four lending pools. Weights are relative; a deposit is spread
    /// across the pools by weight on the next ER tick.
    pub fn init_book(ctx: Context<InitBook>, pools: [PoolInit; POOL_COUNT]) -> Result<()> {
        let book = &mut ctx.accounts.book;
        book.vault = ctx.accounts.vault.key();
        book.authority = ctx.accounts.authority.key();
        book.bump = ctx.bumps.book;
        book.last_ts = Clock::get()?.unix_timestamp;
        book.ticks = 0;
        book.marked_in = 0;
        book.marked_out = 0;
        book.nav = 0;
        for (i, p) in pools.iter().enumerate() {
            book.pools[i] = PoolEntry {
                name: p.name,
                sector: p.sector,
                apr_bps: p.apr_bps,
                weight_bps: p.weight_bps,
                principal: 0,
                accrued: 0,
            };
        }
        Ok(())
    }

    /// Devnet faucet: 1000 USDC, once a minute per wallet.
    pub fn faucet(ctx: Context<Faucet>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let claim = &mut ctx.accounts.claim;
        require!(
            claim.last_ts == 0 || now - claim.last_ts >= FAUCET_COOLDOWN,
            AgamaError::FaucetCooldown
        );
        claim.owner = ctx.accounts.user.key();
        claim.last_ts = now;

        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[VAULT_SEED, &bump];
        mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            FAUCET_AMOUNT,
        )?;
        Ok(())
    }

    /// Deposit USDC, receive agYLD at the current share price.
    ///
    /// Price comes from `nav_for_pricing`: the NAV the ER last committed, plus any
    /// dollars that have landed in custody since and are not yet marked into a
    /// pool. Those unmarked dollars are worth exactly par, so the price is right
    /// even between commits.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, AgamaError::ZeroAmount);
        let book = read_book(&ctx.accounts.book)?;
        let shielded = read_shielded(&ctx.accounts.shielded)?;
        let (nav, supply) = nav_for_pricing(&ctx.accounts.vault, &book, &shielded)?;

        let shares = if supply == 0 || nav == 0 {
            amount
        } else {
            u64::try_from(amount as u128 * supply as u128 / nav as u128)
                .map_err(|_| AgamaError::MathOverflow)?
        };
        require!(shares > 0, AgamaError::DustDeposit);

        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.vault_usdc.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            DECIMALS,
        )?;

        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[VAULT_SEED, &bump];
        mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.agyld_mint.to_account_info(),
                    to: ctx.accounts.user_agyld.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            shares,
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.shares = vault.shares.saturating_add(shares);
        vault.total_in = vault.total_in.saturating_add(amount);

        emit!(Deposited {
            user: ctx.accounts.user.key(),
            assets: amount,
            shares,
            nav,
        });
        Ok(())
    }

    /// Burn agYLD, take USDC back out at the current share price.
    pub fn redeem(ctx: Context<Redeem>, shares: u64) -> Result<()> {
        require!(shares > 0, AgamaError::ZeroAmount);
        let book = read_book(&ctx.accounts.book)?;
        let shielded = read_shielded(&ctx.accounts.shielded)?;
        let (nav, supply) = nav_for_pricing(&ctx.accounts.vault, &book, &shielded)?;
        require!(ctx.accounts.vault.shares >= shares, AgamaError::InsufficientShares);

        let assets = u64::try_from(shares as u128 * nav as u128 / supply as u128)
            .map_err(|_| AgamaError::MathOverflow)?;
        require!(
            assets <= ctx.accounts.vault_usdc.amount,
            AgamaError::InsufficientLiquidity
        );

        burn(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.agyld_mint.to_account_info(),
                    from: ctx.accounts.user_agyld.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            shares,
        )?;

        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[VAULT_SEED, &bump];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            assets,
            DECIMALS,
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.shares = vault.shares.saturating_sub(shares);
        vault.total_out = vault.total_out.saturating_add(assets);

        emit!(Redeemed {
            user: ctx.accounts.user.key(),
            shares,
            assets,
            nav,
        });
        Ok(())
    }

    /// Open a Position account and pre-fund it for the permission rent it will pay
    /// on the ER. Runs on base, before delegation, because a delegated account
    /// cannot be funded from base any more.
    pub fn init_position(ctx: Context<InitPosition>) -> Result<()> {
        system_transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                SystemTransfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.position.to_account_info(),
                },
            ),
            // One slot of headroom. The permission is created with a single member
            // and grown later; funding the exact cap leaves zero margin, and a
            // resize that comes up one lamport short fails the whole update.
            ephemeral_rollups_sdk::ephemeral_accounts::rent(
                EphemeralPermission::size_of(MAX_PERMISSION_MEMBERS + 1) as u32,
            ),
        )?;

        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.owner.key();
        position.vault = ctx.accounts.vault.key();
        position.bump = ctx.bumps.position;
        position.shares = 0;
        position.private_shares = 0;
        position.entry_price = ONE;
        position.value_usdc = 0;
        position.cost_basis = 0;
        position.yield_usdc = 0;
        position.syncs = 0;
        position.synced_ts = 0;
        position.is_private = false;
        Ok(())
    }

    /// Open the current book as an exact copy of the legacy one, as Solana last
    /// saw it: pools, principals, accrued yield, marks, clock and tick count.
    ///
    /// For when a rollup loses track of a delegation it still holds on paper.
    /// The legacy book stays delegated and unwritable, but its last committed
    /// state is readable on Solana, and that is a complete book: accrual is a
    /// function of elapsed time since `last_ts`, so the first tick on the copy
    /// catches up exactly the yield the frozen book missed. `marked_in` and
    /// `marked_out` carry over, so pricing never sees a jump.
    pub fn migrate_book(ctx: Context<MigrateBook>) -> Result<()> {
        let old = read_book(&ctx.accounts.legacy_book)?;
        let book = &mut ctx.accounts.book;
        book.vault = ctx.accounts.vault.key();
        book.authority = ctx.accounts.authority.key();
        book.pools = old.pools;
        book.nav = old.nav;
        book.marked_in = old.marked_in;
        book.marked_out = old.marked_out;
        book.last_ts = old.last_ts;
        book.ticks = old.ticks;
        book.bump = ctx.bumps.book;
        Ok(())
    }

    /// Send the PoolBook to an Ephemeral Rollup. From here the pools accrue per
    /// tick instead of per block, and the base-layer copy only moves on commit.
    pub fn delegate_book(ctx: Context<DelegateBook>) -> Result<()> {
        ctx.accounts.delegate_book(
            &ctx.accounts.payer,
            &[BOOK_SEED, ctx.accounts.vault.key().as_ref()],
            DelegateConfig {
                validator: ctx.accounts.validator.as_ref().map(|v| v.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Authorise a browser-held key to act on this position inside the rollup.
    ///
    /// Base layer, so the wallet signs it, and it rides along in the same
    /// transaction as the deposit. That is what keeps a private deposit down to one
    /// approval instead of three.
    pub fn authorize_session(ctx: Context<AuthorizeSession>, session_key: Pubkey) -> Result<()> {
        require!(session_key != Pubkey::default(), AgamaError::Unauthorized);
        let now = Clock::get()?.unix_timestamp;
        let position = &mut ctx.accounts.position;
        position.session_key = session_key;
        position.session_expiry = now + SESSION_TTL;
        Ok(())
    }

    /// Top a position and its owner's agYLD account up to the rollup's clone floor.
    ///
    /// Both accounts get read inside the enclave when the position is synced, and
    /// the rollup refuses to clone either of them while they sit at Solana's
    /// rent-exempt minimum. Separate from `init_position` on purpose: only a
    /// depositor who actually wants a private ledger should pay for one.
    pub fn prepare_for_rollup(ctx: Context<PrepareForRollup>) -> Result<()> {
        let mut accounts = vec![ctx.accounts.position.to_account_info()];
        if let Some(agyld) = &ctx.accounts.owner_agyld {
            accounts.push(agyld.to_account_info());
        }
        for account in accounts {
            let have = account.lamports();
            if have >= ROLLUP_CLONE_FLOOR {
                continue;
            }
            system_transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    SystemTransfer {
                        from: ctx.accounts.owner.to_account_info(),
                        to: account,
                    },
                ),
                ROLLUP_CLONE_FLOOR - have,
            )?;
        }
        Ok(())
    }

    /// Send a Position to the TEE validator. Only the data PDA is delegated; its
    /// permission is created afterwards, on the ER.
    pub fn delegate_position(ctx: Context<DelegatePosition>) -> Result<()> {
        ctx.accounts.delegate_position(
            &ctx.accounts.owner,
            &[POSITION_SEED, ctx.accounts.owner.key().as_ref()],
            DelegateConfig {
                validator: ctx.accounts.validator.as_ref().map(|v| v.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Open the private side of the vault: the aggregate of every private
    /// position, which is all Solana ever learns about them.
    ///
    /// Pre-funded for its own permission rent and for the rollup's clone floor,
    /// for the same reason a Position is: once delegated, it cannot be topped up
    /// from the base layer.
    pub fn init_shielded(ctx: Context<InitShielded>, custody_owner: Pubkey) -> Result<()> {
        let floor = ROLLUP_CLONE_FLOOR.saturating_add(ephemeral_rollups_sdk::ephemeral_accounts::rent(
            EphemeralPermission::size_of(2) as u32,
        ));
        let have = ctx.accounts.shielded.to_account_info().lamports();
        if have < floor {
            system_transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    SystemTransfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: ctx.accounts.shielded.to_account_info(),
                    },
                ),
                floor - have,
            )?;
        }
        let have = ctx.accounts.exits.to_account_info().lamports();
        if have < floor {
            system_transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    SystemTransfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: ctx.accounts.exits.to_account_info(),
                    },
                ),
                floor - have,
            )?;
        }
        ctx.accounts.exits.vault = ctx.accounts.vault.key();

        let shielded = &mut ctx.accounts.shielded;
        shielded.vault = ctx.accounts.vault.key();
        shielded.custody_owner = custody_owner;
        shielded.shares = 0;
        shielded.total_in = 0;
        shielded.total_out = 0;
        shielded.bump = ctx.bumps.shielded;
        Ok(())
    }

    /// Hand the private aggregate to the TEE validator. Called again whenever
    /// the keeper recycles it, so it does not touch the exit book.
    pub fn delegate_shielded(ctx: Context<DelegateShielded>) -> Result<()> {
        let vault = ctx.accounts.vault.key();
        ctx.accounts.delegate_shielded(
            &ctx.accounts.payer,
            &[SHIELDED_V2_SEED, vault.as_ref()],
            DelegateConfig {
                validator: ctx.accounts.validator.as_ref().map(|v| v.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Hand the exit book to the TEE validator. Once: it is never committed.
    pub fn delegate_exits(ctx: Context<DelegateExits>) -> Result<()> {
        let vault = ctx.accounts.vault.key();
        ctx.accounts.delegate_exits(
            &ctx.accounts.payer,
            &[EXITS_SEED, vault.as_ref()],
            DelegateConfig {
                validator: ctx.accounts.validator.as_ref().map(|v| v.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    // ------------------------------------------------------- ephemeral rollup

    /// One tick of the lending book: accrue every pool to *now* and re-mark the
    /// NAV. Touches nothing but the book, which is what makes it cheap enough to
    /// run every second and safe enough to hand to a crank.
    ///
    /// Idempotent by construction: accrual is a function of elapsed time since
    /// `last_ts`, so a replayed tick advances nothing and a missed one is caught
    /// up by the next.
    pub fn tick(ctx: Context<Tick>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let book = &mut ctx.accounts.book;
        book.accrue(now);
        book.nav = book.marked_value();
        book.last_ts = now;
        book.ticks = book.ticks.saturating_add(1);
        Ok(())
    }

    /// Deploy capital that landed on Solana into the lending pools, or pull it back
    /// out. Owner-only, exactly as on the Starknet deployment: allocation is a
    /// treasury decision, not something a depositor triggers.
    ///
    /// The keeper reads `vault.total_in` / `total_out` on the base layer and passes
    /// the unprocessed delta here. That read deliberately happens off-chain rather
    /// than by handing the rollup a base-layer account: a read-only clone of an
    /// account that keeps changing on Solana forces the rollup to re-clone it on
    /// every deposit, and a failed re-clone takes the whole tick down with it.
    ///
    /// `marked_in` / `marked_out` mirror how much of the vault's cumulative flow
    /// the book has absorbed, which is what lets base-layer pricing stay exact
    /// between commits. They only ever move forward.
    pub fn absorb(ctx: Context<Absorb>, inflow: u64, outflow: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let book = &mut ctx.accounts.book;
        book.accrue(now);
        book.last_ts = now;

        if inflow > 0 {
            book.fund(inflow);
            book.marked_in = book.marked_in.saturating_add(inflow);
        }
        if outflow > 0 {
            book.defund(outflow);
            book.marked_out = book.marked_out.saturating_add(outflow);
        }
        book.nav = book.marked_value();
        emit!(Absorbed {
            inflow,
            outflow,
            nav: book.nav,
        });
        Ok(())
    }

    /// Move a pool's rate. Locks in yield at the old rate first.
    pub fn set_apr(ctx: Context<SetApr>, index: u8, apr_bps: u32) -> Result<()> {
        require!((index as usize) < POOL_COUNT, AgamaError::BadPool);
        let now = Clock::get()?.unix_timestamp;
        let book = &mut ctx.accounts.book;
        book.accrue(now);
        book.last_ts = now;
        book.pools[index as usize].apr_bps = apr_bps;
        book.nav = book.marked_value();
        Ok(())
    }

    /// Push the ticked NAV back to Solana. Until this lands, base-layer deposits
    /// price on the previous commit.
    pub fn commit_book(ctx: Context<CommitBook>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.book.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Commit and hand the book back to the base layer.
    pub fn undelegate_book(ctx: Context<CommitBook>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.book.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    // --------------------------------------------- private ephemeral rollup

    /// Create the position's ER-local permission. `viewers` are the pubkeys
    /// admitted alongside the owner: an auditor, a fund administrator. Passing an
    /// empty list still marks the account private: owner-only.
    ///
    /// Idempotent, because ER transactions get retried.
    pub fn init_permission(ctx: Context<PermissionCtx>, viewers: Vec<Pubkey>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        assert_may_act(&ctx.accounts.position, ctx.accounts.signer.key, now)?;
        require!(
            viewers.len() + 1 <= MAX_PERMISSION_MEMBERS,
            AgamaError::TooManyMembers
        );
        // Retried ER transactions are normal, so creating twice must be harmless.
        // The flag is set on both paths: if the CPI landed but this account's write
        // did not, the position would otherwise be gated on chain and claim not to
        // be.
        if ctx.accounts.permission.owner == &PERMISSION_PROGRAM_ID
            && !ctx.accounts.permission.data_is_empty()
        {
            ctx.accounts.position.is_private = true;
            return Ok(());
        }
        let owner = ctx.accounts.position.owner;
        let bump = [ctx.accounts.position.bump];
        let signer_seeds: &[&[u8]] = &[POSITION_SEED, owner.as_ref(), &bump];

        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.position.to_account_info(),
            permissioned_account: ctx.accounts.position.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: members_args(true, &owner, ctx.accounts.position.session_key, &viewers),
        }
        .invoke_signed(&[signer_seeds])?;

        ctx.accounts.position.is_private = true;
        Ok(())
    }

    /// Replace the viewer set. The list is absolute: anyone left out loses access.
    pub fn set_permission(
        ctx: Context<PermissionCtx>,
        is_private: bool,
        viewers: Vec<Pubkey>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        assert_may_act(&ctx.accounts.position, ctx.accounts.signer.key, now)?;
        require!(
            viewers.len() + 2 <= MAX_PERMISSION_MEMBERS,
            AgamaError::TooManyMembers
        );
        let owner = ctx.accounts.position.owner;
        let bump = [ctx.accounts.position.bump];
        let signer_seeds: &[&[u8]] = &[POSITION_SEED, owner.as_ref(), &bump];

        UpdateEphemeralPermissionCpi {
            payer: ctx.accounts.position.to_account_info(),
            permissioned_account: ctx.accounts.position.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.position.to_account_info(),
            authority_is_signer: false,
            args: members_args(is_private, &owner, ctx.accounts.position.session_key, &viewers),
        }
        .invoke_signed(&[signer_seeds])?;

        ctx.accounts.position.is_private = is_private;
        Ok(())
    }

    /// Drop the permission and refund its rent to the position.
    pub fn close_permission(ctx: Context<PermissionCtx>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        assert_may_act(&ctx.accounts.position, ctx.accounts.signer.key, now)?;
        let owner = ctx.accounts.position.owner;
        let bump = [ctx.accounts.position.bump];
        let signer_seeds: &[&[u8]] = &[POSITION_SEED, owner.as_ref(), &bump];

        CloseEphemeralPermissionCpi {
            payer: ctx.accounts.position.to_account_info(),
            permissioned_account: ctx.accounts.position.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.position.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[signer_seeds])?;

        ctx.accounts.position.is_private = false;
        Ok(())
    }

    /// Recompute the private position inside the enclave.
    ///
    /// Every input is read on-chain (the owner's agYLD balance, the ticked NAV,
    /// the share supply), so nothing here is user-attested. The entry price is
    /// carried as a share-weighted average, which is what makes accrued yield
    /// derivable without ever storing a public deposit trail.
    pub fn sync_position(ctx: Context<SyncPosition>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        assert_may_act(&ctx.accounts.position, ctx.accounts.signer.key, now)?;
        // The book lives on the public rollup, this instruction runs on the TEE
        // one, so here it is a base-layer clone owned by the delegation program.
        // Positions therefore mark against the last committed NAV, which is the
        // right granularity for a position ledger.
        let book = read_book(&ctx.accounts.book)?;
        let (nav, supply) = nav_for_pricing(&ctx.accounts.vault, &book, &ctx.accounts.shielded)?;
        let price = share_price(nav, supply)?;

        let position = &mut ctx.accounts.position;
        // A fully private depositor has no agYLD account at all.
        let held = ctx.accounts.owner_agyld.as_ref().map(|a| a.amount).unwrap_or(0);

        // Averaging in only makes sense when public shares actually arrived.
        // Guarding the zero case also keeps a replayed sync from re-blending an
        // entry price. Private shares are blended at the moment they are minted,
        // in `deposit_private`, so only the public leg is caught up here.
        if held > position.shares {
            let added = held - position.shares;
            blend_entry(position, added, price)?;
        }
        // Averaging out leaves the entry price alone: the exit realises P&L, it
        // does not re-mark what is left behind.
        position.shares = held;
        mark(position, price, now)
    }

    /// Trust a new session key, from inside the enclave, on the wallet's word.
    ///
    /// `authorize_session` runs on Solana, and a delegated position cannot be
    /// written there. So once a ledger is in the enclave, a lost or expired
    /// session key would be unrecoverable: no way to redeem private shares from a
    /// new device, or from this one after seven days. The wallet cannot sign a
    /// rollup transaction either, but it can sign a message. So the instruction
    /// before this one must be the Ed25519 precompile verifying the owner's
    /// signature over exactly `session_message(position, session_key, expiry)`.
    ///
    /// `expiry` only moves forward, which makes an old signed message worthless:
    /// replaying it would set an earlier expiry than the current one. The
    /// permission is rewritten with the new key in place of the old one, and every
    /// admitted viewer kept.
    pub fn rotate_session(ctx: Context<RotateSession>, session_key: Pubkey, expiry: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let position_key = ctx.accounts.position.key();
        let owner = ctx.accounts.position.owner;
        let old_session = ctx.accounts.position.session_key;
        require!(session_key != Pubkey::default(), AgamaError::BadSessionRotation);
        require!(
            expiry > now
                && expiry <= now + SESSION_TTL + 3600
                && expiry > ctx.accounts.position.session_expiry,
            AgamaError::BadSessionRotation
        );

        let prev = previous_instruction(&ctx.accounts.instructions)?;
        let message = session_message(&position_key, &session_key, expiry);
        assert_ed25519(&prev, &owner, message.as_bytes())?;

        let position = &mut ctx.accounts.position;
        position.session_key = session_key;
        position.session_expiry = expiry;

        if position.is_private {
            let viewers: Vec<Pubkey> = {
                let data = ctx.accounts.permission.try_borrow_data()?;
                let permission = EphemeralPermission::from_bytes(&data)
                    .map_err(|_| error!(AgamaError::BadSessionRotation))?;
                permission
                    .members
                    .iter()
                    .map(|m| m.pubkey)
                    .filter(|k| *k != owner && *k != old_session)
                    .collect()
            };
            let bump = [position.bump];
            let signer_seeds: &[&[u8]] = &[POSITION_SEED, owner.as_ref(), &bump];
            UpdateEphemeralPermissionCpi {
                payer: ctx.accounts.position.to_account_info(),
                permissioned_account: ctx.accounts.position.to_account_info(),
                permission: ctx.accounts.permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                authority: ctx.accounts.position.to_account_info(),
                authority_is_signer: false,
                args: members_args(true, &owner, session_key, &viewers),
            }
            .invoke_signed(&[signer_seeds])?;
        }
        Ok(())
    }

    // ------------------------------------------------- private deposits (TEE)

    /// Gate the private aggregate and the exit book so only the vault authority
    /// can read them live.
    ///
    /// Ungated, anyone logged in to the enclave could watch `total_in` move and
    /// read every private deposit off the difference, or read the exit book and
    /// learn who is redeeming how much. Gated, the aggregate reaches the public
    /// only through `commit_shielded`, which batches whatever arrived since the
    /// last commit into one number, and the exit book never reaches it at all.
    ///
    /// Gating stops reads, not writes: depositors still update both accounts
    /// through this program without being members.
    pub fn init_shielded_permission(ctx: Context<ShieldedPermission>) -> Result<()> {
        let vault = ctx.accounts.vault.key();
        let members = || EphemeralMembersArgs {
            is_private: true,
            members: vec![Member {
                flags: OWNER_FLAGS,
                pubkey: ctx.accounts.authority.key(),
            }],
        };
        let created = |p: &UncheckedAccount| p.owner == &PERMISSION_PROGRAM_ID && !p.data_is_empty();

        if !created(&ctx.accounts.permission) {
            let bump = [ctx.accounts.shielded.bump];
            let seeds: &[&[u8]] = &[SHIELDED_V2_SEED, vault.as_ref(), &bump];
            CreateEphemeralPermissionCpi {
                payer: ctx.accounts.shielded.to_account_info(),
                permissioned_account: ctx.accounts.shielded.to_account_info(),
                permission: ctx.accounts.permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                args: members(),
            }
            .invoke_signed(&[seeds])?;
        }
        if !created(&ctx.accounts.exits_permission) {
            let bump = [ctx.bumps.exits];
            let seeds: &[&[u8]] = &[EXITS_SEED, vault.as_ref(), &bump];
            CreateEphemeralPermissionCpi {
                payer: ctx.accounts.exits.to_account_info(),
                permissioned_account: ctx.accounts.exits.to_account_info(),
                permission: ctx.accounts.exits_permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                args: members(),
            }
            .invoke_signed(&[seeds])?;
        }
        Ok(())
    }

    /// Credit private shares for shielded USDC. Runs inside the enclave.
    ///
    /// Before this, `depositor` (a throwaway key the browser made for this one
    /// deposit) shielded the USDC through MagicBlock's Ephemeral SPL Token
    /// program, so the base layer saw a deposit into MagicBlock's Global Vault
    /// and nothing that mentions Agama.
    ///
    /// The instruction right before this one, in the same transaction, must be
    /// an SPL Token transfer of exactly `amount`, from the depositor's account to
    /// the private custody, signed by the depositor. This program cannot make that
    /// transfer itself (the enclave refuses to hand it a private eATA), so it
    /// reads it instead, and credits nothing unless it is there. Two deposits
    /// cannot share one transfer: each looks only at its own predecessor.
    ///
    /// No agYLD is minted and no event is emitted. The only trace this leaves
    /// outside the enclave is a larger `shielded.total_in` at the next batched
    /// commit. Priced exactly like a public deposit, against both custodies and
    /// the full share supply, so the two kinds of share are always worth the same.
    pub fn deposit_private(ctx: Context<DepositPrivate>, amount: u64) -> Result<()> {
        require!(amount > 0, AgamaError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        assert_may_act(&ctx.accounts.position, ctx.accounts.signer.key, now)?;

        let usdc = ctx.accounts.vault.usdc_mint;
        let prev = previous_instruction(&ctx.accounts.instructions)?;
        assert_token_transfer(
            &prev,
            amount,
            &get_associated_token_address(ctx.accounts.depositor.key, &usdc),
            &get_associated_token_address(&ctx.accounts.shielded.custody_owner, &usdc),
            ctx.accounts.depositor.key,
        )?;

        let book = read_book(&ctx.accounts.book)?;
        let (nav, supply) = nav_for_pricing(&ctx.accounts.vault, &book, &ctx.accounts.shielded)?;
        let shares = if supply == 0 || nav == 0 {
            amount
        } else {
            u64::try_from(amount as u128 * supply as u128 / nav as u128)
                .map_err(|_| AgamaError::MathOverflow)?
        };
        require!(shares > 0, AgamaError::DustDeposit);
        let price = share_price(nav, supply)?;

        let position = &mut ctx.accounts.position;
        blend_entry(position, shares, price)?;
        position.private_shares = position.private_shares.saturating_add(shares);
        mark(position, price, now)?;

        let shielded = &mut ctx.accounts.shielded;
        shielded.shares = shielded.shares.saturating_add(shares);
        shielded.total_in = shielded.total_in.saturating_add(amount);
        Ok(())
    }

    /// Burn private shares and open an exit ticket for the USDC. Runs inside the
    /// enclave.
    ///
    /// The ticket names the position's owner as the only destination, so the
    /// session key that signs this can trigger a redemption but cannot redirect
    /// it. The custody pays the ticket through MagicBlock's private transfer
    /// queue (`settle_exit`), after a random delay in `[min_delay_ms,
    /// max_delay_ms]`, optionally in `split` parts. Solana sees the wallet receive
    /// USDC from MagicBlock's queue vault, not from Agama.
    ///
    /// `group_id` is the queue's group id for the payout, chosen by the client
    /// at random. It doubles as the ticket's id, and `settle_exit` holds the
    /// payout to it, so one ticket can be paid once.
    pub fn redeem_private(
        ctx: Context<RedeemPrivate>,
        shares: u64,
        group_id: u32,
        min_delay_ms: u64,
        max_delay_ms: u64,
        split: u32,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        assert_may_act(&ctx.accounts.position, ctx.accounts.signer.key, now)?;
        let owner = ctx.accounts.position.owner;
        open_exit(ctx.accounts, shares, group_id, min_delay_ms, max_delay_ms, split, owner, now)
    }

    /// The same, paid to any wallet, for a position whose owner is a stealth key.
    ///
    /// A private position can be owned by a key derived from a wallet signature
    /// instead of by the wallet, so that opening it on Solana never names the
    /// wallet. That key then has to be able to send the money home, to a wallet
    /// Solana has never seen next to it, so it chooses the destination. Only the
    /// owner may, never a session key: a stolen session key still cannot redirect
    /// anything.
    pub fn redeem_private_to(
        ctx: Context<RedeemPrivate>,
        shares: u64,
        group_id: u32,
        min_delay_ms: u64,
        max_delay_ms: u64,
        split: u32,
        payout: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(ctx.accounts.signer.key(), ctx.accounts.position.owner, AgamaError::Unauthorized);
        require!(payout != Pubkey::default(), AgamaError::BadExitParams);
        let now = Clock::get()?.unix_timestamp;
        open_exit(ctx.accounts, shares, group_id, min_delay_ms, max_delay_ms, split, payout, now)
    }

    /// Close an exit ticket, once the custody has paid it in this same
    /// transaction. The instruction before this one must be MagicBlock's
    /// `DepositAndQueueTransfer` out of the custody, for exactly the ticket's
    /// amount, to exactly its owner, with its group id, delays and split.
    ///
    /// The custody key is an operator key, so it could move funds without a
    /// ticket. What this guarantees is the other direction: no ticket is ever
    /// marked paid unless the payment is actually in the transaction.
    pub fn settle_exit(ctx: Context<SettleExit>, group_id: u32) -> Result<()> {
        let usdc = ctx.accounts.vault.usdc_mint;
        let custody_owner = ctx.accounts.shielded.custody_owner;
        let prev = previous_instruction(&ctx.accounts.instructions)?;
        let exits = &mut ctx.accounts.exits;
        let slot = exits
            .slots
            .iter_mut()
            .find(|e| e.group_id == group_id && group_id != 0)
            .ok_or(AgamaError::UnknownExit)?;

        require_keys_eq!(prev.program_id, EPHEMERAL_SPL_TOKEN_PROGRAM_ID, AgamaError::PaymentMismatch);
        let d = &prev.data;
        require!(d.len() >= 32 && d[0] == ESPL_DEPOSIT_AND_QUEUE_TRANSFER, AgamaError::PaymentMismatch);
        let u64_at = |i: usize| u64::from_le_bytes(d[i..i + 8].try_into().unwrap());
        let gid = u32::from_le_bytes([d[9], d[10], d[11], 0]);
        let split = u32::from_le_bytes(d[28..32].try_into().unwrap());
        require!(
            u64_at(1) == slot.assets
                && gid == slot.group_id
                && u64_at(12) == slot.min_delay_ms
                && u64_at(20) == slot.max_delay_ms
                && split == slot.split,
            AgamaError::PaymentMismatch
        );
        require!(prev.accounts.len() >= 7, AgamaError::PaymentMismatch);
        require!(
            prev.accounts[2].pubkey == usdc
                && prev.accounts[3].pubkey == get_associated_token_address(&custody_owner, &usdc)
                && prev.accounts[5].pubkey == slot.owner
                && prev.accounts[6].pubkey == custody_owner
                && prev.accounts[6].is_signer,
            AgamaError::PaymentMismatch
        );
        *slot = Exit::default();
        Ok(())
    }

    /// Publish the private aggregate to Solana: one batched number for every
    /// private deposit and redemption since the last commit.
    pub fn commit_shielded(ctx: Context<CommitShielded>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.shielded.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Commit the aggregate and hand it back to the base layer. Used to recycle
    /// the delegation once its sponsored commits are spent.
    pub fn undelegate_shielded(ctx: Context<CommitShielded>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.shielded.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Hand a position back to the base layer. Close its permission first.
    pub fn undelegate_position(ctx: Context<CommitPosition>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.position.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

// ------------------------------------------------------------------- pricing

/// NAV in USDC, and the share supply it is divided by.
///
/// `book.nav` only counts capital the ER has actually marked into a pool. Between
/// a deposit and the tick that absorbs it, those dollars sit in custody at par, so
/// they are added here; dollars already paid out but not yet unmarked are
/// subtracted. The result stays exact across the commit boundary instead of
/// stepping every time the ER commits.
///
/// Both custodies count: the public one on Solana (`vault`) and the private one in
/// the enclave (`shielded`). The supply is agYLD plus private shares. On Solana
/// `shielded` is its last committed state, which is safe to price on: private
/// flow always enters and leaves at the share price, so a not-yet-committed
/// private deposit moves NAV and supply in proportion and leaves the price alone.
fn nav_for_pricing(vault: &Vault, book: &PoolBook, shielded: &Shielded) -> Result<(u64, u64)> {
    // `absorb` runs on the rollup, where neither custody is readable, so the
    // keeper is trusted to report how much new capital to deploy. Trusted, but
    // not unchecked: cumulative flow is monotonic in both custodies, so a book
    // claiming to have absorbed more than they ever took in is arithmetically
    // impossible and gets rejected rather than clamped.
    //
    // This does not stop a bad keeper from over-marking on the rollup. It stops the
    // over-mark from ever pricing a deposit or a redemption: both revert until the
    // book is corrected, instead of quietly minting against an inflated NAV.
    let total_in = vault.total_in.saturating_add(shielded.total_in);
    let total_out = vault.total_out.saturating_add(shielded.total_out);
    require!(
        book.marked_in <= total_in && book.marked_out <= total_out,
        AgamaError::BookAheadOfVault
    );
    let unmarked = total_in - book.marked_in;
    let unreturned = total_out - book.marked_out;
    let nav = book.nav.saturating_add(unmarked).saturating_sub(unreturned);
    Ok((nav, vault.shares.saturating_add(shielded.shares)))
}

/// Fold `added` new shares bought at `price` into the position's average entry.
fn blend_entry(position: &mut Position, added: u64, price: u64) -> Result<()> {
    let before = position.shares.saturating_add(position.private_shares);
    let after = before.saturating_add(added);
    if after == 0 {
        return Ok(());
    }
    let blended = (position.entry_price as u128 * before as u128 + price as u128 * added as u128)
        / after as u128;
    position.entry_price = u64::try_from(blended).map_err(|_| AgamaError::MathOverflow)?;
    Ok(())
}

/// Re-mark value, cost basis and yield over public and private shares together.
fn mark(position: &mut Position, price: u64, now: i64) -> Result<()> {
    let total = position.shares.saturating_add(position.private_shares) as u128;
    position.value_usdc =
        u64::try_from(total * price as u128 / ONE as u128).map_err(|_| AgamaError::MathOverflow)?;
    position.cost_basis = u64::try_from(total * position.entry_price as u128 / ONE as u128)
        .map_err(|_| AgamaError::MathOverflow)?;
    position.yield_usdc = position.value_usdc.saturating_sub(position.cost_basis);
    position.synced_ts = now;
    position.syncs = position.syncs.saturating_add(1);
    Ok(())
}

/// Burn `shares` of a private position and open an exit ticket paying
/// `destination` at the current share price. The shared body of `redeem_private`
/// and `redeem_private_to`; the caller has already decided who may do this.
#[allow(clippy::too_many_arguments)]
fn open_exit(
    a: &mut RedeemPrivate,
    shares: u64,
    group_id: u32,
    min_delay_ms: u64,
    max_delay_ms: u64,
    split: u32,
    destination: Pubkey,
    now: i64,
) -> Result<()> {
    require!(shares > 0, AgamaError::ZeroAmount);
    require!(group_id > 0 && group_id <= 0x00FF_FFFF, AgamaError::BadExitParams);
    require!(
        split > 0 && min_delay_ms <= max_delay_ms && max_delay_ms <= MAX_EXIT_DELAY_MS,
        AgamaError::BadExitParams
    );
    require!(a.position.private_shares >= shares, AgamaError::InsufficientShares);

    let book = read_book(&a.book)?;
    let (nav, supply) = nav_for_pricing(&a.vault, &book, &a.shielded)?;
    let assets = u64::try_from(shares as u128 * nav as u128 / supply as u128)
        .map_err(|_| AgamaError::MathOverflow)?;
    require!(assets > 0, AgamaError::DustDeposit);
    // What the private custody holds, by its own books. Tickets already opened
    // count as paid here, so two redemptions cannot both claim the same dollars.
    let held = a.shielded.total_in.saturating_sub(a.shielded.total_out);
    require!(assets <= held, AgamaError::InsufficientLiquidity);
    let price = share_price(nav, supply)?;

    require!(
        !a.exits.slots.iter().any(|e| e.group_id == group_id),
        AgamaError::BadExitParams
    );
    let slot = a
        .exits
        .slots
        .iter_mut()
        .find(|e| e.group_id == 0)
        .ok_or(AgamaError::ExitBookFull)?;
    *slot = Exit { owner: destination, assets, min_delay_ms, max_delay_ms, group_id, split };

    a.position.private_shares -= shares;
    mark(&mut a.position, price, now)?;
    a.shielded.shares = a.shielded.shares.saturating_sub(shares);
    a.shielded.total_out = a.shielded.total_out.saturating_add(assets);
    Ok(())
}

/// The instruction immediately before the one executing, from the instructions
/// sysvar. How this program sees a token movement it is not allowed to make.
fn previous_instruction(sysvar: &UncheckedAccount) -> Result<Instruction> {
    let current = load_current_index_checked(&sysvar.to_account_info())?;
    require!(current > 0, AgamaError::TransferMismatch);
    Ok(load_instruction_at_checked(current as usize - 1, &sysvar.to_account_info())?)
}

/// What the owner's wallet signs to hand a position to a new session key. Plain
/// text, so the wallet shows the user exactly what they are approving.
pub fn session_message(position: &Pubkey, session_key: &Pubkey, expiry: i64) -> String {
    format!(
        "Agama on MagicBlock\nAuthorize session key {} for position {} until {}",
        session_key, position, expiry
    )
}

/// `ix` is the Ed25519 precompile verifying one signature by `signer` over
/// exactly `message`, with every offset pointing into the instruction itself.
/// The precompile has already failed the transaction if the signature is wrong;
/// this checks it was the right signer and the right message.
fn assert_ed25519(ix: &Instruction, signer: &Pubkey, message: &[u8]) -> Result<()> {
    require_keys_eq!(ix.program_id, ED25519_PROGRAM_ID, AgamaError::BadSessionRotation);
    let d = &ix.data;
    require!(d.len() >= 16 && d[0] == 1, AgamaError::BadSessionRotation);
    let u16_at = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]) as usize;
    // signature_offset, signature_ix, pubkey_offset, pubkey_ix, msg_offset, msg_len, msg_ix
    let (pk_off, msg_off, msg_len) = (u16_at(6), u16_at(10), u16_at(12));
    require!(
        u16_at(4) == 0xFFFF && u16_at(8) == 0xFFFF && u16_at(14) == 0xFFFF,
        AgamaError::BadSessionRotation
    );
    require!(
        d.len() >= pk_off + 32 && d.len() >= msg_off + msg_len,
        AgamaError::BadSessionRotation
    );
    require!(
        d[pk_off..pk_off + 32] == signer.to_bytes()[..] && &d[msg_off..msg_off + msg_len] == message,
        AgamaError::BadSessionRotation
    );
    Ok(())
}

/// `ix` is an SPL Token transfer of exactly `amount` from `from` to `to`,
/// authorised by `authority`. Accepts both `Transfer` and `TransferChecked`.
fn assert_token_transfer(
    ix: &Instruction,
    amount: u64,
    from: &Pubkey,
    to: &Pubkey,
    authority: &Pubkey,
) -> Result<()> {
    require_keys_eq!(ix.program_id, anchor_spl::token::ID, AgamaError::TransferMismatch);
    let d = &ix.data;
    let k = &ix.accounts;
    let (src, dst, auth) = match d.first() {
        Some(&SPL_TRANSFER) if d.len() >= 9 && k.len() >= 3 => (0, 1, 2),
        Some(&SPL_TRANSFER_CHECKED) if d.len() >= 10 && k.len() >= 4 => (0, 2, 3),
        _ => return err!(AgamaError::TransferMismatch),
    };
    require!(
        u64::from_le_bytes(d[1..9].try_into().unwrap()) == amount
            && k[src].pubkey == *from
            && k[dst].pubkey == *to
            && k[auth].pubkey == *authority
            && k[auth].is_signer,
        AgamaError::TransferMismatch
    );
    Ok(())
}

/// Share price, 6 decimals.
fn share_price(nav: u64, supply: u64) -> Result<u64> {
    if supply == 0 {
        return Ok(ONE);
    }
    u64::try_from(nav as u128 * ONE as u128 / supply as u128).map_err(|_| error!(AgamaError::MathOverflow))
}

/// Who is allowed to act on a position inside the rollup.
///
/// The owner's wallet cannot be the answer. Wallets refuse to sign an Ephemeral
/// Rollup transaction outright: Phantom inspects the blockhash, fails to place it
/// on any cluster it knows, decides the transaction is for mainnet, and offers no
/// approve button at all. So the owner authorises a browser-held session key once,
/// on the base layer, in the same transaction as their deposit, and that key signs
/// everything that happens on the rollup afterwards.
///
/// The session key can read and mark the position. It cannot move a single token:
/// deposits, redemptions and custody all live on Solana, where only the wallet
/// signs.
fn assert_may_act(position: &Position, signer: &Pubkey, now: i64) -> Result<()> {
    if signer == &position.owner {
        return Ok(());
    }
    require!(
        signer == &position.session_key
            && position.session_key != Pubkey::default()
            && now < position.session_expiry,
        AgamaError::Unauthorized
    );
    Ok(())
}

/// Read the pool book from an account that may or may not be delegated.
///
/// Once the book is delegated, Solana reports it as owned by the delegation
/// program, so Anchor's `Account<PoolBook>` refuses to load it. The bytes are
/// unchanged, they are the last state the rollup committed, and reading them is
/// precisely what pricing a base-layer deposit needs. So the owner check is done
/// here, against both owners the account can legitimately have, and the
/// discriminator is verified by hand.
///
/// This is read-only. Nothing on the base layer ever writes the book once it is
/// delegated; that is the rollup's job.
fn read_book(info: &UncheckedAccount) -> Result<PoolBook> {
    require!(
        info.owner == &crate::ID || info.owner == &ephemeral_rollups_sdk::id(),
        AgamaError::BadBookOwner
    );
    let data = info.try_borrow_data()?;
    require!(data.len() > 8, AgamaError::BadBookOwner);
    require!(
        data[..8] == PoolBook::DISCRIMINATOR[..],
        AgamaError::BadBookOwner
    );
    let mut slice: &[u8] = &data[8..];
    PoolBook::deserialize(&mut slice).map_err(|_| error!(AgamaError::BadBookOwner))
}

/// Read the private aggregate on the base layer, where it is delegated to the TEE
/// and so owned by the delegation program. Same checks as `read_book`.
fn read_shielded(info: &UncheckedAccount) -> Result<Shielded> {
    require!(
        info.owner == &crate::ID || info.owner == &ephemeral_rollups_sdk::id(),
        AgamaError::BadShielded
    );
    let data = info.try_borrow_data()?;
    require!(data.len() > 8, AgamaError::BadShielded);
    require!(data[..8] == Shielded::DISCRIMINATOR[..], AgamaError::BadShielded);
    let mut slice: &[u8] = &data[8..];
    Shielded::deserialize(&mut slice).map_err(|_| error!(AgamaError::BadShielded))
}

fn members_args(
    is_private: bool,
    owner: &Pubkey,
    session_key: Pubkey,
    viewers: &[Pubkey],
) -> EphemeralMembersArgs {
    let mut members = Vec::with_capacity(viewers.len() + 2);
    members.push(Member {
        flags: OWNER_FLAGS,
        pubkey: *owner,
    });
    // The session key reads with its own login token, so it has to be on the list
    // or the browser cannot show the owner their own position.
    if session_key != Pubkey::default() {
        members.push(Member {
            flags: VIEWER_FLAGS,
            pubkey: session_key,
        });
    }
    for v in viewers {
        members.push(Member {
            flags: VIEWER_FLAGS,
            pubkey: *v,
        });
    }
    EphemeralMembersArgs {
        is_private,
        members,
    }
}

// -------------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub agyld_mint: Pubkey,
    /// agYLD supply, authoritative on the base layer.
    pub shares: u64,
    /// Cumulative USDC in / out. Monotonic, which is what makes `tick` replayable.
    pub total_in: u64,
    pub total_out: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct PoolEntry {
    pub name: [u8; 24],
    pub sector: [u8; 32],
    pub apr_bps: u32,
    pub weight_bps: u16,
    pub principal: u64,
    pub accrued: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct PoolInit {
    pub name: [u8; 24],
    pub sector: [u8; 32],
    pub apr_bps: u32,
    pub weight_bps: u16,
}

#[account]
#[derive(InitSpace)]
pub struct PoolBook {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub pools: [PoolEntry; POOL_COUNT],
    /// Σ (principal + accrued), as of `last_ts`.
    pub nav: u64,
    /// How much of the vault's cumulative flow this book has already absorbed.
    pub marked_in: u64,
    pub marked_out: u64,
    pub last_ts: i64,
    /// ER ticks since delegation. The 10 ms heartbeat, made visible.
    pub ticks: u64,
    pub bump: u8,
}

impl PoolBook {
    /// Spread `amount` across the pools by weight; the last funded pool absorbs
    /// the rounding remainder so nothing is lost.
    pub fn fund(&mut self, amount: u64) {
        let total_w: u32 = self.pools.iter().map(|p| p.weight_bps as u32).sum();
        let mut placed: u64 = 0;
        for i in 0..POOL_COUNT {
            let part = if i == POOL_COUNT - 1 {
                amount.saturating_sub(placed)
            } else if total_w == 0 {
                amount / POOL_COUNT as u64
            } else {
                ((amount as u128 * self.pools[i].weight_bps as u128) / total_w as u128) as u64
            };
            self.pools[i].principal = self.pools[i].principal.saturating_add(part);
            placed = placed.saturating_add(part);
        }
    }

    /// Pull `amount` back out, in pool order, capped by each pool's principal.
    pub fn defund(&mut self, amount: u64) {
        let mut rem = amount;
        for i in 0..POOL_COUNT {
            if rem == 0 {
                break;
            }
            let take = rem.min(self.pools[i].principal);
            self.pools[i].principal -= take;
            rem -= take;
        }
    }

    /// Fold yield earned since `last_ts` into each pool's accrued balance.
    pub fn accrue(&mut self, now: i64) {
        if now <= self.last_ts {
            return;
        }
        let dt = (now - self.last_ts) as u128;
        for p in self.pools.iter_mut() {
            let pending =
                (p.principal as u128 * p.apr_bps as u128 * dt) / (BPS * SECONDS_PER_YEAR);
            p.accrued = p.accrued.saturating_add(pending as u64);
        }
    }

    pub fn marked_value(&self) -> u64 {
        self.pools
            .iter()
            .fold(0u64, |acc, p| acc.saturating_add(p.principal).saturating_add(p.accrued))
    }
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub vault: Pubkey,
    /// agYLD held, mirrored from the owner's token account at sync time.
    pub shares: u64,
    /// Shares that exist only here: minted by `deposit_private`, burned by
    /// `redeem_private`, never an SPL balance anywhere.
    pub private_shares: u64,
    /// Share-weighted average entry price, 6 decimals.
    pub entry_price: u64,
    pub value_usdc: u64,
    pub cost_basis: u64,
    pub yield_usdc: u64,
    pub synced_ts: i64,
    pub syncs: u32,
    /// Mirrors whether an EphemeralPermission is gating this account on the ER.
    pub is_private: bool,
    pub bump: u8,
    /// Browser-held key allowed to act on this position inside the rollup. Set on
    /// the base layer by the owner; worthless anywhere else.
    pub session_key: Pubkey,
    pub session_expiry: i64,
}

#[account]
#[derive(InitSpace)]
pub struct FaucetClaim {
    pub owner: Pubkey,
    pub last_ts: i64,
}

/// The private half of the vault, in aggregate. Lives in the TEE, gated to the
/// vault authority; Solana sees it only as of the last `commit_shielded`.
#[account]
#[derive(InitSpace)]
pub struct Shielded {
    pub vault: Pubkey,
    /// Owns the private custody eATA. An operator key rather than a PDA,
    /// because the enclave refuses to pass a private eATA to this program, so
    /// a PDA could never sign for it. See `settle_exit` for what is still held
    /// to the program's rules.
    pub custody_owner: Pubkey,
    /// Private shares outstanding, across every position.
    pub shares: u64,
    /// Cumulative USDC into / out of the private custody. Monotonic, like the
    /// vault's own, so `nav_for_pricing` can bound the book against both.
    pub total_in: u64,
    pub total_out: u64,
    pub bump: u8,
}

/// A private redemption the custody still owes. `group_id == 0` is a free slot.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Exit {
    pub owner: Pubkey,
    pub assets: u64,
    pub min_delay_ms: u64,
    pub max_delay_ms: u64,
    pub group_id: u32,
    pub split: u32,
}

/// Open exit tickets. Lives in the TEE, gated to the authority, and is never
/// committed: who redeemed what never reaches Solana from here.
#[account]
#[derive(InitSpace)]
pub struct ExitBook {
    pub vault: Pubkey,
    pub slots: [Exit; EXIT_SLOTS],
}

// ------------------------------------------------------------------ contexts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = payer,
        seeds = [USDC_SEED],
        bump,
        mint::decimals = DECIMALS,
        mint::authority = vault,
    )]
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        seeds = [AGYLD_SEED],
        bump,
        mint::decimals = DECIMALS,
        mint::authority = vault,
    )]
    pub agyld_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault,
    )]
    pub vault_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitBook<'info> {
    #[account(mut, address = vault.authority @ AgamaError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = authority,
        space = 8 + PoolBook::INIT_SPACE,
        seeds = [BOOK_SEED, vault.key().as_ref()],
        bump
    )]
    pub book: Account<'info, PoolBook>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MigrateBook<'info> {
    #[account(mut, address = vault.authority @ AgamaError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: read-only, delegated and possibly orphaned. See `read_book`.
    #[account(seeds = [LEGACY_BOOK_SEED, vault.key().as_ref()], bump)]
    pub legacy_book: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + PoolBook::INIT_SPACE,
        seeds = [BOOK_SEED, vault.key().as_ref()],
        bump
    )]
    pub book: Account<'info, PoolBook>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Faucet<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + FaucetClaim::INIT_SPACE,
        seeds = [CLAIM_SEED, user.key().as_ref()],
        bump
    )]
    pub claim: Account<'info, FaucetClaim>,
    #[account(mut, address = vault.usdc_mint @ AgamaError::BadMint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
    )]
    pub user_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: read-only, and delegated more often than not. See `read_book`. The
    /// PDA is pinned by seeds; ownership and discriminator are checked there.
    #[account(seeds = [BOOK_SEED, vault.key().as_ref()], bump)]
    pub book: UncheckedAccount<'info>,
    /// CHECK: read-only, delegated to the TEE. See `read_shielded`.
    #[account(seeds = [SHIELDED_V2_SEED, vault.key().as_ref()], bump)]
    pub shielded: UncheckedAccount<'info>,
    #[account(mut, address = vault.usdc_mint @ AgamaError::BadMint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, address = vault.agyld_mint @ AgamaError::BadMint)]
    pub agyld_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
    )]
    pub user_usdc: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = agyld_mint,
        associated_token::authority = user,
    )]
    pub user_agyld: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault,
    )]
    pub vault_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: read-only and usually delegated. See `read_book`.
    #[account(seeds = [BOOK_SEED, vault.key().as_ref()], bump)]
    pub book: UncheckedAccount<'info>,
    /// CHECK: read-only, delegated to the TEE. See `read_shielded`.
    #[account(seeds = [SHIELDED_V2_SEED, vault.key().as_ref()], bump)]
    pub shielded: UncheckedAccount<'info>,
    #[account(mut, address = vault.usdc_mint @ AgamaError::BadMint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, address = vault.agyld_mint @ AgamaError::BadMint)]
    pub agyld_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
    )]
    pub user_usdc: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = agyld_mint,
        associated_token::authority = user,
    )]
    pub user_agyld: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault,
    )]
    pub vault_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = owner,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateBook<'info> {
    #[account(mut, address = vault.authority @ AgamaError::Unauthorized)]
    pub payer: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: the PoolBook PDA, handed to the delegation program.
    #[account(mut, del, seeds = [BOOK_SEED, vault.key().as_ref()], bump)]
    pub book: UncheckedAccount<'info>,
    /// CHECK: target ER validator, forwarded in DelegateConfig.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct AuthorizeSession<'info> {
    #[account(mut, address = position.owner @ AgamaError::Unauthorized)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, Position>,
}

#[derive(Accounts)]
pub struct PrepareForRollup<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: topped up by address; the seeds pin which account it is.
    #[account(mut, seeds = [POSITION_SEED, owner.key().as_ref()], bump)]
    pub position: UncheckedAccount<'info>,
    /// Absent for a fully private depositor, who holds no agYLD.
    #[account(
        mut,
        associated_token::mint = agyld_mint,
        associated_token::authority = owner,
    )]
    pub owner_agyld: Option<Account<'info, TokenAccount>>,
    #[account(address = vault.agyld_mint @ AgamaError::BadMint)]
    pub agyld_mint: Account<'info, Mint>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: the Position PDA, handed to the delegation program.
    #[account(mut, del, seeds = [POSITION_SEED, owner.key().as_ref()], bump)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: target TEE validator, forwarded in DelegateConfig.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct Tick<'info> {
    pub payer: Signer<'info>,
    #[account(mut)]
    pub book: Account<'info, PoolBook>,
}

#[derive(Accounts)]
pub struct Absorb<'info> {
    #[account(address = book.authority @ AgamaError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub book: Account<'info, PoolBook>,
}

#[derive(Accounts)]
pub struct SetApr<'info> {
    #[account(address = book.authority @ AgamaError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub book: Account<'info, PoolBook>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub book: Account<'info, PoolBook>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitPosition<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, has_one = owner @ AgamaError::Unauthorized)]
    pub position: Account<'info, Position>,
    /// CHECK: identity check only, via has_one.
    pub owner: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PermissionCtx<'info> {
    /// The owner's wallet, or the session key it authorised. Checked in the
    /// handler by `assert_may_act`, because Anchor cannot express "one of these
    /// two" as a constraint.
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, position.owner.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, Position>,
    /// CHECK: derived and validated under the permission program.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, position.key().as_ref()],
        bump,
        seeds::program = permission_program.key()
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SyncPosition<'info> {
    /// The owner's wallet, or the session key it authorised. Not writable: this
    /// instruction moves no lamports.
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, position.owner.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, Position>,
    /// CHECK: pinned to the position's owner; only used to derive their agYLD
    /// account, which is what the enclave reads to learn the share balance.
    #[account(address = position.owner @ AgamaError::Unauthorized)]
    pub owner: UncheckedAccount<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: read-only, and delegated to a different rollup. See `read_book`.
    #[account(seeds = [BOOK_SEED, vault.key().as_ref()], bump)]
    pub book: UncheckedAccount<'info>,
    #[account(seeds = [SHIELDED_V2_SEED, vault.key().as_ref()], bump = shielded.bump)]
    pub shielded: Account<'info, Shielded>,
    /// Absent for a fully private depositor, who holds no agYLD.
    #[account(
        associated_token::mint = vault.agyld_mint,
        associated_token::authority = owner,
    )]
    pub owner_agyld: Option<Account<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct RotateSession<'info> {
    /// Whoever submits it, usually the new session key. Its authority comes from
    /// the owner's signature, checked in the handler.
    pub submitter: Signer<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, position.owner.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, Position>,
    /// CHECK: derived and validated under the permission program.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, position.key().as_ref()],
        bump,
        seeds::program = permission_program.key()
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: address-checked; read through `load_instruction_at_checked`.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitShielded<'info> {
    #[account(mut, address = vault.authority @ AgamaError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = authority,
        space = 8 + Shielded::INIT_SPACE,
        seeds = [SHIELDED_V2_SEED, vault.key().as_ref()],
        bump
    )]
    pub shielded: Account<'info, Shielded>,
    #[account(
        init,
        payer = authority,
        space = 8 + ExitBook::INIT_SPACE,
        seeds = [EXITS_SEED, vault.key().as_ref()],
        bump
    )]
    pub exits: Box<Account<'info, ExitBook>>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateShielded<'info> {
    #[account(mut, address = vault.authority @ AgamaError::Unauthorized)]
    pub payer: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: the Shielded PDA, handed to the delegation program.
    #[account(mut, del, seeds = [SHIELDED_V2_SEED, vault.key().as_ref()], bump)]
    pub shielded: UncheckedAccount<'info>,
    /// CHECK: target TEE validator, forwarded in DelegateConfig.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateExits<'info> {
    #[account(mut, address = vault.authority @ AgamaError::Unauthorized)]
    pub payer: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: the ExitBook PDA, handed to the delegation program.
    #[account(mut, del, seeds = [EXITS_SEED, vault.key().as_ref()], bump)]
    pub exits: UncheckedAccount<'info>,
    /// CHECK: target TEE validator, forwarded in DelegateConfig.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct ShieldedPermission<'info> {
    #[account(mut, address = vault.authority @ AgamaError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [SHIELDED_V2_SEED, vault.key().as_ref()], bump = shielded.bump)]
    pub shielded: Account<'info, Shielded>,
    /// CHECK: derived and validated under the permission program.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, shielded.key().as_ref()],
        bump,
        seeds::program = permission_program.key()
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: only its address and lamports are used; seeds pin it.
    #[account(mut, seeds = [EXITS_SEED, vault.key().as_ref()], bump)]
    pub exits: UncheckedAccount<'info>,
    /// CHECK: derived and validated under the permission program.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, exits.key().as_ref()],
        bump,
        seeds::program = permission_program.key()
    )]
    pub exits_permission: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DepositPrivate<'info> {
    /// The throwaway key that shielded the USDC, and that signs the transfer
    /// into the custody in the instruction before this one.
    pub depositor: Signer<'info>,
    /// The owner's wallet, or the session key it authorised.
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, position.owner.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, Position>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: read-only, delegated to the public rollup. See `read_book`.
    #[account(seeds = [BOOK_SEED, vault.key().as_ref()], bump)]
    pub book: UncheckedAccount<'info>,
    #[account(mut, seeds = [SHIELDED_V2_SEED, vault.key().as_ref()], bump = shielded.bump)]
    pub shielded: Account<'info, Shielded>,
    /// CHECK: address-checked; read through `load_instruction_at_checked`.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RedeemPrivate<'info> {
    /// The owner's wallet, or the session key it authorised.
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, position.owner.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, Position>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: read-only, delegated to the public rollup. See `read_book`.
    #[account(seeds = [BOOK_SEED, vault.key().as_ref()], bump)]
    pub book: UncheckedAccount<'info>,
    #[account(mut, seeds = [SHIELDED_V2_SEED, vault.key().as_ref()], bump = shielded.bump)]
    pub shielded: Account<'info, Shielded>,
    #[account(mut, seeds = [EXITS_SEED, vault.key().as_ref()], bump)]
    pub exits: Box<Account<'info, ExitBook>>,
}

#[derive(Accounts)]
pub struct SettleExit<'info> {
    #[account(address = vault.authority @ AgamaError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(seeds = [SHIELDED_V2_SEED, vault.key().as_ref()], bump = shielded.bump)]
    pub shielded: Account<'info, Shielded>,
    #[account(mut, seeds = [EXITS_SEED, vault.key().as_ref()], bump)]
    pub exits: Box<Account<'info, ExitBook>>,
    /// CHECK: address-checked; read through `load_instruction_at_checked`.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitShielded<'info> {
    /// Only the authority decides when the aggregate goes public. Anyone else
    /// committing after every deposit would turn the batch back into a trail.
    #[account(mut, address = vault.authority @ AgamaError::Unauthorized)]
    pub payer: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [SHIELDED_V2_SEED, vault.key().as_ref()], bump = shielded.bump)]
    pub shielded: Account<'info, Shielded>,
}

// ------------------------------------------------------------------- events

#[event]
pub struct Deposited {
    pub user: Pubkey,
    pub assets: u64,
    pub shares: u64,
    pub nav: u64,
}

#[event]
pub struct Absorbed {
    pub inflow: u64,
    pub outflow: u64,
    pub nav: u64,
}

#[event]
pub struct Redeemed {
    pub user: Pubkey,
    pub shares: u64,
    pub assets: u64,
    pub nav: u64,
}

// ------------------------------------------------------------------- errors

#[error_code]
pub enum AgamaError {
    #[msg("amount is zero")]
    ZeroAmount,
    #[msg("deposit too small to mint a share")]
    DustDeposit,
    #[msg("not enough shares outstanding")]
    InsufficientShares,
    #[msg("vault custody cannot cover this redemption")]
    InsufficientLiquidity,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("pool index out of range")]
    BadPool,
    #[msg("unexpected mint")]
    BadMint,
    #[msg("caller is not the authority")]
    Unauthorized,
    #[msg("permission member count exceeds MAX_PERMISSION_MEMBERS")]
    TooManyMembers,
    #[msg("faucet is on cooldown")]
    FaucetCooldown,
    #[msg("pool book account is not the expected PDA, owner or type")]
    BadBookOwner,
    #[msg("the pool book has absorbed more flow than the vault ever took in")]
    BookAheadOfVault,
    #[msg("shielded account is not the expected PDA, owner or type")]
    BadShielded,
    #[msg("group id, split or delay out of range, or group id already in use")]
    BadExitParams,
    #[msg("the previous instruction is not the expected transfer into the custody")]
    TransferMismatch,
    #[msg("the previous instruction is not the payment this exit ticket asks for")]
    PaymentMismatch,
    #[msg("no open exit ticket with this group id")]
    UnknownExit,
    #[msg("every exit slot is taken; wait for the custody to pay one")]
    ExitBookFull,
    #[msg("session rotation needs the owner's Ed25519 signature over the exact message, and a later expiry")]
    BadSessionRotation,
}

// -------------------------------------------------------------------- tests
//
// The checks the private path's safety rests on, run natively with
// `cargo test`: the two introspection checks (what a forged or mismatched
// neighbour instruction looks like to them), pricing across both custodies, and
// the entry-price average.

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::instruction::AccountMeta;

    fn key(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    fn vault(shares: u64, total_in: u64, total_out: u64) -> Vault {
        Vault { authority: key(1), usdc_mint: key(2), agyld_mint: key(3), shares, total_in, total_out, bump: 0 }
    }

    fn book(nav: u64, marked_in: u64, marked_out: u64) -> PoolBook {
        PoolBook {
            vault: key(4),
            authority: key(1),
            pools: [PoolEntry::default(); POOL_COUNT],
            nav,
            marked_in,
            marked_out,
            last_ts: 0,
            ticks: 0,
            bump: 0,
        }
    }

    fn shielded(shares: u64, total_in: u64, total_out: u64) -> Shielded {
        Shielded { vault: key(4), custody_owner: key(9), shares, total_in, total_out, bump: 0 }
    }

    fn transfer_ix(tag: u8, amount: u64, from: Pubkey, to: Pubkey, auth: Pubkey, signs: bool) -> Instruction {
        let mut data = vec![tag];
        data.extend_from_slice(&amount.to_le_bytes());
        let mut accounts = vec![AccountMeta::new(from, false)];
        if tag == SPL_TRANSFER_CHECKED {
            data.push(DECIMALS);
            accounts.push(AccountMeta::new_readonly(key(2), false));
        }
        accounts.push(AccountMeta::new(to, false));
        accounts.push(AccountMeta::new_readonly(auth, signs));
        Instruction { program_id: anchor_spl::token::ID, accounts, data }
    }

    // ------------------------------------------------------------ pricing

    #[test]
    fn unmarked_flow_from_both_custodies_prices_at_par() {
        // 1000 marked into the pools; 100 public and 50 private not absorbed yet.
        let (nav, supply) = nav_for_pricing(&vault(900, 1_100, 0), &book(1_000, 1_000, 0), &shielded(40, 50, 0)).unwrap();
        assert_eq!(nav, 1_150);
        assert_eq!(supply, 940);
    }

    #[test]
    fn a_book_ahead_of_both_custodies_is_rejected() {
        let r = nav_for_pricing(&vault(0, 100, 0), &book(0, 151, 0), &shielded(0, 50, 0));
        assert!(r.is_err());
        // Exactly at the combined total is fine.
        assert!(nav_for_pricing(&vault(0, 100, 0), &book(0, 150, 0), &shielded(0, 50, 0)).is_ok());
    }

    #[test]
    fn a_private_deposit_not_yet_committed_leaves_the_price_alone() {
        // Base prices on the committed aggregate; the enclave on the live one.
        // A private deposit enters at the share price, so both agree.
        let v = vault(1_000, 1_000, 0);
        let b = book(1_100, 1_000, 0);
        let committed = shielded(0, 0, 0);
        let (nav0, s0) = nav_for_pricing(&v, &b, &committed).unwrap();
        let price = share_price(nav0, s0).unwrap();
        // 110 units of USDC at a price of 1.1 buy 100 units of shares.
        let shares = (110u128 * ONE as u128 / price as u128) as u64;
        assert_eq!(shares, 100);
        let live = shielded(shares, 110, 0);
        let (nav1, s1) = nav_for_pricing(&v, &b, &live).unwrap();
        let p1 = share_price(nav1, s1).unwrap();
        assert!(p1.abs_diff(price) <= 1, "{price} vs {p1}");
    }

    #[test]
    fn entry_price_averages_in_and_marks_both_kinds_of_share() {
        let mut p = Position {
            owner: key(1),
            vault: key(4),
            shares: 0,
            private_shares: 0,
            entry_price: ONE,
            value_usdc: 0,
            cost_basis: 0,
            yield_usdc: 0,
            synced_ts: 0,
            syncs: 0,
            is_private: true,
            bump: 0,
            session_key: key(5),
            session_expiry: 0,
        };
        blend_entry(&mut p, 100 * ONE, ONE).unwrap();
        p.private_shares = 100 * ONE;
        blend_entry(&mut p, 100 * ONE, 2 * ONE).unwrap();
        p.shares = 100 * ONE; // the second lot arrived as agYLD
        assert_eq!(p.entry_price, 3 * ONE / 2);
        mark(&mut p, 2 * ONE, 7).unwrap();
        assert_eq!(p.value_usdc, 400 * ONE);
        assert_eq!(p.cost_basis, 300 * ONE);
        assert_eq!(p.yield_usdc, 100 * ONE);
    }

    // ------------------------------------------- the transfer deposit_private reads

    #[test]
    fn the_exact_transfer_is_accepted_in_both_forms() {
        let (from, to, auth) = (key(6), key(7), key(8));
        assert!(assert_token_transfer(&transfer_ix(SPL_TRANSFER, 500, from, to, auth, true), 500, &from, &to, &auth).is_ok());
        assert!(assert_token_transfer(&transfer_ix(SPL_TRANSFER_CHECKED, 500, from, to, auth, true), 500, &from, &to, &auth).is_ok());
    }

    #[test]
    fn anything_but_the_exact_transfer_is_refused() {
        let (from, to, auth) = (key(6), key(7), key(8));
        let ok = |ix: &Instruction| assert_token_transfer(ix, 500, &from, &to, &auth).is_ok();
        assert!(!ok(&transfer_ix(SPL_TRANSFER, 499, from, to, auth, true)), "less than credited");
        assert!(!ok(&transfer_ix(SPL_TRANSFER, 501, from, to, auth, true)), "more than credited");
        assert!(!ok(&transfer_ix(SPL_TRANSFER, 500, from, key(9), auth, true)), "to elsewhere");
        assert!(!ok(&transfer_ix(SPL_TRANSFER, 500, key(9), to, auth, true)), "from elsewhere");
        assert!(!ok(&transfer_ix(SPL_TRANSFER, 500, from, to, key(9), true)), "someone else's authority");
        assert!(!ok(&transfer_ix(SPL_TRANSFER, 500, from, to, auth, false)), "authority not signing");
        let mut other_program = transfer_ix(SPL_TRANSFER, 500, from, to, auth, true);
        other_program.program_id = key(10);
        assert!(!ok(&other_program), "not SPL Token");
        let mut approve = transfer_ix(SPL_TRANSFER, 500, from, to, auth, true);
        approve.data[0] = 4;
        assert!(!ok(&approve), "an approve, not a transfer");
    }

    // ---------------------------------------------- the signature rotate_session reads

    /// The Ed25519 precompile's layout, with every offset in this instruction.
    fn ed25519_ix(signer: &Pubkey, message: &[u8], index_override: Option<u16>) -> Instruction {
        let header = 2 + 14;
        let pk_off = header;
        let sig_off = pk_off + 32;
        let msg_off = sig_off + 64;
        let ix = index_override.unwrap_or(0xFFFF);
        let mut d = vec![1u8, 0];
        for v in [sig_off as u16, ix, pk_off as u16, ix, msg_off as u16, message.len() as u16, ix] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d.extend_from_slice(&signer.to_bytes());
        d.extend_from_slice(&[0u8; 64]);
        d.extend_from_slice(message);
        Instruction { program_id: ED25519_PROGRAM_ID, accounts: vec![], data: d }
    }

    #[test]
    fn the_owner_over_the_exact_message_is_accepted() {
        let m = session_message(&key(4), &key(5), 1_800_000_000);
        assert!(assert_ed25519(&ed25519_ix(&key(1), m.as_bytes(), None), &key(1), m.as_bytes()).is_ok());
    }

    #[test]
    fn another_signer_message_or_layout_is_refused() {
        let m = session_message(&key(4), &key(5), 1_800_000_000);
        let other = session_message(&key(4), &key(6), 1_800_000_000);
        assert!(assert_ed25519(&ed25519_ix(&key(2), m.as_bytes(), None), &key(1), m.as_bytes()).is_err(), "other signer");
        assert!(assert_ed25519(&ed25519_ix(&key(1), other.as_bytes(), None), &key(1), m.as_bytes()).is_err(), "other key");
        assert!(
            assert_ed25519(&ed25519_ix(&key(1), m.as_bytes(), Some(0)), &key(1), m.as_bytes()).is_err(),
            "data read from another instruction"
        );
        let mut not_precompile = ed25519_ix(&key(1), m.as_bytes(), None);
        not_precompile.program_id = key(10);
        assert!(assert_ed25519(&not_precompile, &key(1), m.as_bytes()).is_err(), "not the precompile");
    }

    #[test]
    fn the_message_names_key_position_and_expiry() {
        let m = session_message(&key(4), &key(5), 42);
        assert!(m.starts_with("Agama on MagicBlock\nAuthorize session key "));
        assert!(m.contains(&key(5).to_string()) && m.contains(&key(4).to_string()) && m.ends_with(" until 42"));
    }
}
