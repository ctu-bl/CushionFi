import type { CushionPosition, PositionRiskSnapshot } from "../types.ts";

export interface KeeperRepository {
  init(): Promise<void>;
  close(): Promise<void>;
  listPositions(): Promise<CushionPosition[]>;
  getPosition(position: string): Promise<CushionPosition | null>;
  upsertPositions(positions: CushionPosition[]): Promise<void>;
  deletePositions(positionPubkeys: string[]): Promise<void>;
  saveRiskSnapshot(snapshot: PositionRiskSnapshot): Promise<void>;
  getLatestRiskSnapshot(position: string): Promise<PositionRiskSnapshot | null>;
}
