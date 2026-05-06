import { Keypair } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";

export type RuntimeConfig = {
  appEnv: string;
  solanaCluster: string;
  solanaRpcUrl: string;
  solanaKeypairPath: string;
};

export function getRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  return {
    appEnv: env.APP_ENV?.trim() || "local",
    solanaCluster: env.SOLANA_CLUSTER?.trim() || "localnet",
    solanaRpcUrl:
      env.ANCHOR_PROVIDER_URL?.trim() ||
      env.SOLANA_RPC_URL?.trim() ||
      "http://127.0.0.1:8899",
    solanaKeypairPath:
      env.ANCHOR_WALLET?.trim() ||
      env.SOLANA_KEYPAIR?.trim() ||
      "~/.config/solana/id.json",
  };
}

export function expandHome(filePath: string): string {
  if (!filePath.startsWith("~/")) {
    return filePath;
  }

  return path.join(process.env.HOME ?? "", filePath.slice(2));
}

export function loadKeypair(keypairPath: string): Keypair {
  const expandedPath = expandHome(keypairPath);
  if (!fs.existsSync(expandedPath)) {
    throw new Error(
      `Wallet keypair not found at ${expandedPath}. Set ANCHOR_WALLET or SOLANA_KEYPAIR to a valid keypair path.`
    );
  }

  const secret = JSON.parse(fs.readFileSync(expandedPath, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}
