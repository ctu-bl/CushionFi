import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { createMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { Cushion } from "../target/types/cushion";
import { SOL_USD_FEED_ID, PYTH_SOL_USD_PRICE_UPDATE } from "./constants";

const VAULT_STATE_SEED = Buffer.from("vault_state_v1");
const VAULT_SHARE_MINT_SEED = Buffer.from("vault_share_mint_v1");
const VAULT_TOKEN_ACCOUNT_SEED = Buffer.from("vault_token_v1");
const VAULT_TREASURY_TOKEN_ACCOUNT_SEED = Buffer.from("vault_treasury_v1");

describe("pyth market price update", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Cushion as Program<Cushion>;
  const payer = provider.wallet.payer;

  async function airdrop(pubkey: PublicKey, lamports = LAMPORTS_PER_SOL) {
    const sig = await provider.connection.requestAirdrop(pubkey, lamports);
    const latest = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed"
    );
  }

  function deriveVaultAddresses(assetMint: PublicKey) {
    const [vault] = PublicKey.findProgramAddressSync(
      [VAULT_STATE_SEED, assetMint.toBuffer()],
      program.programId
    );
    const [shareMint] = PublicKey.findProgramAddressSync(
      [VAULT_SHARE_MINT_SEED, vault.toBuffer()],
      program.programId
    );
    const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [VAULT_TOKEN_ACCOUNT_SEED, vault.toBuffer()],
      program.programId
    );
    const [treasuryTokenAccount] = PublicKey.findProgramAddressSync(
      [VAULT_TREASURY_TOKEN_ACCOUNT_SEED, vault.toBuffer()],
      program.programId
    );
    return { vault, shareMint, vaultTokenAccount, treasuryTokenAccount };
  }

  async function initVault(assetMint: PublicKey) {
    const addrs = deriveVaultAddresses(assetMint);
    await program.methods
      .initVault(
        new anchor.BN(1),
        new anchor.BN(1_000_000_000),
        new anchor.BN(0),
        new anchor.BN(0)
      )
      .accounts({
        authority: provider.wallet.publicKey,
        assetMint,
        vault: addrs.vault,
        shareMint: addrs.shareMint,
        vaultTokenAccount: addrs.vaultTokenAccount,
        treasuryTokenAccount: addrs.treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    return addrs;
  }

  function toNum(value: any): number {
    if (typeof value === "number") return value;
    if (typeof value?.toNumber === "function") return value.toNumber();
    return Number(value.toString());
  }

  // NOTE: These tests require a live PriceUpdateV2 account (PYTH_SOL_USD_PRICE_UPDATE).
  // On localnet: clone the account from devnet via Anchor.toml `[[test.validator.clone]]`,
  //              or post a fresh price update using the Hermes API + Pyth receiver program.
  // On devnet: works out of the box if PYTH_SOL_USD_PRICE_UPDATE is a recently posted account.

  // Happy path: authority calls update_market_price with a live Pyth v2 feed
  // and the vault state reflects a positive WAD-scaled price with a fresh timestamp.
  it("1) updates vault market_price and market_price_last_updated from Pyth SOL/USD feed", async () => {
    const assetMint = await createMint(provider.connection, payer, payer.publicKey, null, 9);
    const { vault } = await initVault(assetMint);

    const stateBefore = await program.account.vault.fetch(vault);
    expect(toNum(stateBefore.marketPrice)).to.eq(0);

    await program.methods
      .updateMarketPrice([...SOL_USD_FEED_ID])
      .accounts({
        authority: provider.wallet.publicKey,
        vault,
        priceUpdate: PYTH_SOL_USD_PRICE_UPDATE,
      })
      .rpc();

    const stateAfter = await program.account.vault.fetch(vault);

    // Price must be WAD-scaled (1e18 = SOL at $1; real SOL price is >$1 so > 1e18)
    const WAD = BigInt("1000000000000000000");
    const price = BigInt(stateAfter.marketPrice.toString());
    expect(price > WAD).to.be.true;

    // Timestamp must be a recent unix timestamp (after year 2024)
    const ts = toNum(stateAfter.marketPriceLastUpdated);
    expect(ts).to.be.greaterThan(1_700_000_000);
  });

  // Account validation: passing a random account instead of a valid PriceUpdateV2 must fail.
  it("3) rejects update_market_price when price_update is not a valid Pyth account", async () => {
    const assetMint = await createMint(provider.connection, payer, payer.publicKey, null, 9);
    const { vault } = await initVault(assetMint);

    const fakeFeed = Keypair.generate();
    await airdrop(fakeFeed.publicKey);

    try {
      await program.methods
        .updateMarketPrice([...SOL_USD_FEED_ID])
        .accounts({
          authority: provider.wallet.publicKey,
          vault,
          priceUpdate: fakeFeed.publicKey,
        })
        .rpc();
      expect.fail("Expected error for invalid Pyth account");
    } catch (err: any) {
      const msg = String(err);
      const code = err?.error?.errorCode?.code ?? "";
      expect(
        code === "StalePythPrice" || msg.includes("StalePythPrice") ||
        msg.includes("AccountDiscriminatorMismatch") || msg.includes("AccountOwnedByWrongProgram")
      ).to.be.true;
    }
  });
});
