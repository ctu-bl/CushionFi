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

export type CushionSdkFromEnvConfig = {
  provider: AnchorProvider;
  mplCoreProgramId?: PublicKey;
  borrowInstructionVariant?: BorrowInstructionVariant;
  sender?: TxSender;
  klendResolver?: KlendResolver;
  env?: Record<string, string | undefined>;
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
export const DEFAULT_MAINNET_KLEND_PROGRAM_ID = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);
export const DEFAULT_MAINNET_FARMS_PROGRAM_ID = new PublicKey(
  "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr"
);
export const DEFAULT_DEVNET_FORK_KLEND_PROGRAM_ID = new PublicKey(
  "FHqW31mKXKPQqrHYYmGKcUGM5q8EF8SPeU3axkNG6bxe"
);
export const DEFAULT_DEVNET_FORK_FARMS_PROGRAM_ID = DEFAULT_DEVNET_FORK_KLEND_PROGRAM_ID;

function normalizeAppEnv(value: string | undefined): "local" | "devnet" | "prod" {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "local";
  if (normalized === "test") return "devnet";
  if (normalized === "production" || normalized === "mainnet" || normalized === "prod") return "prod";
  if (normalized === "localhost" || normalized === "localnet" || normalized === "local") return "local";
  if (normalized === "devnet") return "devnet";
  return "local";
}

function getScopedEnvValue(
  env: Record<string, string | undefined>,
  baseName: string,
  appEnv: "local" | "devnet" | "prod"
): string | undefined {
  const suffixes = appEnv === "devnet" ? ["DEVNET", "TEST"] : [appEnv.toUpperCase()];
  for (const suffix of suffixes) {
    const value = env[`${baseName}_${suffix}`]?.trim();
    if (value) return value;
  }
  return env[baseName]?.trim() || undefined;
}

function resolveProgramDefaultsByEnv(appEnv: "local" | "devnet" | "prod"): {
  klendProgramId: PublicKey;
  farmsProgramId: PublicKey;
} {
  // Devnet profile defaults to the mock/fork setup used in this repository.
  if (appEnv === "devnet") {
    return {
      klendProgramId: DEFAULT_DEVNET_FORK_KLEND_PROGRAM_ID,
      farmsProgramId: DEFAULT_DEVNET_FORK_FARMS_PROGRAM_ID,
    };
  }
  // Local/prod defaults to mainnet program IDs.
  return {
    klendProgramId: DEFAULT_MAINNET_KLEND_PROGRAM_ID,
    farmsProgramId: DEFAULT_MAINNET_FARMS_PROGRAM_ID,
  };
}

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

export function createCushionSdkFromEnv(config: CushionSdkFromEnvConfig): CushionSdk {
  const env =
    config.env ??
    (((globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
      {}) as Record<string, string | undefined>);
  const appEnv = normalizeAppEnv(
    env.NEXT_PUBLIC_APP_ENV ?? env.NEXT_PUBLIC_ENVIRONMENT ?? env.APP_ENV
  );
  const defaults = resolveProgramDefaultsByEnv(appEnv);

  const klendProgramId = new PublicKey(
    getScopedEnvValue(env, "NEXT_PUBLIC_KLEND_PROGRAM_ID", appEnv) ??
      getScopedEnvValue(env, "KLEND_PROGRAM_ID", appEnv) ??
      defaults.klendProgramId.toBase58()
  );
  const farmsProgramId = new PublicKey(
    getScopedEnvValue(env, "NEXT_PUBLIC_FARMS_PROGRAM_ID", appEnv) ??
      getScopedEnvValue(env, "NEXT_PUBLIC_KLEND_FARMS_PROGRAM", appEnv) ??
      getScopedEnvValue(env, "KLEND_FARMS_PROGRAM", appEnv) ??
      getScopedEnvValue(env, "KEEPER_FARMS_PROGRAM_ID", appEnv) ??
      defaults.farmsProgramId.toBase58()
  );
  const mplCoreProgramId = new PublicKey(
    getScopedEnvValue(env, "NEXT_PUBLIC_MPL_CORE_PROGRAM_ID", appEnv) ??
      getScopedEnvValue(env, "MPL_CORE_PROGRAM_ID", appEnv) ??
      DEFAULT_MPL_CORE_PROGRAM_ID.toBase58()
  );

  return createCushionSdk({
    provider: config.provider,
    klendProgramId,
    farmsProgramId,
    mplCoreProgramId: config.mplCoreProgramId ?? mplCoreProgramId,
    borrowInstructionVariant: config.borrowInstructionVariant,
    sender: config.sender,
    klendResolver: config.klendResolver,
  });
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
