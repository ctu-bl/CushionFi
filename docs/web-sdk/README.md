# Cushion Business SDK (Frontend Guide)

This document describes how to use the Business SDK from a frontend (Next.js / React), with a focus on:

- what to call for each instruction
- what inputs are accepted
- what the SDK computes automatically
- what can fail and why

Source of truth used for this guide:

- SDK code in `web/src/sdk/**`
- generated IDL in `web/src/generated/cushion/idl.json`

## Caller conventions

| Caller | What to use |
|--------|-------------|
| **App (frontend)** | Business SDK methods: `sdk.vault.*`, `sdk.position.*`, `sdk.collateral.*`, `sdk.debt.*` |
| **Keeper (off-chain service)** | Raw program access: `inject_collateral`, `withdraw_injected_collateral` |
| **Admin (scripts)** | Raw program access: `init_vault`, `update_market_price`, `init_position_registry`, `init_collection` |

Never call keeper or admin instructions from the frontend.

## 1) What this SDK layer does

The SDK wraps Anchor and IDL details so UI developers do not need to handle:

- `Program<Cushion>` and `program.methods.*`
- PDA derivation logic
- ATA creation checks/instructions
- KLend reserve/oracle/remaining-account wiring
- conversion between UI amounts and on-chain integer constraints
- raw Anchor error parsing

## 2) Creating the SDK instance

```ts
import { createCushionSdkFromEnv, WalletAdapterTxSender } from "@/src/sdk";

const sdk = createCushionSdkFromEnv({
  provider, // AnchorProvider
  sender: new WalletAdapterTxSender(provider, wallet), // optional
  borrowInstructionVariant: "increaseDebt", // default
});
```

`createCushionSdkFromEnv` resolves KLend/Farms programs from env with scoped overrides:

- `NEXT_PUBLIC_KLEND_PROGRAM_ID[_LOCAL|_DEVNET|_PROD]`
- `NEXT_PUBLIC_FARMS_PROGRAM_ID[_LOCAL|_DEVNET|_PROD]`
- `NEXT_PUBLIC_KLEND_FARMS_PROGRAM[_LOCAL|_DEVNET|_PROD]` (fallback alias)
- `NEXT_PUBLIC_MPL_CORE_PROGRAM_ID[_LOCAL|_DEVNET|_PROD]` (optional)

Defaults by env profile:

- `devnet` -> devnet-fork/mock (`FHqW...`)
- `local` / `prod` -> mainnet programs (`KLend2...`, `FarmsP...`)

You can still use `createCushionSdk(...)` when you want to pass explicit program IDs manually.

If `sender` is omitted, SDK uses `AnchorProviderTxSender`.

## 3) Transaction patterns

Every write operation follows one of these patterns:

- `buildXTx(...)`:
  - returns `{ transaction, signers }`
  - use when you want preview/manual send
- `x(...)`:
  - build + send in one call

Read-only operations are `getX(...)` / `quoteX(...)`.

## 4) Global input limits and local exceptions

On-chain amount args are `u64`. SDK enforces this in `web/src/sdk/core/amounts.ts`.

- Valid range: `0 .. 18446744073709551615`
- Negative values are rejected
- Out-of-range throws:
  - `"<fieldName> is out of u64 range"`

Other local throw cases:

- `Wallet is not connected` (wallet sender)
- `Either position or nftMint must be provided` (`getPosition`)
- `Missing reserve account ...` / `Missing obligation account ...` (resolver fetch)
- `Division by zero` / `Invalid vault share state` (quote math guards)

## 5) Domain APIs and instruction mapping

This section maps each IDL instruction to SDK calls.

## 5.1 Vault domain

Source: `web/src/sdk/domains/vault.ts`

### Read methods

- `getVaultByAssetMint(assetMint)`
- `getVault(vaultAddress)`
- `getUserVaultPosition({ owner?, assetMint })`
- `quoteDeposit({ assetMint, assetsIn })`
- `quoteMint({ assetMint, sharesOut })`
- `quoteWithdraw({ assetMint, assetsOut })`
- `quoteRedeem({ assetMint, sharesIn })`

### Write methods

- `buildDepositTx` / `deposit` -> IDL `deposit`
- `buildMintTx` / `mint` -> IDL `mint`
- `buildWithdrawTx` / `withdraw` -> IDL `withdraw`
- `buildRedeemTx` / `redeem` -> IDL `redeem`

