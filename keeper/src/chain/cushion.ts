import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CushionPosition } from "../types.ts";

const { AnchorProvider, BN, Program, Wallet } = anchor;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadCushionIdl() {
  const idlPath = path.resolve(__dirname, "..", "..", "..", "target", "idl", "cushion.json");
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

export class CushionChainClient {
  private readonly connection: Connection;
  private readonly cushionProgramId: PublicKey;
  private readonly provider: InstanceType<typeof AnchorProvider>;
  private readonly program: InstanceType<typeof Program>;
  private readonly obligationAccountSize: number;

  constructor(
    connection: Connection,
    authority: Keypair,
    cushionProgramId: PublicKey
  ) {
    this.connection = connection;
    this.cushionProgramId = cushionProgramId;
    const wallet = new Wallet(authority);

    this.provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });

    this.program = new Program(loadCushionIdl(), this.provider);
    this.obligationAccountSize = (this.program as any).account.obligation.size;
  }

  async listPositions(currentSlot: number): Promise<CushionPosition[]> {
    const accounts = await this.connection.getProgramAccounts(this.cushionProgramId, {
      commitment: "confirmed",
      filters: [{ dataSize: this.obligationAccountSize }],
    });

    const out: CushionPosition[] = [];

    for (const account of accounts) {
      let decoded: any;
      try {
        decoded = (this.program as any).coder.accounts.decode(
          "obligation",
          Buffer.from(account.account.data)
        );
      } catch {
        continue;
      }

      out.push({
        position: account.pubkey.toBase58(),
        nftMint: decoded.nftMint.toBase58(),
        positionAuthority: decoded.positionAuthority.toBase58(),
        owner: decoded.owner.toBase58(),
        borrower: decoded.borrower.toBase58(),
        protocolObligation: decoded.protocolObligation.toBase58(),
        protocolUserMetadata: decoded.protocolUserMetadata.toBase58(),
        collateralVault: decoded.collateralVault.toBase58(),
        injectThresholdWad: BigInt(decoded.injectThresholdWad.toString()),
        injected: decoded.injected,
        bump: decoded.bump,
        updatedAtSlot: currentSlot,
      });
    }

    return out;
  }

  async injectCollateral(position: PublicKey, authority: PublicKey, amount: bigint): Promise<string> {
    const signature = await (this.program as any).methods
      .injectCollateral(new BN(amount.toString()))
      .accountsStrict({
        position,
        authority,
      })
      .rpc();

    return signature;
  }
}
