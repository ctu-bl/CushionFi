import { getScriptEnvironmentConfig } from "../../config/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const INIT_POSITION_REGISTRY_DISCRIMINATOR = Uint8Array.from([
  177, 221, 98, 50, 140, 12, 224, 245,
]);
const POSITION_REGISTRY_SEED = Buffer.from("position_registry");

const cushionIdlJson = JSON.parse(
  fs.readFileSync(new URL("../src/idl/cushion.json", import.meta.url), "utf-8")
) as { address?: string; metadata?: { address?: string } };

function resolveHomePath(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

function loadSigner(): Keypair {
  const walletPath = resolveHomePath(
    getScriptEnvironmentConfig(process.env).solanaKeypairPath
  );
  const raw = fs.readFileSync(walletPath, "utf-8");
  const parsed = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

async function assertProgramDeployed(params: {
  connection: Connection;
  programId: PublicKey;
  rpcUrl: string;
  clusterName: string;
}): Promise<void> {
  const programInfo = await params.connection.getAccountInfo(
    params.programId,
    "confirmed"
  );

  if (programInfo?.executable) {
    return;
  }

  const deployHint =
    params.clusterName === "localnet" ? " Run `yarn deploy:local` first." : "";

  throw new Error(
    `Cushion program ${params.programId.toBase58()} is not deployed or not executable on ${
      params.clusterName
    } (${params.rpcUrl}).${deployHint}`
  );
}

async function main() {
  const runtimeConfig = getScriptEnvironmentConfig(process.env);
  const clusterName = runtimeConfig.solanaCluster;
  const rpcUrl = runtimeConfig.solanaRpcUrl;
  const programAddress =
    runtimeConfig.cushionProgramId ??
    cushionIdlJson.address ??
    cushionIdlJson.metadata?.address;

  if (!programAddress) {
    throw new Error("Cushion IDL does not include a program address.");
  }

  const signer = loadSigner();
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: runtimeConfig.solanaWsUrl,
  });
  const programId = new PublicKey(programAddress);
  await assertProgramDeployed({
    connection,
    programId,
    rpcUrl,
    clusterName,
  });
  const [positionRegistry] = PublicKey.findProgramAddressSync(
    [POSITION_REGISTRY_SEED],
    programId
  );

  const existing = await connection.getAccountInfo(
    positionRegistry,
    "confirmed"
  );
  if (existing) {
    console.log(
      "Position registry already exists:",
      positionRegistry.toBase58()
    );
    return;
  }

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionRegistry, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(INIT_POSITION_REGISTRY_DISCRIMINATOR),
  });

  const signature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(instruction),
    [signer],
    {
      commitment: "confirmed",
    }
  );

  console.log("Initialized position registry:", positionRegistry.toBase58());
  console.log("Signature:", signature);
}

main().catch((error) => {
  console.error("Failed to initialize Cushion position registry:", error);
  process.exit(1);
});
