# Cushion SDK Queries Cookbook (TypeScript)

This page covers all read-only SDK methods — fetching on-chain state, computing quotes, and building user-facing views such as position dashboards, vault balances, and health indicators.

All methods here are **App** operations. They make no on-chain writes and require no wallet signature.

Sources:

- `web/src/sdk/domains/vault.ts`
- `web/src/sdk/domains/position.ts`
- `web/src/sdk/domains/debt.ts`
- `web/src/sdk/domains/collateral.ts`

---

## 1) Vault queries

### 1.1 Get vault by asset mint

> Fetches the full on-chain vault state for a given asset. Use this to display vault-level info such as total managed assets, deposit cap, interest rate, or current market price.

```ts
const vault = await sdk.vault.getVaultByAssetMint(assetMint);

console.log({
  totalManagedAssets: vault.totalManagedAssets, // bigint, raw token units
  depositCap:         vault.depositCap,
  minDeposit:         vault.minDeposit,
  marketPrice:        vault.marketPrice,
  interestRate:       vault.interestRate,
  accumulatedInterest: vault.accumulatedInterest,
});
```

Returned type: `VaultState`

| Field | Type | Description |
|-------|------|-------------|
| `address` | `PublicKey` | On-chain vault PDA |
| `authority` | `PublicKey` | Vault admin authority |
| `assetMint` | `PublicKey` | Underlying asset mint |
| `shareMint` | `PublicKey` | Vault share token mint |
| `vaultTokenAccount` | `PublicKey` | Vault's token account holding assets |
| `treasuryTokenAccount` | `PublicKey` | Treasury fee receiver |
| `totalManagedAssets` | `bigint` | Total assets under management |
| `minDeposit` | `bigint` | Minimum deposit enforced on-chain |
| `depositCap` | `bigint` | Maximum total deposits allowed |
| `virtualAssets` | `bigint` | ERC-4626 virtual offset for share math |
| `virtualShares` | `bigint` | ERC-4626 virtual offset for share math |
| `marketPrice` | `bigint` | Last recorded Pyth price |
| `marketPriceLastUpdated` | `bigint` | Unix timestamp of last price update |
| `interestRate` | `bigint` | Current interest rate |
| `accumulatedInterest` | `bigint` | Total interest accrued |

### 1.2 Get vault by address

> Fetches vault state when you already know the vault PDA. Equivalent to `getVaultByAssetMint` but skips the PDA derivation step.

```ts
const vault = await sdk.vault.getVault(vaultAddress);
```

### 1.3 Get user vault position

> Returns the connected user's asset and share balances for a given vault. Use this to display how much a user has deposited and how many shares they hold.

```ts
const position = await sdk.vault.getUserVaultPosition({ assetMint });
// or for another owner:
const position = await sdk.vault.getUserVaultPosition({ assetMint, owner: somePublicKey });

console.log({
  userAssetBalance: position.userAssetBalance, // raw token units, bigint
  userShareBalance: position.userShareBalance,
  userAssetAccount: position.userAssetAccount, // ATA address
  userShareAccount: position.userShareAccount,
});
```

Returned type: `UserVaultPosition`

| Field | Type | Description |
|-------|------|-------------|
| `owner` | `PublicKey` | Account owner |
| `assetMint` | `PublicKey` | Underlying asset mint |
| `shareMint` | `PublicKey` | Share token mint |
| `userAssetAccount` | `PublicKey` | User's asset ATA |
| `userShareAccount` | `PublicKey` | User's share ATA |
| `userAssetBalance` | `bigint` | Current asset token balance |
| `userShareBalance` | `bigint` | Current share token balance |

---

## 2) Vault quotes

All quote methods compute expected amounts client-side using the same math as the on-chain program. Always pass quote results into the corresponding write method with a slippage buffer.

Returned type for all quotes: `VaultQuote`

| Field | Type | Description |
|-------|------|-------------|
| `assets` | `bigint` | Asset amount in raw token units |
| `shares` | `bigint` | Share amount in raw token units |

### 2.1 Quote deposit

> Computes how many shares the user would receive for a given asset input. Pass `quote.shares` as `minSharesOut` when calling `deposit`.

