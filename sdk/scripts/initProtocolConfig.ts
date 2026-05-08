import { getScriptEnvironmentConfig } from "../../config/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveScopedEnvValue } from "./_common.ts";

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const PROTOCOL_CONFIG_SEED = Buffer.from("protocol_config_v1");
const MAINNET_KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MAINNET_FARMS_PROGRAM_ID = new PublicKey("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");
const DEFAULT_KLEND_MOCK_PROGRAM_ID = new PublicKey("FHqW31mKXKPQqrHYYmGKcUGM5q8EF8SPeU3axkNG6bxe");

type ProtocolMode = 0 | 1;

function discriminator(ixName: string): Buffer {
  return createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);
}

function resolveHomePath(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function loadSigner(walletPath: string): Keypair {
  const expanded = resolveHomePath(walletPath);
  const raw = fs.readFileSync(expanded, "utf-8");
  const secret = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function loadCushionProgramId(appEnv: string): PublicKey {
  const idlPath = path.resolve("target", "idl", "cushion.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(`Missing IDL at ${idlPath}. Run anchor build first.`);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8")) as {
    address?: string;
    metadata?: { address?: string };
  };
  const address = resolveScopedEnvValue(process.env, appEnv, "CUSHION_PROGRAM_ID") || idl.address || idl.metadata?.address;
  if (!address) {
    throw new Error("Unable to resolve Cushion program id from CUSHION_PROGRAM_ID or target/idl/cushion.json");
  }
  return new PublicKey(address);
}

function parseMode(value: string | undefined): ProtocolMode | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "mainnet" || normalized === "0") return 0;
  if (normalized === "devnetmock" || normalized === "devnet_mock" || normalized === "mock" || normalized === "1") {
    return 1;
  }
  throw new Error(`Unsupported PROTOCOL_MODE value: ${value}`);
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function readProtocolConfigState(data: Buffer): {
  authority: PublicKey;
  klendProgramId: PublicKey;
  farmsProgramId: PublicKey;
  mode: ProtocolMode;
  isFrozen: boolean;
  version: number;
} {
  if (data.length < 8 + 101) {
    throw new Error(`Protocol config account too small: ${data.length}`);
  }
  const authority = new PublicKey(data.subarray(9, 41));
  const klendProgramId = new PublicKey(data.subarray(41, 73));
  const farmsProgramId = new PublicKey(data.subarray(73, 105));
  const mode = data[105] as ProtocolMode;
  const isFrozen = data[106] !== 0;
  const version = data.readUInt16LE(107);
  return { authority, klendProgramId, farmsProgramId, mode, isFrozen, version };
}

async function sendIx(params: {
  connection: Connection;
  payer: Keypair;
  instruction: TransactionInstruction;
}): Promise<string> {
  return sendAndConfirmTransaction(
    params.connection,
    new Transaction().add(params.instruction),
    [params.payer],
    { commitment: "confirmed" }
  );
}

