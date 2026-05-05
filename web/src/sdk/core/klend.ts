import { PublicKey, TransactionInstruction } from "@solana/web3.js";

import type { KlendReserveRefreshContext } from "../resolvers/klend/types.ts";

const REFRESH_RESERVE_DISCRIMINATOR = Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]);

function optionalOrPlaceholder(value: PublicKey | null, placeholder: PublicKey): PublicKey {
  return value ?? placeholder;
}

export function createKlendRefreshReserveInstruction(params: {
  klendProgramId: PublicKey;
  lendingMarket: PublicKey;
  reserve: KlendReserveRefreshContext;
}): TransactionInstruction {
  const placeholder = params.klendProgramId;
  return new TransactionInstruction({
    programId: params.klendProgramId,
    keys: [
      { pubkey: params.reserve.reserve, isSigner: false, isWritable: true },
      { pubkey: params.lendingMarket, isSigner: false, isWritable: false },
      {
        pubkey: optionalOrPlaceholder(params.reserve.pythOracle, placeholder),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: optionalOrPlaceholder(params.reserve.switchboardPriceOracle, placeholder),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: optionalOrPlaceholder(params.reserve.switchboardTwapOracle, placeholder),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: optionalOrPlaceholder(params.reserve.scopePrices, placeholder),
        isSigner: false,
        isWritable: false,
      },
    ],
    data: REFRESH_RESERVE_DISCRIMINATOR,
  });
}

export function createKlendRefreshReserveInstructions(params: {
  klendProgramId: PublicKey;
  lendingMarket: PublicKey;
  refreshReserves: KlendReserveRefreshContext[];
  excludeReserve?: PublicKey;
}): TransactionInstruction[] {
  return params.refreshReserves
    .filter((entry) => !(params.excludeReserve && entry.reserve.equals(params.excludeReserve)))
    .map((entry) =>
      createKlendRefreshReserveInstruction({
        klendProgramId: params.klendProgramId,
        lendingMarket: params.lendingMarket,
        reserve: entry,
      })
    );
}
