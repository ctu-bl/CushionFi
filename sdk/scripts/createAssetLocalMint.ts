import {
  createMint,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

import {
  getRuntimeConfig,
  loadKeypair,
  LOCAL_STATE_PATH,
  readEnvironmentState,
  writeEnvironmentState,
} from "./_common";

export async function main() {
  const runtimeConfig = getRuntimeConfig(process.env);
  const appEnv = runtimeConfig.appEnv;
  const clusterName = runtimeConfig.solanaCluster;
  const rpcUrl = runtimeConfig.solanaRpcUrl;
  const decimals = Number(process.env.ASSET_MINT_DECIMALS ?? "9");
  const initialTokens = BigInt(process.env.ASSET_INITIAL_TOKENS ?? "1000000");
  const environmentState = readEnvironmentState(appEnv);

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid ASSET_MINT_DECIMALS: ${decimals}`);
  }

  const payer = loadKeypair(runtimeConfig.solanaKeypairPath);
  const connection = new Connection(rpcUrl, "confirmed");

  await connection.getVersion();

  const owner = new PublicKey(
    process.env.ASSET_OWNER?.trim() ?? payer.publicKey.toBase58()
  );
  const configuredMint =
    process.env.ASSET_MINT?.trim() ?? environmentState.assetMint?.trim();
  let mintAddress: PublicKey | null = null;
  let createdNewMint = false;

  if (configuredMint) {
    const candidate = new PublicKey(configuredMint);
    const existingMint = await connection.getAccountInfo(
      candidate,
      "confirmed"
    );
    if (existingMint) {
      mintAddress = candidate;
    }
  }

  if (!mintAddress) {
    mintAddress = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      decimals
    );
    createdNewMint = true;
  }

  const mintInfo = await getMint(connection, mintAddress, "confirmed");
  const ownerTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mintAddress,
    owner,
    true,
    "confirmed"
  );

  const ownerBalance = ownerTokenAccount.amount;
  const unit = 10n ** BigInt(mintInfo.decimals);
  const amountToMint = initialTokens * unit;
  let mintedAmount = 0n;
  let mintSignature: string | null = null;

  if (amountToMint > 0n && ownerBalance === 0n) {
    mintSignature = await mintTo(
      connection,
      payer,
      mintAddress,
      ownerTokenAccount.address,
      payer,
      amountToMint,
      [],
      { commitment: "confirmed" }
    );
    mintedAmount = amountToMint;
  }

  writeEnvironmentState(appEnv, { assetMint: mintAddress.toBase58() });

  console.log("App environment:", appEnv);
  console.log("Cluster:", clusterName);
  console.log("Using RPC:", rpcUrl);
  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Owner:", owner.toBase58());
  console.log("Mint:", mintAddress.toBase58());
  console.log("Owner ATA:", ownerTokenAccount.address.toBase58());
  console.log("Decimals:", mintInfo.decimals);
  console.log("Updated state file:", LOCAL_STATE_PATH);
  console.log("Stored asset mint under environment:", appEnv);

  if (createdNewMint) {
    console.log(`Created new SPL mint on ${clusterName}.`);
  } else {
    console.log("Reusing existing SPL mint from local state or ASSET_MINT.");
  }

  if (mintedAmount > 0n) {
    console.log(
      `Minted ${initialTokens.toString()} whole tokens to ${owner.toBase58()} (raw amount ${mintedAmount.toString()}).`
    );
    console.log("mintTo signature:", mintSignature);
  } else {
    console.log(
      "Owner token account already had a balance or mint amount is zero, skipping mintTo."
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Failed to create local asset mint:", error);
    process.exit(1);
  });
}

