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
//                       EphemeralPermission. The public chain shows an agYLD
//                       balance; entry price, marked value and accrued yield are
//                       readable only by the owner and whoever they admit
//                       (an auditor, a fund administrator).
//
// This is hardware-verified confidentiality (Intel TDX), not zero-knowledge. The
// trust assumption is the enclave, and it is stated as such.
use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as system_transfer, Transfer as SystemTransfer};
use anchor_spl::associated_token::AssociatedToken;
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
pub const BOOK_SEED: &[u8] = b"lending-book";
pub const POSITION_SEED: &[u8] = b"position-v2";
pub const USDC_SEED: &[u8] = b"usdc-mint";
pub const AGYLD_SEED: &[u8] = b"agyld-mint";
pub const CLAIM_SEED: &[u8] = b"faucet-claim";

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
        let nav = nav_for_pricing(&ctx.accounts.vault, &book)?;
        let supply = ctx.accounts.vault.shares;

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
        let nav = nav_for_pricing(&ctx.accounts.vault, &book)?;
        let supply = ctx.accounts.vault.shares;
        require!(supply >= shares, AgamaError::InsufficientShares);

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
        position.entry_price = ONE;
        position.value_usdc = 0;
        position.cost_basis = 0;
        position.yield_usdc = 0;
        position.syncs = 0;
        position.synced_ts = 0;
        position.is_private = false;
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
        for account in [
            ctx.accounts.position.to_account_info(),
            ctx.accounts.owner_agyld.to_account_info(),
        ] {
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
        let supply = ctx.accounts.vault.shares;
        // The book lives on the public rollup, this instruction runs on the TEE
        // one, so here it is a base-layer clone owned by the delegation program.
        // Positions therefore mark against the last committed NAV, which is the
        // right granularity for a position ledger.
        let book = read_book(&ctx.accounts.book)?;
        let nav = nav_for_pricing(&ctx.accounts.vault, &book)?;
        let price = if supply == 0 {
            ONE
        } else {
            u64::try_from(nav as u128 * ONE as u128 / supply as u128)
                .map_err(|_| AgamaError::MathOverflow)?
        };

        let position = &mut ctx.accounts.position;
        let held = ctx.accounts.owner_agyld.amount;

        // Averaging in only makes sense when shares actually arrived. Guarding the
        // zero case also keeps a replayed sync from re-blending an entry price.
        if held > 0 && held > position.shares {
            // Averaging in: blend the new shares at today's price.
            let added = held - position.shares;
            let blended = (position.entry_price as u128 * position.shares as u128
                + price as u128 * added as u128)
                / held as u128;
            position.entry_price = u64::try_from(blended).map_err(|_| AgamaError::MathOverflow)?;
        }
        // Averaging out leaves the entry price alone: the exit realises P&L, it
        // does not re-mark what is left behind.

        position.shares = held;
        position.value_usdc = u64::try_from(held as u128 * price as u128 / ONE as u128)
            .map_err(|_| AgamaError::MathOverflow)?;
        position.cost_basis = u64::try_from(held as u128 * position.entry_price as u128 / ONE as u128)
            .map_err(|_| AgamaError::MathOverflow)?;
        position.yield_usdc = position.value_usdc.saturating_sub(position.cost_basis);
        position.synced_ts = now;
        position.syncs = position.syncs.saturating_add(1);
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

/// NAV in USDC.
///
/// `book.nav` only counts capital the ER has actually marked into a pool. Between
/// a base-layer deposit and the tick that absorbs it, those dollars sit in custody
/// at par, so they are added here; dollars already paid out but not yet unmarked
/// are subtracted. The result stays exact across the commit boundary instead of
/// stepping every time the ER commits.
fn nav_for_pricing(vault: &Account<Vault>, book: &PoolBook) -> Result<u64> {
    // `absorb` runs on the rollup, where the vault is not readable, so the keeper
    // is trusted to report how much new capital to deploy. Trusted, but not
    // unchecked: the vault's cumulative flow is monotonic and lives here, so a book
    // claiming to have absorbed more than Solana ever took in is arithmetically
    // impossible and gets rejected rather than clamped.
    //
    // This does not stop a bad keeper from over-marking on the rollup. It stops the
    // over-mark from ever pricing a deposit or a redemption: both revert until the
    // book is corrected, instead of quietly minting against an inflated NAV.
    require!(
        book.marked_in <= vault.total_in && book.marked_out <= vault.total_out,
        AgamaError::BookAheadOfVault
    );
    let unmarked = vault.total_in - book.marked_in;
    let unreturned = vault.total_out - book.marked_out;
    Ok(book.nav.saturating_add(unmarked).saturating_sub(unreturned))
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
    #[account(
        mut,
        associated_token::mint = agyld_mint,
        associated_token::authority = owner,
    )]
    pub owner_agyld: Account<'info, TokenAccount>,
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
    #[account(
        associated_token::mint = vault.agyld_mint,
        associated_token::authority = owner,
    )]
    pub owner_agyld: Account<'info, TokenAccount>,
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
}
