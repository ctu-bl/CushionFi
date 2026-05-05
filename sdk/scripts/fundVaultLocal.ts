import anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import {
  createSyncNativeInstruction,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getRuntimeConfig,
  loadKeypair,
} from "./_common.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_STATE_SEED = Buffer.from("vault_state_v1");
const DEFAULT_SOL_ASSET_MINT = "So11111111111111111111111111111111111111112";

const { AnchorProvider, BN, Program, Wallet, setProvider } = anchor;

function loadCushionIdl(): Idl {
  const idlPath = path.resolve(__dirname, "..", "..", "target", "idl", "cushion.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(
      `IDL not found at ${idlPath}. Run \`anchor build\` first so deposit can use the latest interface.`
    );
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf-8")) as Idl;
}

export async function main() {
  const runtimeConfig = getRuntimeConfig(process.env);
  const appEnv = runtimeConfig.appEnv;
  const rpcUrl = runtimeConfig.solanaRpcUrl;
  const configuredAssetMint = process.env.ASSET_MINT?.trim();

  const assetMint =
    configuredAssetMint ??
    DEFAULT_SOL_ASSET_MINT;
  const usingDefaultWsolMint = !configuredAssetMint;

  const depositRaw = BigInt(process.env.VAULT_DEPOSIT_RAW ?? "1000000000000");
  const minSharesOutRaw = BigInt(process.env.VAULT_MIN_SHARES_OUT_RAW ?? "0");
  if (depositRaw <= 0n) {
    throw new Error("VAULT_DEPOSIT_RAW must be > 0");
  }
  if (minSharesOutRaw < 0n) {
    throw new Error("VAULT_MIN_SHARES_OUT_RAW must be >= 0");
  }

  const payer = loadKeypair(runtimeConfig.solanaKeypairPath);
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  setProvider(provider);

  const idl = loadCushionIdl();
  const program = new Program(idl, provider);
  const assetMintPubkey = new PublicKey(assetMint);
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [VAULT_STATE_SEED, assetMintPubkey.toBuffer()],
    program.programId
  );

  const vaultAccountInfo = await connection.getAccountInfo(vaultPda, "confirmed");
  if (!vaultAccountInfo) {
    throw new Error(
      `Vault ${vaultPda.toBase58()} does not exist. Run \`yarn init:vault:${appEnv}\` (or init:vault:local).`
    );
  }
  const vaultState = await (program as any).account.vault.fetch(vaultPda);

  const shareMintPubkey = new PublicKey(vaultState.shareMint);
  const vaultTokenAccount = new PublicKey(vaultState.vaultTokenAccount);

  const userAssetAta = (
    await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      assetMintPubkey,
      payer.publicKey,
      false,
      "confirmed"
    )
  ).address;
  const userShareAta = (
    await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      shareMintPubkey,
      payer.publicKey,
      false,
      "confirmed"
    )
  ).address;

  const userAssetBefore = await getAccount(connection, userAssetAta, "confirmed");
  if (assetMintPubkey.equals(NATIVE_MINT) && userAssetBefore.amount < depositRaw) {
    const missingLamports = depositRaw - userAssetBefore.amount;
    if (missingLamports > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `Wrap amount too large for JS number conversion: ${missingLamports.toString()}`
      );
    }
    const wrapTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: userAssetAta,
        lamports: Number(missingLamports),
      }),
      createSyncNativeInstruction(userAssetAta)
    );
    await provider.sendAndConfirm(wrapTx, []);
  }

  const userAssetReady = await getAccount(connection, userAssetAta, "confirmed");
  if (userAssetReady.amount < depositRaw) {
    throw new Error(
      `Insufficient user asset balance for deposit. balance=${userAssetReady.amount.toString()} required=${depositRaw.toString()}`
    );
  }

  const vaultAssetBefore = await getAccount(connection, vaultTokenAccount, "confirmed");

  const txSig = await (program as any).methods
    .deposit(new BN(depositRaw.toString()), new BN(minSharesOutRaw.toString()))
    .accounts({
      user: payer.publicKey,
      assetMint: assetMintPubkey,
      vault: vaultPda,
      shareMint: shareMintPubkey,
      userAssetAccount: userAssetAta,
      userShareAccount: userShareAta,
      vaultTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const userAssetAfter = await getAccount(connection, userAssetAta, "confirmed");
  const userShareAfter = await getAccount(connection, userShareAta, "confirmed");
  const vaultAssetAfter = await getAccount(connection, vaultTokenAccount, "confirmed");

  console.log("fund_vault tx signature:", txSig);
  console.log("appEnv:", appEnv);
  console.log("rpcUrl:", rpcUrl);
  console.log(
    "assetMint:",
    assetMintPubkey.toBase58(),
    usingDefaultWsolMint ? "(default WSOL)" : "(from ASSET_MINT)"
  );
  console.log("vault:", vaultPda.toBase58());
  console.log("vaultTokenAccount:", vaultTokenAccount.toBase58());
  console.log("userAssetAccount:", userAssetAta.toBase58());
  console.log("userShareAccount:", userShareAta.toBase58());
  console.log("depositRaw:", depositRaw.toString());
  console.log("minSharesOutRaw:", minSharesOutRaw.toString());
  console.log("userAssetBefore:", userAssetBefore.amount.toString());
  console.log("userAssetAfter:", userAssetAfter.amount.toString());
  console.log("userShareAfter:", userShareAfter.amount.toString());
  console.log("vaultAssetBefore:", vaultAssetBefore.amount.toString());
  console.log("vaultAssetAfter:", vaultAssetAfter.amount.toString());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Failed to fund vault:", err);
    process.exit(1);
  });
}
