import { Keypair } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";

export type RuntimeConfig = {
  appEnv: string;
  solanaCluster: string;
  solanaRpcUrl: string;
  solanaWsUrl: string;
  solanaKeypairPath: string;
};

function normalizeAppEnv(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "test") return "devnet";
  if (normalized === "production" || normalized === "mainnet") return "prod";
  if (normalized === "localhost" || normalized === "localnet") return "local";
  if (normalized === "local" || normalized === "devnet" || normalized === "prod") return normalized;
  return undefined;
}

export function getRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const appEnv =
    normalizeAppEnv(env.APP_ENV) ??
    normalizeAppEnv(env.NEXT_PUBLIC_APP_ENV) ??
    normalizeAppEnv(env.NEXT_PUBLIC_ENVIRONMENT) ??
    "local";

  const defaultCluster = appEnv === "local" ? "localnet" : appEnv === "devnet" ? "devnet" : "mainnet";
  const defaultRpcUrl =
    appEnv === "local"
      ? "http://127.0.0.1:8899"
      : appEnv === "devnet"
        ? "https://api.devnet.solana.com"
        : "https://api.mainnet-beta.solana.com";
  const defaultWsUrl =
    appEnv === "local"
      ? "ws://127.0.0.1:8900"
      : appEnv === "devnet"
        ? "wss://api.devnet.solana.com"
        : "wss://api.mainnet-beta.solana.com";

  return {
    appEnv,
    solanaCluster: env.SOLANA_CLUSTER?.trim() || env.SOLANA_NETWORK?.trim() || defaultCluster,
    solanaRpcUrl:
      env.ANCHOR_PROVIDER_URL?.trim() ||
      getScopedEnvValue(env, "SOLANA_RPC_URL", appEnv) ||
      defaultRpcUrl,
    solanaWsUrl:
      getScopedEnvValue(env, "SOLANA_WS_URL", appEnv) ||
      defaultWsUrl,
    solanaKeypairPath:
      env.ANCHOR_WALLET?.trim() ||
      getScopedEnvValue(env, "SOLANA_KEYPAIR", appEnv) ||
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

export function getScopedEnvValue(
  env: NodeJS.ProcessEnv,
  baseName: string,
  appEnv: string
): string | undefined {
  const normalizedEnv = appEnv.trim().toLowerCase();
  const suffixes =
    normalizedEnv === "devnet" ? ["DEVNET", "TEST"] : [normalizedEnv.toUpperCase()];

  for (const suffix of suffixes) {
    const value = env[`${baseName}_${suffix}`]?.trim();
    if (value) {
      return value;
    }
  }

  const fallback = env[baseName]?.trim();
  return fallback || undefined;
}

export function resolveScopedEnvValue(
  env: NodeJS.ProcessEnv,
  appEnv: string,
  baseName: string,
  fallback?: string
): string {
  return getScopedEnvValue(env, baseName, appEnv) ?? fallback ?? "";
}

function scopedSuffixForAppEnv(appEnv: string): string {
  const normalized = appEnv.trim().toLowerCase();
  if (normalized === "devnet") {
    return "DEVNET";
  }
  return normalized.toUpperCase();
}

function envSectionContent(sectionName: string, entries: Record<string, string>): string {
  const lines = [
    `# >>> ${sectionName} >>>`,
    ...Object.entries(entries).map(([key, value]) => `${key}=${value}`),
    `# <<< ${sectionName} <<<`,
  ];
  return `${lines.join("\n")}\n`;
}

export function upsertEnvSection(params: {
  envFilePath: string;
  sectionName: string;
  entries: Record<string, string>;
}): { path: string; keyCount: number } {
  const resolvedPath = path.resolve(expandHome(params.envFilePath));
  const nextSection = envSectionContent(params.sectionName, params.entries);
  const startMarker = `# >>> ${params.sectionName} >>>`;
  const endMarker = `# <<< ${params.sectionName} <<<`;

  const previous = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, "utf-8") : "";
  let next: string;

  const startIdx = previous.indexOf(startMarker);
  const endIdx = previous.indexOf(endMarker);
  if (startIdx >= 0 && endIdx >= startIdx) {
    const endLineIdx = previous.indexOf("\n", endIdx);
    const replaceEnd = endLineIdx >= 0 ? endLineIdx + 1 : previous.length;
    next = `${previous.slice(0, startIdx)}${nextSection}${previous.slice(replaceEnd)}`;
  } else {
    const separator = previous.length > 0 && !previous.endsWith("\n") ? "\n\n" : previous.length > 0 ? "\n" : "";
    next = `${previous}${separator}${nextSection}`;
  }

  fs.writeFileSync(resolvedPath, next, "utf-8");
  return { path: resolvedPath, keyCount: Object.keys(params.entries).length };
}

export function scopedEntries(appEnv: string, entries: Record<string, string>): Record<string, string> {
  const suffix = scopedSuffixForAppEnv(appEnv);
  const scoped: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    scoped[`${key}_${suffix}`] = value;
  }
  return scoped;
}
