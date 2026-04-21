import anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  getRuntimeConfig,
  loadKeypair,
  readEnvironmentState,
} from "./_common.ts";

const { AnchorProvider, BN, Program, Wallet, setProvider } = anchor;

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
const RENT_SYSVAR_ID = new PublicKey(
  "SysvarRent111111111111111111111111111111111"
);

function loadCushionIdl(): Idl {
  const idlPath = path.resolve(__dirname, "..", "..", "target", "idl", "cushion.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(
      `IDL not found at ${idlPath}. Run \`anchor build\` first so init_vault can use the latest program interface.`
    );
  }

  return JSON.parse(fs.readFileSync(idlPath, "utf-8")) as Idl;
}

export async function main() {
  const runtimeConfig = getRuntimeConfig(process.env);
  const appEnv = runtimeConfig.appEnv;
  const clusterName = runtimeConfig.solanaCluster;
  const rpcUrl = runtimeConfig.solanaRpcUrl;
  const environmentState = readEnvironmentState(appEnv);
  const assetMint =
    process.env.ASSET_MINT?.trim() ?? environmentState.assetMint?.trim();

  if (!assetMint) {
    throw new Error(
      "Asset mint is not configured. Run `yarn create:asset:local` first or pass ASSET_MINT explicitly."
    );
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
  const programId = program.programId;

  const minDeposit = new BN(process.env.MIN_DEPOSIT ?? "1000000");
  const depositCap = new BN(process.env.DEPOSIT_CAP ?? "1000000000000000");
  const virtualAssets = new BN(process.env.VIRTUAL_ASSETS ?? "0");
  const virtualShares = new BN(process.env.VIRTUAL_SHARES ?? "0");

  console.log("Cluster:", clusterName);
  console.log("App environment:", appEnv);
  console.log("Using RPC:", rpcUrl);
  console.log("Program ID:", programId.toBase58());
  console.log("Authority:", provider.wallet.publicKey.toBase58());
  console.log("Asset mint:", assetMint);

  await connection.getVersion();

  const assetMintPubkey = new PublicKey(assetMint);
  const [programAccountInfo, assetMintInfo] = await Promise.all([
    connection.getAccountInfo(programId, "confirmed"),
    connection.getAccountInfo(assetMintPubkey, "confirmed"),
  ]);

  if (!programAccountInfo?.executable) {
    throw new Error(
      [
        `Cushion program ${programId.toBase58()} is not deployed on ${rpcUrl}.`,
        `Deploy it first with \`anchor deploy\` and then rerun the vault init.`,
      ].join(" ")
    );
  }

  if (!assetMintInfo) {
    throw new Error(
      [
        `Asset mint ${assetMintPubkey.toBase58()} does not exist on ${rpcUrl}.`,
        "Create the SPL mint first and rerun the vault init.",
      ].join(" ")
    );
  }

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_state_v1"), assetMintPubkey.toBuffer()],
    programId
  );
  const [shareMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_share_mint_v1"), vaultPda.toBuffer()],
    programId
  );
  const [vaultTokenPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_token_v1"), vaultPda.toBuffer()],
    programId
  );
  const [treasuryTokenPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_treasury_v1"), vaultPda.toBuffer()],
    programId
  );

  console.log("Vault PDA:", vaultPda.toBase58());
  console.log("Share mint PDA:", shareMintPda.toBase58());
  console.log("Vault token PDA:", vaultTokenPda.toBase58());
  console.log("Treasury token PDA:", treasuryTokenPda.toBase58());

  const existingVault = await connection.getAccountInfo(vaultPda, "confirmed");
  if (existingVault) {
    console.log("Vault already exists on chain, skipping init.");
    return;
  }

  const txSig = await program.methods
    .initVault(minDeposit, depositCap, virtualAssets, virtualShares)
    .accounts({
      authority: provider.wallet.publicKey,
      assetMint: assetMintPubkey,
      vault: vaultPda,
      shareMint: shareMintPda,
      vaultTokenAccount: vaultTokenPda,
      treasuryTokenAccount: treasuryTokenPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      rent: RENT_SYSVAR_ID,
    })
    .rpc();

  console.log("init_vault tx signature:", txSig);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Failed to init vault:", err);
    process.exit(1);
  });
}

