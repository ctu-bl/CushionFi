import type { AnchorProvider, Program } from "@coral-xyz/anchor";
import type { Connection, PublicKey } from "@solana/web3.js";

import type { Cushion } from "../../generated/cushion/types.ts";
import { CUSHION_PROGRAM_ID, createCushionProgram } from "../../generated/cushion/program.ts";
import type { KlendResolver } from "../resolvers/klend/types.ts";
import { DefaultKlendResolver } from "../resolvers/klend/default-klend-resolver.ts";
import { AnchorProviderTxSender, type TxSender } from "./tx-sender.ts";

export type BorrowInstructionVariant = "increaseDebt" | "borrowAsset";

export type SdkConfig = {
  klendProgramId: PublicKey;
  farmsProgramId: PublicKey;
  mplCoreProgramId: PublicKey;
  borrowInstructionVariant?: BorrowInstructionVariant;
};

export type CushionSdkContext = {
  provider: AnchorProvider;
  connection: Connection;
  program: Program<Cushion>;
  sender: TxSender;
  walletPublicKey: PublicKey;
  cushionProgramId: PublicKey;
  config: SdkConfig;
  klendResolver: KlendResolver;
};

export type CreateContextInput = {
  provider: AnchorProvider;
  config: SdkConfig;
  sender?: TxSender;
  klendResolver?: KlendResolver;
};

export function createSdkContext(input: CreateContextInput): CushionSdkContext {
  const program = createCushionProgram(input.provider);
  const sender = input.sender ?? new AnchorProviderTxSender(input.provider);
  const walletPublicKey = sender.getPublicKey();

  const klendResolver =
    input.klendResolver ??
    new DefaultKlendResolver(input.provider.connection, input.config.klendProgramId, input.config.farmsProgramId);

  return {
    provider: input.provider,
    connection: input.provider.connection,
    program,
    sender,
    walletPublicKey,
    cushionProgramId: CUSHION_PROGRAM_ID,
    config: {
      ...input.config,
      borrowInstructionVariant: input.config.borrowInstructionVariant ?? "increaseDebt",
    },
    klendResolver,
  };
}