async function main() {
  const runtime = getScriptEnvironmentConfig(process.env);
  const payer = loadSigner(runtime.solanaKeypairPath);
  const connection = new Connection(runtime.solanaRpcUrl, {
    commitment: "confirmed",
    wsEndpoint: runtime.solanaWsUrl,
  });
  const cushionProgramId = loadCushionProgramId(runtime.appEnv);

  const appEnv = runtime.appEnv;
  const defaultKlend = appEnv === "devnet" ? DEFAULT_KLEND_MOCK_PROGRAM_ID : MAINNET_KLEND_PROGRAM_ID;
  const klendProgramId = new PublicKey(
    resolveScopedEnvValue(process.env, appEnv, "KLEND_PROGRAM_ID") ||
      resolveScopedEnvValue(process.env, appEnv, "KLEND_MOCK_PROGRAM_ID") ||
      defaultKlend.toBase58()
  );
  const farmsProgramId = new PublicKey(
    resolveScopedEnvValue(process.env, appEnv, "KLEND_FARMS_PROGRAM") ||
      resolveScopedEnvValue(process.env, appEnv, "FARMS_PROGRAM_ID") ||
      (appEnv === "devnet" ? klendProgramId.toBase58() : MAINNET_FARMS_PROGRAM_ID.toBase58())
  );

  const explicitMode = parseMode(process.env.PROTOCOL_MODE);
  const inferredMode: ProtocolMode =
    klendProgramId.equals(MAINNET_KLEND_PROGRAM_ID) && farmsProgramId.equals(MAINNET_FARMS_PROGRAM_ID)
      ? 0
      : 1;
  const mode = explicitMode ?? inferredMode;

  const updateIfExists = boolEnv(
    "PROTOCOL_CONFIG_UPDATE_IF_EXISTS",
    appEnv === "devnet"
  );
  const freezeAfterWrite = boolEnv("PROTOCOL_CONFIG_FREEZE", false);

  const [protocolConfig] = PublicKey.findProgramAddressSync([PROTOCOL_CONFIG_SEED], cushionProgramId);

  console.log("RPC:", runtime.solanaRpcUrl);
  console.log("Cushion program:", cushionProgramId.toBase58());
  console.log("Protocol config PDA:", protocolConfig.toBase58());
  console.log("Authority:", payer.publicKey.toBase58());
  console.log("Target klend program:", klendProgramId.toBase58());
  console.log("Target farms program:", farmsProgramId.toBase58());
  console.log("Target mode:", mode === 0 ? "Mainnet" : "DevnetMock");

  const existing = await connection.getAccountInfo(protocolConfig, "confirmed");
  if (!existing) {
    const initIx = new TransactionInstruction({
      programId: cushionProgramId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: protocolConfig, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        discriminator("init_protocol_config"),
        klendProgramId.toBuffer(),
        farmsProgramId.toBuffer(),
        Buffer.from([mode]),
      ]),
    });

    const sig = await sendIx({ connection, payer, instruction: initIx });
    console.log("init_protocol_config signature:", sig);
  } else {
    const state = readProtocolConfigState(Buffer.from(existing.data));
    console.log("Existing protocol config found:");
    console.log("  authority:", state.authority.toBase58());
    console.log("  klendProgramId:", state.klendProgramId.toBase58());
    console.log("  farmsProgramId:", state.farmsProgramId.toBase58());
    console.log("  mode:", state.mode === 0 ? "Mainnet" : "DevnetMock");
    console.log("  frozen:", state.isFrozen);
    console.log("  version:", state.version);

    if (updateIfExists) {
      const updateIx = new TransactionInstruction({
        programId: cushionProgramId,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: protocolConfig, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([
          discriminator("update_protocol_config"),
          klendProgramId.toBuffer(),
          farmsProgramId.toBuffer(),
          Buffer.from([mode]),
        ]),
      });
      const sig = await sendIx({ connection, payer, instruction: updateIx });
      console.log("update_protocol_config signature:", sig);
    } else {
      console.log("PROTOCOL_CONFIG_UPDATE_IF_EXISTS is false. Keeping existing config unchanged.");
    }
  }

  if (freezeAfterWrite) {
    const freezeIx = new TransactionInstruction({
      programId: cushionProgramId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: protocolConfig, isSigner: false, isWritable: true },
      ],
      data: discriminator("freeze_protocol_config"),
    });
    const sig = await sendIx({ connection, payer, instruction: freezeIx });
    console.log("freeze_protocol_config signature:", sig);
  }

  const finalAccount = await connection.getAccountInfo(protocolConfig, "confirmed");
  if (!finalAccount) {
    throw new Error("Protocol config still missing after initialization");
  }
  const finalState = readProtocolConfigState(Buffer.from(finalAccount.data));
  console.log("Final protocol config:");
  console.log("  authority:", finalState.authority.toBase58());
  console.log("  klendProgramId:", finalState.klendProgramId.toBase58());
  console.log("  farmsProgramId:", finalState.farmsProgramId.toBase58());
  console.log("  mode:", finalState.mode === 0 ? "Mainnet" : "DevnetMock");
  console.log("  frozen:", finalState.isFrozen);
  console.log("  version:", finalState.version);
}

main().catch((error) => {
  console.error("Failed to initialize/update protocol config:", error);
  process.exit(1);
});
