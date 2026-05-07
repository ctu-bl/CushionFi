# Cushion SDK Operations Cookbook (TypeScript)

This page is a practical, code-first guide for **every Cushion operation**.

Style goals:

- quick copy/paste snippets
- clear “what you pass vs what SDK computes”
- both `build*Tx` and direct send patterns

Sources:

- `web/src/sdk/**`
- `web/src/generated/cushion/idl.json`

## Caller conventions

Operations in this document fall into three categories:

- **App** — business SDK methods (`sdk.vault.*`, `sdk.position.*`, `sdk.collateral.*`, `sdk.debt.*`). Use these in the frontend. The SDK handles all PDAs, ATAs, resolver wiring, and pre-instructions automatically.
- **Keeper** — raw program calls executed by the off-chain keeper service, not the user-facing app. Do not call these from the frontend.
- **Admin** — raw program calls for one-time protocol setup or maintenance. Do not call these from the frontend.

## 1) Getting started

## 1.1 Initialize SDK

```ts
import { createCushionSdkFromEnv, WalletAdapterTxSender } from "@/src/sdk";

const sdk = createCushionSdkFromEnv({
  provider, // AnchorProvider
  sender: new WalletAdapterTxSender(provider, wallet),
  borrowInstructionVariant: "increaseDebt", // default behavior
});
```

`createCushionSdkFromEnv` resolves KLend/Farms programs and keeps business calls unchanged for FE callers.
Optional env overrides:

- `NEXT_PUBLIC_KLEND_PROGRAM_ID[_LOCAL|_DEVNET|_PROD]`
- `NEXT_PUBLIC_FARMS_PROGRAM_ID[_LOCAL|_DEVNET|_PROD]`
- `NEXT_PUBLIC_KLEND_FARMS_PROGRAM[_LOCAL|_DEVNET|_PROD]`
- `NEXT_PUBLIC_MPL_CORE_PROGRAM_ID[_LOCAL|_DEVNET|_PROD]`

## 1.2 Error handling helper

```ts
import { mapAnchorError, isCushionErrorCode } from "@/src/sdk";

try {
  // any sdk write call
} catch (e) {
  const err = mapAnchorError(e);
  console.error(err.code, err.codeName, err.message);

  if (isCushionErrorCode(e, "DepositCapExceeded")) {
    // custom UI branch
  }
}
```

## 1.3 Build+send helper

```ts
async function sendBuilt(built: { transaction: Transaction; signers: Signer[] }) {
  return sdk.context.sender.send({
    transaction: built.transaction,
    signers: built.signers,
  });
}
```

## 2) Vault operations

IDL ops: `init_vault`, `deposit`, `mint`, `withdraw`, `redeem`, `update_market_price`

> App operations: `deposit`, `mint`, `withdraw`, `redeem`
> Admin operations: `init_vault`, `update_market_price` — do not use in the frontend.

## 2.1 Get vault by asset mint

```ts
const vault = await sdk.vault.getVaultByAssetMint(assetMint);
```

## 2.2 Get user vault position

```ts
const position = await sdk.vault.getUserVaultPosition({ assetMint });
```

## 2.3 Quote deposit

```ts
const quote = await sdk.vault.quoteDeposit({
  assetMint,
  assetsIn: 1_000_000n,
});
```

## 2.4 Deposit (`deposit`) — App

> Used when a user deposits assets into the vault to earn yield. Always call `quoteDeposit` first to compute `minSharesOut`.

```ts
// Build
const built = await sdk.vault.buildDepositTx({
  assetMint,
  assetsIn: 1_000_000n,
  minSharesOut: 0n,
});

// Send
const signature = await sendBuilt(built);
```

Direct:

```ts
const signature = await sdk.vault.deposit({
  assetMint,
  assetsIn: 1_000_000n,
  minSharesOut: 0n,
});
```

## 2.5 Mint shares (`mint`) — App

> Used when a user wants to receive an exact number of shares. Call `quoteMint` first to determine the required asset input and set `maxAssetsIn` with slippage.

