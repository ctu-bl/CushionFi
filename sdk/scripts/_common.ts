import { Keypair } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";

export type RuntimeConfig = {
  appEnv: string;
  solanaCluster: string;
  solanaRpcUrl: string;
  solanaKeypairPath: string;
};

type EnvironmentState = {
  assetMint?: string;
};

type LocalStateStore = Record<string, EnvironmentState>;

export const LOCAL_STATE_PATH = path.resolve(
  __dirname,
  "..",
  ".local-state.json"
);

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

export function readEnvironmentState(appEnv: string): EnvironmentState {
  if (!fs.existsSync(LOCAL_STATE_PATH)) {
    return {};
  }

  const raw = fs.readFileSync(LOCAL_STATE_PATH, "utf-8");
  const parsed = JSON.parse(raw) as LocalStateStore;
  return parsed[appEnv] ?? {};
}

export function writeEnvironmentState(
  appEnv: string,
  patch: EnvironmentState
): void {
  const existingStore: LocalStateStore = fs.existsSync(LOCAL_STATE_PATH)
    ? (JSON.parse(fs.readFileSync(LOCAL_STATE_PATH, "utf-8")) as LocalStateStore)
    : {};

  existingStore[appEnv] = {
    ...existingStore[appEnv],
    ...patch,
  };

  fs.mkdirSync(path.dirname(LOCAL_STATE_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_STATE_PATH, JSON.stringify(existingStore, null, 2));
}

