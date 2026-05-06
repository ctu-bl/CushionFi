import { PublicKey } from "@solana/web3.js";
import type { AnchorProvider } from "@coral-xyz/anchor";

import { createCollateralDomain } from "./domains/collateral.ts";
import { createDebtDomain } from "./domains/debt.ts";
import { createPositionDomain } from "./domains/position.ts";
import { createVaultDomain } from "./domains/vault.ts";
import { createSdkContext, type BorrowInstructionVariant, type CushionSdkContext } from "./core/context.ts";
import type { TxSender } from "./core/tx-sender.ts";
import {
  AnchorProviderTxSender,
  WalletAdapterTxSender,
  type WalletAdapterLike,
} from "./core/tx-sender.ts";
import { DefaultKlendResolver } from "./resolvers/klend/default-klend-resolver.ts";
import type { KlendResolver } from "./resolvers/klend/types.ts";

export type CushionSdkConfig = {
  provider: AnchorProvider;
  klendProgramId: PublicKey;
  farmsProgramId: PublicKey;
  mplCoreProgramId?: PublicKey;
  borrowInstructionVariant?: BorrowInstructionVariant;
  sender?: TxSender;
  klendResolver?: KlendResolver;
};

export type CushionSdk = {
  context: CushionSdkContext;
  vault: ReturnType<typeof createVaultDomain>;
  position: ReturnType<typeof createPositionDomain>;
  debt: ReturnType<typeof createDebtDomain>;
  collateral: ReturnType<typeof createCollateralDomain>;
};

export const DEFAULT_MPL_CORE_PROGRAM_ID = new PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
);

export function createCushionSdk(config: CushionSdkConfig): CushionSdk {
  const context = createSdkContext({
    provider: config.provider,
    config: {
      klendProgramId: config.klendProgramId,
      farmsProgramId: config.farmsProgramId,
      mplCoreProgramId: config.mplCoreProgramId ?? DEFAULT_MPL_CORE_PROGRAM_ID,
      borrowInstructionVariant: config.borrowInstructionVariant,
    },
    sender: config.sender,
    klendResolver: config.klendResolver,
  });

  return {
    context,
    vault: createVaultDomain(context),
    position: createPositionDomain(context),
    debt: createDebtDomain(context),
    collateral: createCollateralDomain(context),
  };
}

export {
  createSdkContext,
  AnchorProviderTxSender,
  WalletAdapterTxSender,
  DefaultKlendResolver,
};

export type { WalletAdapterLike, TxSender, KlendResolver, BorrowInstructionVariant };

export * from "./core/errors.ts";
export * from "./core/amounts.ts";
export * from "./resolvers/klend/types.ts";