```ts
const quote = await sdk.vault.quoteMint({ assetMint, sharesOut: 1_000n });

const signature = await sdk.vault.mint({
  assetMint,
  sharesOut: 1_000n,
  maxAssetsIn: quote.assets + 1_000n,
});
```

## 2.6 Withdraw assets (`withdraw`) — App

> Used when a user wants to receive an exact asset amount back from the vault. Call `quoteWithdraw` first to determine the share cost and set `maxSharesBurn` with slippage.

```ts
const quote = await sdk.vault.quoteWithdraw({ assetMint, assetsOut: 10_000n });

const signature = await sdk.vault.withdraw({
  assetMint,
  assetsOut: 10_000n,
  maxSharesBurn: quote.shares + 1_000n,
});
```

## 2.7 Redeem shares (`redeem`) — App

> Used when a user wants to burn an exact number of shares and receive the corresponding assets. Call `quoteRedeem` first to compute the expected output and set `minAssetsOut` with slippage.

```ts
const quote = await sdk.vault.quoteRedeem({ assetMint, sharesIn: 1_000n });

const signature = await sdk.vault.redeem({
  assetMint,
  sharesIn: 1_000n,
  minAssetsOut: quote.assets > 0n ? quote.assets - 1n : 0n,
});
```

## 2.8 Init vault (`init_vault`) — Admin

> One-time admin operation to create a new vault for a given asset mint. Not exposed as a business SDK method. Call via `sdk.context.program` from an admin script only.

```ts
import { SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  deriveVaultAddress,
  deriveVaultShareMintAddress,
  deriveVaultTokenAddress,
  deriveVaultTreasuryTokenAddress,
} from "@/src/sdk/core/pda";

const vault = deriveVaultAddress(sdk.context.cushionProgramId, assetMint);
const shareMint = deriveVaultShareMintAddress(sdk.context.cushionProgramId, vault);
const vaultTokenAccount = deriveVaultTokenAddress(sdk.context.cushionProgramId, vault);
const treasuryTokenAccount = deriveVaultTreasuryTokenAddress(sdk.context.cushionProgramId, vault);

const signature = await (sdk.context.program as any).methods
  .initVault(
    new anchor.BN(minDeposit.toString()),
    new anchor.BN(depositCap.toString()),
    new anchor.BN(virtualAssets.toString()),
    new anchor.BN(virtualShares.toString())
  )
  .accountsStrict({
    authority: sdk.context.walletPublicKey,
    assetMint,
    vault,
    shareMint,
    vaultTokenAccount,
    treasuryTokenAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  })
  .rpc();
```

## 2.9 Update market price (`update_market_price`) — Admin

> Admin operation to update the Pyth price feed reference stored on the vault. Requires a valid Pyth `price_update` account. Not exposed as a business SDK method.

```ts
const feedIdBytes32 = Array.from(Buffer.from(feedIdHex.replace(/^0x/, ""), "hex")); // len=32

const signature = await (sdk.context.program as any).methods
  .updateMarketPrice(feedIdBytes32)
  .accounts({
    authority: sdk.context.walletPublicKey,
    vault,
    priceUpdate, // must be a valid Pyth price update account
  })
  .rpc();
```

## 3) Position operations

IDL ops: `init_position_registry`, `init_collection`, `init_position`

> App operations: `init_position`
> Admin operations: `init_position_registry`, `init_collection` — do not use in the frontend.

## 3.1 Init position registry (`init_position_registry`) — Admin

> One-time admin operation to create the global position registry. Must be called once before any position can be opened. Not exposed as a business SDK method.

```ts
import { SystemProgram } from "@solana/web3.js";
import { derivePositionRegistryAddress } from "@/src/sdk/core/pda";

const positionRegistry = derivePositionRegistryAddress(sdk.context.cushionProgramId);

const signature = await (sdk.context.program as any).methods
  .initPositionRegistry()
  .accountsStrict({
    authority: sdk.context.walletPublicKey,
    positionRegistry,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

## 3.2 Init collection (`init_collection`) — Admin

> Admin operation to create the MPL Core collection that groups all Cushion position NFTs. Must exist before the first position is opened. Not exposed as a business SDK method.

```ts
import { Keypair, SystemProgram } from "@solana/web3.js";