```ts
const quote = await sdk.vault.quoteDeposit({ assetMint, assetsIn: 1_000_000n });
console.log(quote.shares); // expected shares out
```

### 2.2 Quote mint

> Computes how many assets are required to mint an exact number of shares. Pass `quote.assets + slippage` as `maxAssetsIn` when calling `mint`.

```ts
const quote = await sdk.vault.quoteMint({ assetMint, sharesOut: 1_000n });
console.log(quote.assets); // assets needed (rounded up)
```

### 2.3 Quote withdraw

> Computes how many shares must be burned to withdraw an exact asset amount. Pass `quote.shares + slippage` as `maxSharesBurn` when calling `withdraw`.

```ts
const quote = await sdk.vault.quoteWithdraw({ assetMint, assetsOut: 500_000n });
console.log(quote.shares); // shares that will be burned (rounded up)
```

### 2.4 Quote redeem

> Computes how many assets the user would receive for burning a given number of shares. Pass `quote.assets - slippage` as `minAssetsOut` when calling `redeem`.

```ts
const quote = await sdk.vault.quoteRedeem({ assetMint, sharesIn: 1_000n });
console.log(quote.assets); // expected assets out (rounded down)
```

---

## 3) Position queries

### 3.1 Get all positions for the connected user

> Returns all open positions owned by the connected wallet. Use this as the entry point for a user's position dashboard — iterate the result and call `getDebtPosition` / `getCollateralPosition` for each.

```ts
const positions = await sdk.position.getUserPositions();
// or for another owner:
const positions = await sdk.position.getUserPositions({ owner: somePublicKey });
```

Returned type: `PositionState[]`

| Field | Type | Description |
|-------|------|-------------|
| `address` | `PublicKey` | On-chain position PDA |
| `nftMint` | `PublicKey` | Position NFT mint — the key for all position operations |
| `positionAuthority` | `PublicKey` | PDA that owns position token accounts |
| `owner` | `PublicKey` | Wallet that owns the NFT |
| `borrower` | `PublicKey` | Wallet that opened the position |
| `protocolObligation` | `PublicKey` | Underlying KLend obligation |
| `protocolUserMetadata` | `PublicKey` | KLend user metadata |
| `collateralVault` | `PublicKey` | Vault address used as collateral source |
| `injectedAmount` | `bigint` | Amount currently injected by the keeper (0 if not injected) |
| `injected` | `boolean` | Whether keeper collateral is currently active |
| `bump` | `number` | PDA bump |

### 3.2 Get a single position

> Fetches one position by its NFT mint or by the position PDA address directly.

```ts
const pos = await sdk.position.getPosition({ nftMint: positionNftMint });
// or:
const pos = await sdk.position.getPosition({ position: positionAddress });
```

### 3.3 Get position registry entry by NFT mint

> Fetches the registry entry for a given position NFT. Useful for looking up creation timestamp and canonical addresses without fetching the full position account.

```ts
const entry = await sdk.position.getPositionRegistryEntryByNftMint(positionNftMint);

console.log({
  createdAt:         entry.createdAt,         // Unix timestamp as bigint
  position:          entry.position,
  positionAuthority: entry.positionAuthority,
  borrower:          entry.borrower,
});
```

Returned type: `PositionRegistryEntryState`

| Field | Type | Description |
|-------|------|-------------|
| `address` | `PublicKey` | Registry entry PDA |
| `nftMint` | `PublicKey` | Position NFT mint |
| `position` | `PublicKey` | Position account PDA |
| `positionAuthority` | `PublicKey` | Position authority PDA |
| `borrower` | `PublicKey` | Wallet that opened the position |
| `createdAt` | `bigint` | Unix timestamp of position creation |
| `bump` | `number` | PDA bump |

---

## 4) Debt queries

### 4.1 Get debt and health state

> Returns the full debt health snapshot for a position. Use this to display borrowed value, collateral value, current LTV, and how close the position is to liquidation.

