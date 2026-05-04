import { PublicKey } from "@solana/web3.js";

export type KeeperMode = "localnet_static" | "dynamic";

export type ComputeJob =
  | {
      kind: "full_rescan";
      reason: string;
    }
  | {
      kind: "position_changed";
      position: string;
      reason: string;
    }
  | {
      kind: "price_changed";
      reserve: string;
      previousPriceSf: bigint;
      nextPriceSf: bigint;
    };

export type ExecuteJob = {
  kind: "inject" | "withdraw";
  position: string;
  reason: string;
  dedupeKey: string;
};

export type CushionPosition = {
  position: string;
  nftMint: string;
  positionAuthority: string;
  owner: string;
  borrower: string;
  protocolObligation: string;
  protocolUserMetadata: string;
  collateralVault: string;
  injectedAmount: bigint;
  injected: boolean;
  bump: number;
  updatedAtSlot: number;
};

export type PositionRiskSnapshot = {
  position: string;
  protocolObligation: string;
  depositedValueSf: bigint;
  debtValueSf: bigint;
  unhealthyBorrowValueSf: bigint;
  ltvWad: bigint | null;
  maxSafeLtvWad: bigint | null;
  refreshedAtSlot: number;
  refreshedAtUnixMs: number;
};

export type ReservePriceSnapshot = {
  reserve: string;
  marketPriceSf: bigint;
  mintDecimals: number;
  lastUpdatedTs: bigint;
  pythOracle: string | null;
  switchboardPriceOracle: string | null;
  switchboardTwapOracle: string | null;
  scopePrices: string | null;
  slot: number;
};

export type KeeperContext = {
  programId: PublicKey;
  authority: PublicKey;
};