const collection = Keypair.generate();
const positionRegistry = sdk.position.derivePositionRegistryAddress();

const signature = await (sdk.context.program as any).methods
  .initCollection()
  .accountsStrict({
    payer: sdk.context.walletPublicKey,
    collection: collection.publicKey,
    positionRegistry,
    systemProgram: SystemProgram.programId,
    mplCoreProgram: sdk.context.config.mplCoreProgramId,
  })
  .signers([collection])
  .rpc();
```

## 3.3 Init position (`init_position`) — App

> Used when a user opens a new position. Creates a position account and mints a position NFT to the user's wallet. The NFT serves as the key for all subsequent collateral and debt operations on that position.

```ts
const signature = await sdk.position.initPosition({
  collection,
  lendingMarket,
  klendReserve,
  reserveFarmState, // this reserve farm state is required by on-chain init flow
});
```

Build form:

```ts
const built = await sdk.position.buildInitPositionTx({
  collection,
  lendingMarket,
  klendReserve,
  reserveFarmState,
});
const signature = await sendBuilt(built);
```

## 3.4 Read position by NFT mint

```ts
const pos = await sdk.position.getPosition({ nftMint: positionNftMint });
```

## 3.5 Read user positions

```ts
const positions = await sdk.position.getUserPositions();
```

## 4) Collateral operations

IDL ops: `increase_collateral`, `decrease_collateral`, `inject_collateral`, `withdraw_injected_collateral`

> App operations: `increase_collateral`, `decrease_collateral`
> Keeper operations: `inject_collateral`, `withdraw_injected_collateral` — executed by the off-chain keeper service only. Do not call these from the frontend.

## 4.1 Increase collateral (`increase_collateral`) — App

> Used when a user adds more collateral to an existing position to reduce its LTV and lower liquidation risk.

```ts
const signature = await sdk.collateral.increaseCollateral({
  positionNftMint,
  reserve: collateralReserve,
  amount: 1_000_000n,
});
```

Build form:

```ts
const built = await sdk.collateral.buildIncreaseCollateralTx({
  positionNftMint,
  reserve: collateralReserve,
  amount: 1_000_000n,
});
const signature = await sendBuilt(built);
```

## 4.2 Decrease collateral (`decrease_collateral`) — App

> Used when a user withdraws part of their collateral from a position. The operation is blocked if it would push the position below the safe LTV threshold or if collateral is currently injected by the keeper.

```ts
const signature = await sdk.collateral.decreaseCollateral({
  positionNftMint,
  reserve: collateralReserve,
  amount: 500_000n,
});
```

## 4.3 Read collateral state

```ts
const state = await sdk.collateral.getCollateralPosition({ positionNftMint });
console.log(state.injected, state.injectedAmount, state.activeDepositReserves);
```

## 4.4 Inject collateral (`inject_collateral`) — Keeper

> Called by the keeper when a position becomes unsafe (LTV too high). The keeper injects vault liquidity as collateral to bring the position back to a safe LTV, protecting it from liquidation. Not exposed as a business SDK method — use raw program access from the keeper service only.

```ts
const position = await sdk.position.getPosition({ nftMint: positionNftMint });
const resolved = await sdk.context.klendResolver.resolveOperation({
  obligation: position.protocolObligation,
  reserve: collateralReserve,
  requireFarmState: true,
  farmKind: "collateral",
});

const signature = await (sdk.context.program as any).methods
  .injectCollateral()
  .accounts({
    // pass accounts based on IDL + resolver
    caller: sdk.context.walletPublicKey,
    position: position.address,
    nftMint: positionNftMint,
    klendObligation: position.protocolObligation,
    klendReserve: resolved.selectedReserve.reserve,
    lendingMarket: resolved.obligationContext.lendingMarket,
    lendingMarketAuthority: resolved.lendingMarketAuthority,
    obligationFarmUserState: resolved.obligationFarmUserState,
    reserveFarmState: resolved.reserveFarmState,
    // plus cushion vault/token/oracle/placeholder accounts
  })
  .remainingAccounts(
    resolved.remainingReserves.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false }))
  )
  .rpc();