```ts
const debt = await sdk.debt.getDebtPosition({ positionNftMint });
// or by position address:
const debt = await sdk.debt.getDebtPosition({ position: positionAddress });

console.log({
  depositedValueSf:       debt.depositedValueSf,       // collateral value, scaled by 2^48
  debtValueSf:            debt.debtValueSf,            // borrow-factor-adjusted debt value, scaled by 2^48
  allowedBorrowValueSf:   debt.allowedBorrowValueSf,   // max safe borrow value, scaled by 2^48
  unhealthyBorrowValueSf: debt.unhealthyBorrowValueSf, // liquidation threshold, scaled by 2^48
  ltvWad:                 debt.ltvWad,                 // current LTV as WAD (1e18 = 100%), null if no collateral
  maxSafeLtvWad:          debt.maxSafeLtvWad,          // safe LTV limit as WAD, null if no collateral
});
```

Returned type: `DebtPosition`

| Field | Type | Description |
|-------|------|-------------|
| `position` | `PublicKey` | Position account PDA |
| `protocolObligation` | `PublicKey` | Underlying KLend obligation |
| `depositedValueSf` | `bigint` | Total collateral value (scaled factor, ÷ 2^48 for USD) |
| `debtValueSf` | `bigint` | Borrow-factor-adjusted debt value (scaled factor) |
| `allowedBorrowValueSf` | `bigint` | Maximum borrow value before position becomes unsafe |
| `unhealthyBorrowValueSf` | `bigint` | Borrow value threshold for liquidation |
| `ltvWad` | `bigint \| null` | Current LTV as WAD (1e18 = 100%). `null` when no collateral deposited |
| `maxSafeLtvWad` | `bigint \| null` | Maximum safe LTV as WAD. `null` when no collateral deposited |

> **Scaled factor note:** `*Sf` fields use KLend's internal scaled-factor representation. Divide by `2 ** 48` to get the approximate USD value.

> **WAD note:** `ltvWad` and `maxSafeLtvWad` use WAD (1e18 = 1.0). To display as percentage: `Number(ltvWad) / 1e18 * 100`.

**Example: render position health**

```ts
const debt = await sdk.debt.getDebtPosition({ positionNftMint });

if (debt.ltvWad === null) {
  // no collateral yet
} else {
  const ltvPct = Number(debt.ltvWad) / 1e18 * 100;
  const maxSafeLtvPct = Number(debt.maxSafeLtvWad!) / 1e18 * 100;
  const utilizationPct = (ltvPct / maxSafeLtvPct) * 100;

  console.log(`LTV: ${ltvPct.toFixed(2)}% / ${maxSafeLtvPct.toFixed(2)}% (${utilizationPct.toFixed(1)}% of limit)`);
}
```

---

## 5) Collateral queries

### 5.1 Get collateral state

> Returns the collateral state for a position, including whether keeper collateral is currently injected and which KLend reserves are active as deposits.

```ts
const col = await sdk.collateral.getCollateralPosition({ positionNftMint });
// or by position address:
const col = await sdk.collateral.getCollateralPosition({ position: positionAddress });

console.log({
  injected:              col.injected,              // true if keeper has injected collateral
  injectedAmount:        col.injectedAmount,        // bigint, raw token units
  activeDepositReserves: col.activeDepositReserves, // PublicKey[] of active KLend reserves
});
```

Returned type: `CollateralPosition`

| Field | Type | Description |
|-------|------|-------------|
| `position` | `PublicKey` | Position account PDA |
| `protocolObligation` | `PublicKey` | Underlying KLend obligation |
| `injected` | `boolean` | Whether keeper collateral is currently active |
| `injectedAmount` | `bigint` | Amount injected by keeper (0 if not injected) |
| `activeDepositReserves` | `PublicKey[]` | KLend reserves currently used as collateral deposits |

> If `injected` is `true`, the user cannot decrease collateral until the keeper withdraws the injected amount.

---

## 6) Typical user dashboard flow

```ts
// 1. fetch all positions
const positions = await sdk.position.getUserPositions();

// 2. for each position, fetch health and collateral state in parallel
const views = await Promise.all(
  positions.map(async (pos) => {
    const [debt, collateral] = await Promise.all([
      sdk.debt.getDebtPosition({ positionNftMint: pos.nftMint }),
      sdk.collateral.getCollateralPosition({ positionNftMint: pos.nftMint }),
    ]);
    return { pos, debt, collateral };
  })
);

// 3. for each vault the user has deposited into, fetch vault position
const vaultPosition = await sdk.vault.getUserVaultPosition({ assetMint });
```
