import { Transaction, type ConfirmOptions, type Signer, type TransactionSignature } from "@solana/web3.js";

import type { CushionSdkContext } from "./context.ts";
import { mapAnchorError } from "./errors.ts";

export type BuiltTx = {
  transaction: Transaction;
  signers: Signer[];
};

export async function buildTransaction(params: {
  context: CushionSdkContext;
  methodBuilder: { transaction: () => Promise<Transaction> };
  preInstructions?: Transaction["instructions"];
  signers?: Signer[];
}): Promise<BuiltTx> {
  const anchorTx = await params.methodBuilder.transaction();
  const transaction = new Transaction();

  for (const ix of params.preInstructions ?? []) {
    transaction.add(ix);
  }
  for (const ix of anchorTx.instructions) {
    transaction.add(ix);
  }

  transaction.feePayer = params.context.walletPublicKey;

  return {
    transaction,
    signers: params.signers ?? [],
  };
}

export async function sendBuiltTransaction(
  context: CushionSdkContext,
  built: BuiltTx,
  options?: ConfirmOptions
): Promise<TransactionSignature> {
  try {
    return await context.sender.send({
      transaction: built.transaction,
      signers: built.signers,
      options,
    });
  } catch (error) {
    throw mapAnchorError(error);
  }
}
