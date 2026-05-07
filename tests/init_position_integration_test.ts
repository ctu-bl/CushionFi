import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";

import { Cushion } from "../target/types/cushion";
import {
  FARMS_PROGRAM,
  PROTOCOL_CONFIG,
  KLEND,
  MARKET,
  RESERVE,
  RESERVE_FARM_STATE,
  MPL_CORE_PROGRAM_ID,
} from "./constants";


const POSITION_AUTHORITY_SEED = Buffer.from("loan_authority");
const POSITION_SEED = Buffer.from("loan_position");
const POSITION_REGISTRY_SEED = Buffer.from("position_registry");
const POSITION_REGISTRY_ENTRY_SEED = Buffer.from("position_registry_entry");

describe("init position integration", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Cushion as Program<Cushion>;

  const user = provider.wallet.publicKey;

  // Collection keypair — created once before all tests
  const collectionKeypair = Keypair.generate();

  async function waitForRpcReady(retries = 180, delayMs = 1000): Promise<void> {
    let lastErr: unknown;
    for (let i = 0; i < retries; i += 1) {
      try {
        await provider.connection.getLatestBlockhash("confirmed");
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastErr;
  }

  function derivePositionAuthority(nftMint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [POSITION_AUTHORITY_SEED, nftMint.toBuffer()],
      program.programId
    )[0];
  }

  function derivePosition(nftMint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [POSITION_SEED, nftMint.toBuffer()],
      program.programId
    )[0];
  }

  function derivePositionRegistry(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [POSITION_REGISTRY_SEED],
      program.programId
    )[0];
  }

  function derivePositionRegistryEntry(nftMint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [POSITION_REGISTRY_ENTRY_SEED, nftMint.toBuffer()],
      program.programId
    )[0];
  }

  function deriveKlendUserMetadata(positionAuthority: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("user_meta"), positionAuthority.toBuffer()],
      KLEND
    )[0];
  }

  function deriveKlendObligation(positionAuthority: PublicKey): PublicKey {
    const zero = new PublicKey(new Uint8Array(32));
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from([0]),
        Buffer.from([0]),
        positionAuthority.toBuffer(),
        MARKET.toBuffer(),
        zero.toBuffer(),
        zero.toBuffer(),
      ],
      KLEND
    )[0];
  }

  function deriveLendingMarketAuthority(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("lma"), MARKET.toBuffer()],
      KLEND
    )[0];
  }

  function deriveObligationFarmUserState(klendObligation: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("user"),
        RESERVE_FARM_STATE.toBuffer(),
        klendObligation.toBuffer(),
      ],
      FARMS_PROGRAM
    )[0];
  }

  async function ensurePositionRegistryInitialized(positionRegistry: PublicKey): Promise<number> {
    const existing = await provider.connection.getAccountInfo(positionRegistry);
    console.log("registry:", existing);
    if (!existing) {
      await (program as any).methods
        .initPositionRegistry()
        .accountsStrict({
          authority: user,
          positionRegistry,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    console.log("registry:", positionRegistry);
    const registryAccount = await (program as any).account.positionRegistry.fetch(positionRegistry);
    console.log("registryAccount: ", registryAccount);
    return Number(registryAccount.totalPositions);
  }

  async function createCushionCollection(): Promise<void> {
    // Create Metaplex Core collection directly via CPI to mpl-core
    // The collection is owned by the user and used for all Cushion positions
    const createCollectionIx = await (program as any).methods
      .initCollection()
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      ])
      .accountsStrict({
        payer: user,
        collection: collectionKeypair.publicKey,
        positionRegistry: derivePositionRegistry(), 
        systemProgram: SystemProgram.programId,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
      })
      .signers([collectionKeypair])
      .rpc();
  }

  before(async () => {
    await waitForRpcReady();

    // Create the Cushion collection once before all tests
    try {
      await createCushionCollection();
    } catch (err) {
      console.log("Collection may already exist or creation skipped:", err.message);
    }
  });

  it("registers position, mints NFT and creates Kamino obligation owned by Cushion PDA", async () => {
    // nftMint is now a fresh keypair, not a PDA
    const nftMintKeypair = Keypair.generate();
    const nftMint = nftMintKeypair.publicKey;

    const positionAuthority = derivePositionAuthority(nftMint);
    const position = derivePosition(nftMint);
    const positionRegistry = derivePositionRegistry();
    const positionRegistryEntry = derivePositionRegistryEntry(nftMint);

    const klendUserMetadata = deriveKlendUserMetadata(positionAuthority);
    const klendObligation = deriveKlendObligation(positionAuthority);
    const lendingMarketAuthority = deriveLendingMarketAuthority();
    const obligationFarmUserState = deriveObligationFarmUserState(klendObligation);

    const totalPositionsBefore = await ensurePositionRegistryInitialized(positionRegistry);
    console.log("total positions:", totalPositionsBefore);
    let signature: string;
    try {
      const computeIxs = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      ];

      signature = await (program as any).methods
        .initPosition()   // no nftMintSeed argument anymore
        .preInstructions(computeIxs)
        .accountsStrict({
          user,
          nftMint,                                    // keypair address
          collection: collectionKeypair.publicKey,    // Cushion collection
          positionAuthority,
          position,
          positionRegistry,
          positionRegistryEntry,
          klendUserMetadata,
          klendObligation,
          klendReserve: RESERVE,
          reserveFarmState: RESERVE_FARM_STATE,
          obligationFarmUserState,
          lendingMarket: MARKET,
          lendingMarketAuthority,
          klendProgram: KLEND,
          farmsProgram: FARMS_PROGRAM,
          protocolConfig: PROTOCOL_CONFIG,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
        })
        .signers([nftMintKeypair])   // nftMint keypair must sign
        .rpc();
    } catch (err) {
      console.error("init_position seed debug", {
        user: user.toBase58(),
        nftMint: nftMint.toBase58(),
        positionAuthority: positionAuthority.toBase58(),
      });
      throw err;
    }

    await provider.connection.confirmTransaction(signature, "confirmed");

    // Verify NFT account exists on-chain (Metaplex Core asset)
    const nftAccountInfo = await provider.connection.getAccountInfo(nftMint);
    expect(nftAccountInfo).to.not.eq(null);
    expect(nftAccountInfo!.owner.toBase58()).to.eq(MPL_CORE_PROGRAM_ID.toBase58());

    // Verify position PDA was created correctly
    const positionAccount = await (program as any).account.obligation.fetch(position);
    expect(positionAccount.nftMint.toBase58()).to.eq(nftMint.toBase58());
    expect(positionAccount.positionAuthority.toBase58()).to.eq(positionAuthority.toBase58());
    expect(positionAccount.protocolObligation.toBase58()).to.eq(klendObligation.toBase58());
    expect(positionAccount.protocolUserMetadata.toBase58()).to.eq(klendUserMetadata.toBase58());
    expect(positionAccount.owner.toBase58()).to.eq(user.toBase58());
    expect(positionAccount.borrower.toBase58()).to.eq(user.toBase58());

    // Verify registry counter was incremented
    const registryAccount = await (program as any).account.positionRegistry.fetch(positionRegistry);
    expect(Number(registryAccount.totalPositions)).to.eq(totalPositionsBefore + 1);

    // Verify registry entry was created
    const registryEntry = await (program as any).account.positionRegistryEntry.fetch(positionRegistryEntry);
    expect(registryEntry.nftMint.toBase58()).to.eq(nftMint.toBase58());
    expect(registryEntry.position.toBase58()).to.eq(position.toBase58());
    expect(registryEntry.positionAuthority.toBase58()).to.eq(positionAuthority.toBase58());
    expect(registryEntry.borrower.toBase58()).to.eq(user.toBase58());
    expect(Number(registryEntry.createdAt)).to.be.greaterThan(0);

    // Verify Kamino obligation was created under position authority
    const klendObligationInfo = await provider.connection.getAccountInfo(klendObligation);
    expect(klendObligationInfo).to.not.eq(null);
    expect(klendObligationInfo!.owner.toBase58()).to.eq(KLEND.toBase58());

    // Verify position account is owned by our program
    const positionInfo = await provider.connection.getAccountInfo(position);
    expect(positionInfo).to.not.eq(null);
    expect(positionInfo!.owner.toBase58()).to.eq(program.programId.toBase58());
  });
});