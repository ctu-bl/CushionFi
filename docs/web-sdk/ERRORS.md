# Cushion Error Catalog

Source: `web/src/generated/cushion/idl.json`

| Code | Name | Message |
| --- | --- | --- |
| 6000 | Unauthorized | Unauthorized |
| 6001 | Overflow | Overflow |
| 6002 | ZeroCollateralAmount | Collateral amount can't be zero when creating the position |
| 6003 | ZeroDebtAmount | Debt amount can't be zero |
| 6004 | ZeroRepayAmount | Amount for repaying can't be zero |
| 6005 | UnsafePosition | Position is too close to liquidation and cannot be insured |
| 6006 | ZeroDepositAmount | Deposit amount cannot be zero |
| 6007 | ZeroWithdrawAmount | Withdraw amount cannot be zero |
| 6008 | ZeroMintAmount | Mint amount cannot be zero |
| 6009 | ZeroRedeemAmount | Redeem amount cannot be zero |
| 6010 | VaultPaused | Vault is paused |
| 6011 | WithdrawalsPaused | Withdrawals are paused |
| 6012 | DepositTooSmall | Deposit amount is below vault minimum |
| 6013 | DepositCapExceeded | Vault deposit cap exceeded |
| 6014 | ZeroSharesOut | Share output rounded down to zero |
| 6015 | ZeroAssetsOut | Asset output rounded down to zero |
| 6016 | InsufficientVaultLiquidity | Vault does not have enough idle liquidity |
| 6017 | InsufficientRepayLiquidity | Insufficient liquidity in user's source account |
| 6018 | InvalidAssetMint | Invalid asset mint account |
| 6019 | InvalidShareMint | Invalid share mint account |
| 6020 | InvalidVaultTokenAccount | Invalid vault token account |
| 6021 | InvalidTreasuryAccount | Invalid treasury token account |
| 6022 | InvalidDepositCap | Invalid deposit cap configuration |
| 6023 | DivisionByZero | Division by zero |
| 6024 | CastError | Cast error |
| 6025 | StalePythPrice | Pyth price is stale or unavailable |
| 6026 | InvalidPythPrice | Pyth price is negative or zero |
| 6027 | MinSharesOutNotMet | Slippage: min shares out not met |
| 6028 | MaxAssetsInExceeded | Slippage: max assets in exceeded |
| 6029 | MinAssetsOutNotMet | Slippage: min assets out not met |
| 6030 | MaxSharesBurnExceeded | Slippage: max shares burn exceeded |
| 6031 | InvalidKaminoProgram | Invalid Kamino program account |
| 6032 | InvalidKaminoUserMetadata | Invalid Kamino user metadata PDA |
| 6033 | InvalidKaminoObligation | Invalid Kamino obligation PDA |
| 6034 | InvalidKaminoLendingMarketAuthority | Invalid Kamino lending market authority PDA |
| 6035 | InvalidKaminoFarmUserState | Invalid Kamino farm user state PDA |
| 6036 | InvalidPositionNftMint | Invalid NFT token account mint for Cushion position |
| 6037 | InvalidPositionNftOwner | NFT token account owner must match signer |
| 6038 | ReserveAlreadyUsedOnOtherSide | Reserve is already used as a borrow on this obligation |
| 6039 | MissingKaminoRefreshReserve | A required Kamino reserve account is missing from remaining accounts |
| 6040 | InjectedCollateral | Position has injected collateral and cannot be decreased |
| 6041 | MarketValueError | Failed to compute market value from reserve data |
| 6042 | LtvComputationError | Failed to compute potential LTV |
| 6043 | UnsafeDecreaseCollateral | Collateral decrease would put position below safe LTV threshold |
| 6044 | DeserializationError | Failed to deserialize account data |
| 6045 | AlreadyInjected | Position already has injected collateral |
| 6046 | NotUnsafePosition | Position is not unsafe, injection failed |
| 6047 | InjectCalculationError | Amount to inject calculation failed |
| 6048 | LtvCalculationError | Calculation of current LTV failed |
| 6049 | ZeroPrice | Price of the asset in vault is zero |
| 6050 | InsuringThresholdError | Computation of insuring LTV threshold failed |
| 6051 | NotInjected | Position doesn't have any injected collateral |
| 6052 | WithdrawingThresholdError | Computation of withdrawing LTV threshold failed |
| 6053 | NotYetSafePosition | Position is not safe enough, withdrawal failed |
| 6054 | WithdrawAmountCalculationError | Computation of amount to withdraw failed |
| 6055 | InterestCalculationError | Computation of accumulated interest failed |
| 6056 | WithdrawAmountIsZero | Withdraw amount cannot be zero |
| 6057 | WithdrawValueError | Calculation of withdraw value failed |

Use in frontend:

```ts
import { mapAnchorError, isCushionErrorCode } from "@/src/sdk";

try {
  // sdk call
} catch (e) {
  const mapped = mapAnchorError(e);
  console.log(mapped.code, mapped.codeName, mapped.message);

  if (isCushionErrorCode(e, "DepositCapExceeded")) {
    // handle specific error
  }
}
```