```

## 4.5 Withdraw injected collateral (`withdraw_injected_collateral`) — Keeper

> Called by the keeper after a position has been restored to a safe LTV. Withdraws the previously injected vault liquidity back to the vault. Not exposed as a business SDK method — use raw program access from the keeper service only.

```ts
const signature = await (sdk.context.program as any).methods
  .withdrawInjectedCollateral()
  .accounts({
    // same pattern as inject, but withdraw account set from IDL
  })
  .remainingAccounts(
    resolved.remainingReserves.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false }))
  )
  .rpc();
```

## 5) Debt operations

IDL ops: `increase_debt`, `borrow_asset`, `repay_debt`

> App operations: `increase_debt`, `borrow_asset`, `repay_debt`

## 5.1 Read debt/health state

```ts
const debt = await sdk.debt.getDebtPosition({ positionNftMint });
console.log({
  depositedValueSf: debt.depositedValueSf,
  debtValueSf: debt.debtValueSf,
  allowedBorrowValueSf: debt.allowedBorrowValueSf,
  unhealthyBorrowValueSf: debt.unhealthyBorrowValueSf,
  ltvWad: debt.ltvWad,
  maxSafeLtvWad: debt.maxSafeLtvWad,
});
```

## 5.2 Increase debt (`increase_debt`) — App

> Used when a user wants to borrow more against their collateral without receiving the borrowed asset directly. Increases the on-chain debt balance on the KLend obligation.

```ts
const signature = await sdk.debt.borrow({
  positionNftMint,
  borrowReserve: debtReserve,
  amount: 10_000n,
  instructionVariant: "increaseDebt",
});
```

## 5.3 Borrow asset (`borrow_asset`) — App

> Used when a user wants to borrow and receive the asset directly into their wallet. Transfers the borrowed liquidity out of the KLend reserve to the user's token account.

```ts
const signature = await sdk.debt.borrow({
  positionNftMint,
  borrowReserve: debtReserve,
  amount: 10_000n,
  instructionVariant: "borrowAsset",
});
```

## 5.4 Repay debt (`repay_debt`) — App

> Used when a user repays borrowed liquidity back to the KLend reserve. Pass an explicit amount for predictable behavior, or `"max"` to repay the full outstanding debt.

```ts
// explicit amount is generally safest
const signature = await sdk.debt.repay({
  positionNftMint,
  repayReserve: debtReserve,
  amount: 10_000n,
});
```

“Max” mode:

```ts
const signature = await sdk.debt.repay({
  positionNftMint,
  repayReserve: debtReserve,
  amount: "max",
});
```

## 6) Placeholder operations — not for use

IDL ops: `insure_existing_position`, `liquidate`

> These instructions exist on-chain but are currently no-ops. Do not call them from the frontend or the keeper. They are listed here only for completeness.

```ts
await (sdk.context.program as any).methods
  .insureExistingPosition()
  .accounts({ dummy: sdk.context.walletPublicKey })
  .rpc();

await (sdk.context.program as any).methods
  .liquidate()
  .accounts({ dummy: sdk.context.walletPublicKey })
  .rpc();
```

## 7) What SDK computes automatically (summary)

- Cushion PDAs:
  - vault PDAs
  - position PDAs
  - registry PDAs
  - protocol config PDA
- KLend/farms PDAs (where supported in wrappers)
- user ATAs and position-authority ATAs
- missing ATA creation instructions
- remaining account lists for active reserves
- reserve refresh pre-instructions for KLend-sensitive flows

## 8) Common failure patterns and fixes

- `... is out of u64 range`
  - input is negative or > `2^64 - 1`
- `UnsafePosition`
  - reduce borrow amount
- `MissingKaminoRefreshReserve`
  - ensure resolver/remaining accounts include all active reserves
- `AccountOwnedByWrongProgram` on `update_market_price`
  - wrong `price_update` account, must match expected Pyth owner
- `InsufficientRepayLiquidity` / token insufficient funds
  - repay amount too high for current user balance

For full Cushion error list, see `web/sdk/ERRORS.md`.
