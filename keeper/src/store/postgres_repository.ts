import { Pool } from "pg";

import type { CushionPosition, PositionRiskSnapshot } from "../types.ts";
import type { KeeperRepository } from "./repository.ts";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS keeper_positions (
  position TEXT PRIMARY KEY,
  nft_mint TEXT NOT NULL,
  position_authority TEXT NOT NULL,
  owner TEXT NOT NULL,
  borrower TEXT NOT NULL,
  protocol_obligation TEXT NOT NULL,
  protocol_user_metadata TEXT NOT NULL,
  collateral_vault TEXT NOT NULL,
  inject_threshold_wad NUMERIC(39, 0) NOT NULL,
  injected BOOLEAN NOT NULL,
  bump SMALLINT NOT NULL,
  updated_at_slot BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE keeper_positions
  ADD COLUMN IF NOT EXISTS injected_amount NUMERIC(39, 0) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS keeper_position_risk (
  position TEXT PRIMARY KEY REFERENCES keeper_positions(position) ON DELETE CASCADE,
  protocol_obligation TEXT NOT NULL,
  deposited_value_sf NUMERIC(39, 0) NOT NULL,
  debt_value_sf NUMERIC(39, 0) NOT NULL,
  unhealthy_borrow_value_sf NUMERIC(39, 0) NOT NULL,
  ltv_wad NUMERIC(39, 0),
  max_safe_ltv_wad NUMERIC(39, 0),
  refreshed_at_slot BIGINT NOT NULL,
  refreshed_at_unix_ms BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

type PositionRow = {
  position: string;
  nft_mint: string;
  position_authority: string;
  owner: string;
  borrower: string;
  protocol_obligation: string;
  protocol_user_metadata: string;
  collateral_vault: string;
  injected_amount: string;
  injected: boolean;
  bump: number;
  updated_at_slot: string;
};

type RiskRow = {
  position: string;
  protocol_obligation: string;
  deposited_value_sf: string;
  debt_value_sf: string;
  unhealthy_borrow_value_sf: string;
  ltv_wad: string | null;
  max_safe_ltv_wad: string | null;
  refreshed_at_slot: string;
  refreshed_at_unix_ms: string;
};

export class PostgresKeeperRepository implements KeeperRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
    });
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async listPositions(): Promise<CushionPosition[]> {
    const { rows } = await this.pool.query<PositionRow>(
      `SELECT * FROM keeper_positions ORDER BY updated_at_slot DESC, position ASC`
    );
    return rows.map(mapPositionRow);
  }

  async getPosition(position: string): Promise<CushionPosition | null> {
    const { rows } = await this.pool.query<PositionRow>(
      `SELECT * FROM keeper_positions WHERE position = $1 LIMIT 1`,
      [position]
    );

    if (rows.length === 0) {
      return null;
    }

    return mapPositionRow(rows[0]);
  }

  async upsertPositions(positions: CushionPosition[]): Promise<void> {
    if (positions.length === 0) {
      return;
    }

    for (const position of positions) {
      await this.pool.query(
        `
          INSERT INTO keeper_positions (
            position,
            nft_mint,
            position_authority,
            owner,
            borrower,
            protocol_obligation,
            protocol_user_metadata,
            collateral_vault,
            inject_threshold_wad,
            injected_amount,
            injected,
            bump,
            updated_at_slot,
            updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()
          )
          ON CONFLICT (position)
          DO UPDATE SET
            nft_mint = EXCLUDED.nft_mint,
            position_authority = EXCLUDED.position_authority,
            owner = EXCLUDED.owner,
            borrower = EXCLUDED.borrower,
            protocol_obligation = EXCLUDED.protocol_obligation,
            protocol_user_metadata = EXCLUDED.protocol_user_metadata,
            collateral_vault = EXCLUDED.collateral_vault,
            injected_amount = EXCLUDED.injected_amount,
            inject_threshold_wad = EXCLUDED.inject_threshold_wad,
            injected = EXCLUDED.injected,
            bump = EXCLUDED.bump,
            updated_at_slot = EXCLUDED.updated_at_slot,
            updated_at = NOW()
        `,
        [
          position.position,
          position.nftMint,
          position.positionAuthority,
          position.owner,
          position.borrower,
          position.protocolObligation,
          position.protocolUserMetadata,
          position.collateralVault,
          "0",
          position.injectedAmount.toString(),
          position.injected,
          position.bump,
          position.updatedAtSlot,
        ]
      );
    }
  }

  async deletePositions(positionPubkeys: string[]): Promise<void> {
    if (positionPubkeys.length === 0) {
      return;
    }

    await this.pool.query(`DELETE FROM keeper_positions WHERE position = ANY($1::text[])`, [
      positionPubkeys,
    ]);
  }

  async saveRiskSnapshot(snapshot: PositionRiskSnapshot): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO keeper_position_risk (
          position,
          protocol_obligation,
          deposited_value_sf,
          debt_value_sf,
          unhealthy_borrow_value_sf,
          ltv_wad,
          max_safe_ltv_wad,
          refreshed_at_slot,
          refreshed_at_unix_ms,
          updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()
        )
        ON CONFLICT (position)
        DO UPDATE SET
          protocol_obligation = EXCLUDED.protocol_obligation,
          deposited_value_sf = EXCLUDED.deposited_value_sf,
          debt_value_sf = EXCLUDED.debt_value_sf,
          unhealthy_borrow_value_sf = EXCLUDED.unhealthy_borrow_value_sf,
          ltv_wad = EXCLUDED.ltv_wad,
          max_safe_ltv_wad = EXCLUDED.max_safe_ltv_wad,
          refreshed_at_slot = EXCLUDED.refreshed_at_slot,
          refreshed_at_unix_ms = EXCLUDED.refreshed_at_unix_ms,
          updated_at = NOW()
      `,
      [
        snapshot.position,
        snapshot.protocolObligation,
        snapshot.depositedValueSf.toString(),
        snapshot.debtValueSf.toString(),
        snapshot.unhealthyBorrowValueSf.toString(),
        snapshot.ltvWad?.toString() ?? null,
        snapshot.maxSafeLtvWad?.toString() ?? null,
        snapshot.refreshedAtSlot,
        snapshot.refreshedAtUnixMs,
      ]
    );
  }

  async getLatestRiskSnapshot(position: string): Promise<PositionRiskSnapshot | null> {
    const { rows } = await this.pool.query<RiskRow>(
      `SELECT * FROM keeper_position_risk WHERE position = $1 LIMIT 1`,
      [position]
    );

    if (rows.length === 0) {
      return null;
    }

    return mapRiskRow(rows[0]);
  }
}

function mapPositionRow(row: PositionRow): CushionPosition {
  return {
    position: row.position,
    nftMint: row.nft_mint,
    positionAuthority: row.position_authority,
    owner: row.owner,
    borrower: row.borrower,
    protocolObligation: row.protocol_obligation,
    protocolUserMetadata: row.protocol_user_metadata,
    collateralVault: row.collateral_vault,
    injectedAmount: BigInt(row.injected_amount),
    injected: row.injected,
    bump: row.bump,
    updatedAtSlot: Number(row.updated_at_slot),
  };
}

function mapRiskRow(row: RiskRow): PositionRiskSnapshot {
  return {
    position: row.position,
    protocolObligation: row.protocol_obligation,
    depositedValueSf: BigInt(row.deposited_value_sf),
    debtValueSf: BigInt(row.debt_value_sf),
    unhealthyBorrowValueSf: BigInt(row.unhealthy_borrow_value_sf),
    ltvWad: row.ltv_wad === null ? null : BigInt(row.ltv_wad),
    maxSafeLtvWad:
      row.max_safe_ltv_wad === null ? null : BigInt(row.max_safe_ltv_wad),
    refreshedAtSlot: Number(row.refreshed_at_slot),
    refreshedAtUnixMs: Number(row.refreshed_at_unix_ms),
  };
}