### Inputs and constraints

- `assetsIn`, `sharesOut`, `assetsOut`, `sharesIn`, `minSharesOut`, `maxAssetsIn`, `maxSharesBurn`, `minAssetsOut` must be `u64`.
- Recommended UI rule: always use `quote*` first and pass slippage bounds.

### SDK auto-computes

- Vault PDA from asset mint
- user asset/share ATAs
- ATA create instructions when missing
- account metas for the selected vault

### Common on-chain errors for vault calls

- `ZeroDepositAmount`, `ZeroWithdrawAmount`, `ZeroMintAmount`, `ZeroRedeemAmount`
- `DepositTooSmall`, `DepositCapExceeded`
- `ZeroSharesOut`, `ZeroAssetsOut`
- `MinSharesOutNotMet`, `MaxAssetsInExceeded`, `MinAssetsOutNotMet`, `MaxSharesBurnExceeded`
- `InvalidAssetMint`, `InvalidShareMint`, `InvalidVaultTokenAccount`, `InvalidTreasuryAccount`

## 5.2 Position domain

Source: `web/src/sdk/domains/position.ts`

### Read methods

- `getPosition({ position?, nftMint? })`
- `getPositionRegistryEntryByNftMint(nftMint)`
- `getUserPositions({ owner? })`

### Write methods

- `buildInitPositionTx` / `initPosition` -> IDL `init_position`

### Inputs and constraints

`InitPositionInput`:

- `collection` (required)
- `lendingMarket` (required)
- `klendReserve` (required)
- `reserveFarmState` (required)
- `user?` (defaults to connected wallet)
- `nftMintSigner?` (if omitted, SDK generates a new keypair)

### SDK auto-computes

- `position`, `positionAuthority`
- `positionRegistry`, `positionRegistryEntry`
- KLend PDAs: `klendUserMetadata`, `klendObligation`, `lendingMarketAuthority`
- farm PDA: `obligationFarmUserState`
- `protocolConfig` PDA (`protocol_config_v1`)

### Common on-chain errors

- `Unauthorized`
- `InvalidKaminoUserMetadata`
- `InvalidKaminoObligation`
- `InvalidKaminoLendingMarketAuthority`
- `InvalidKaminoFarmUserState`
- `InvalidPositionNftMint`, `InvalidPositionNftOwner`

## 5.3 Debt domain

Source: `web/src/sdk/domains/debt.ts`

### Read methods

- `getDebtPosition({ position?, positionNftMint? })`

Returns:

- `depositedValueSf`, `debtValueSf`, `allowedBorrowValueSf`, `unhealthyBorrowValueSf`
- derived ratios: `ltvWad`, `maxSafeLtvWad`

### Write methods

- `buildBorrowTx` / `borrow`
  - IDL `increase_debt` or `borrow_asset`
  - selected by `instructionVariant`
- `buildRepayTx` / `repay`
  - IDL `repay_debt`

### Inputs and constraints

- Borrow: `{ positionNftMint, borrowReserve, amount, instructionVariant? }`
- Repay: `{ positionNftMint, repayReserve, amount }`, where `amount` is `bigint | "max"`

Important note for `"max"`:

- SDK passes `u64::MAX` sentinel to program.
- Some market states may behave better with explicit amounts.
- In production UI, consider explicit repay amounts if `"max"` causes downstream KLend edge-case behavior.

### SDK auto-computes

- position + authority PDA
- position-owned and user destination/source liquidity ATAs
- KLend resolver context
- refresh reserve pre-instructions for active obligation reserves
- oracle and remaining accounts
- farm state selection in `debt` mode (`farmKind: "debt"`)
- `protocolConfig` PDA (`protocol_config_v1`)

### Common on-chain errors

- `ZeroDebtAmount`, `ZeroRepayAmount`, `InsufficientRepayLiquidity`
- `UnsafePosition`
- `ReserveAlreadyUsedOnOtherSide`
- `MissingKaminoRefreshReserve`
- `InvalidKaminoObligation`

External program errors can also happen (KLend or token program), for example:

- stale reserve/obligation refresh
- farm account mismatch
- token transfer insufficient funds

## 5.4 Collateral domain

Source: `web/src/sdk/domains/collateral.ts`

### Read methods

- `getCollateralPosition({ position?, positionNftMint? })`

