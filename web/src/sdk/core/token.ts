import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, TransactionInstruction, type Connection } from "@solana/web3.js";

export type EnsureAtaResult = {
  ata: PublicKey;
  createInstruction: TransactionInstruction | null;
};

export async function ensureAtaInstruction(params: {
  connection: Connection;
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  allowOwnerOffCurve?: boolean;
  tokenProgramId?: PublicKey;
}): Promise<EnsureAtaResult> {
  const tokenProgramId = params.tokenProgramId ?? TOKEN_PROGRAM_ID;
  const ata = getAssociatedTokenAddressSync(
    params.mint,
    params.owner,
    params.allowOwnerOffCurve ?? false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const info = await params.connection.getAccountInfo(ata, "confirmed");
  if (info) {
    return { ata, createInstruction: null };
  }

  return {
    ata,
    createInstruction: createAssociatedTokenAccountInstruction(
      params.payer,
      ata,
      params.owner,
      params.mint,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
  };
}