Returns:

- `injected`, `injectedAmount`
- `activeDepositReserves`

### Write methods

- `buildIncreaseCollateralTx` / `increaseCollateral` -> IDL `increase_collateral`
- `buildDecreaseCollateralTx` / `decreaseCollateral` -> IDL `decrease_collateral`

### Inputs and constraints

- `{ positionNftMint, reserve, amount, owner? }`
- `amount` must be `u64`

### SDK auto-computes

- position + authority PDA
- position/user collateral ATAs
- placeholder collateral ATA
- KLend reserve/oracle/remaining accounts
- refresh reserve pre-instructions
- farm state selection in `collateral` mode (`farmKind: "collateral"`)
- `protocolConfig` PDA (`protocol_config_v1`)

### Common on-chain errors

- `InjectedCollateral` (cannot decrease while injected)
- `UnsafeDecreaseCollateral`
- `MissingKaminoRefreshReserve`
- `MarketValueError`, `LtvComputationError`, `LtvCalculationError`

## 6) Instructions outside the business SDK

The following instructions are not wrapped in `web/src/sdk/domains/*` and must not be called from the frontend application.

**Keeper** — executed by the off-chain keeper service:

- `inject_collateral` — injects vault liquidity into an unsafe position to rescue it from liquidation
- `withdraw_injected_collateral` — withdraws previously injected liquidity once the position is safe again

**Admin** — one-time or maintenance operations, run from admin scripts only:

- `init_vault` — creates a new vault for an asset mint
- `update_market_price` — updates the Pyth price feed reference on a vault
- `init_position_registry` — creates the global position registry (once per deployment)
- `init_collection` — creates the MPL Core NFT collection (once per deployment)

**Placeholder** — on-chain no-ops, not ready for use:

- `insure_existing_position`
- `liquidate`

If you need to call any of these from a script, use raw program access: `sdk.context.program.methods.*`

## 7) Full IDL instruction matrix

IDL source: `web/src/generated/cushion/idl.json`

- `borrow_asset(amount: u64)`
- `decrease_collateral(amount: u64)`
- `deposit(assets_in: u64, min_shares_out: u64)`
- `increase_collateral(amount: u64)`
- `increase_debt(amount: u64)`
- `init_collection()`
- `init_position()`
- `init_position_registry()`
- `init_vault(min_deposit: u64, deposit_cap: u64, virtual_assets: u64, virtual_shares: u64)`
- `inject_collateral()`
- `insure_existing_position()` (placeholder context)
- `liquidate()` (placeholder context)
- `mint(shares_out: u64, max_assets_in: u64)`
- `redeem(shares_in: u64, min_assets_out: u64)`
- `repay_debt(amount: u64)`
- `update_market_price(feed_id: [u8; 32])`
- `withdraw(assets_out: u64, max_shares_burn: u64)`
- `withdraw_injected_collateral()`

## 8) Error handling API

Use:

- `mapAnchorError(error)` -> `CushionSdkError`
- `isCushionErrorCode(error, "ErrorName")`

`mapAnchorError` extracts:

- numeric code
- code name
- user-facing message from IDL when available

Example:

```ts
try {
  await sdk.vault.deposit(...);
} catch (e) {
  const mapped = mapAnchorError(e);
  if (mapped.codeName === "DepositCapExceeded") {
    // show UX message
  }
}
```

## 9) Known runtime caveats from integration/smoke runs

- Repay and borrow flows depend on KLend account freshness in the same slot.
- RPC timing may produce temporary read inconsistencies immediately after send.
- `update_market_price` requires a valid Pyth `price_update` account owned by the expected program.
- Placeholder instructions (`insure_existing_position`, `liquidate`) are callable but currently no-op on-chain.

## 10) Practical frontend recommendations

- Always call `quote*` before vault write methods.
- Keep slippage fields explicit and user-configurable.
- For debt flows, start with conservative borrow amounts and increase gradually.
- For repay, allow both explicit amount and "max", but handle fallback in UI if downstream program rules reject edge states.
- Map known `codeName` values to user-friendly messages.

## 11) Additional docs

- Full error catalog: `web/sdk/ERRORS.md`
- Write operations cookbook: `web/sdk/OPERATIONS.md`
- Read/query cookbook (positions, vault balances, debt health, quotes): `web/sdk/QUERIES.md`
