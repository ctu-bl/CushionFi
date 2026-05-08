export type AppEnv = "local" | "devnet" | "prod";
export type SolanaCluster = "localnet" | "devnet" | "mainnet";
export type KaminoNetwork = "devnet" | "mainnet";
export type KaminoDataSource = "api" | "rpc";

export interface EnvironmentProfile {
  appEnv: AppEnv;
  solanaCluster: SolanaCluster;
  solanaRpcUrl: string;
  solanaWsUrl: string;
  evmChainId: number | undefined;
  evmRpcUrl: string | undefined;
  kaminoNetwork: KaminoNetwork;
  kaminoDataSource: KaminoDataSource;
  cushionProgramId: string;
  cushionCollection?: string;
  enableLocalTestWallet: boolean;
}

export interface PublicEnvironmentConfig extends EnvironmentProfile {}

export interface ScriptEnvironmentConfig {
  appEnv: AppEnv;
  solanaCluster: SolanaCluster;
  solanaRpcUrl: string;
  solanaWsUrl: string;
  solanaKeypairPath: string;
  cushionProgramId: string;
  kaminoNetwork: KaminoNetwork;
  kaminoDataSource: KaminoDataSource;
  enableLocalTestWallet: boolean;
}

export const APP_ENVS: readonly AppEnv[];
export const DEFAULT_CUSHION_PROGRAM_ID_BY_APP_ENV: Record<AppEnv, string>;
export const DEFAULT_SOLANA_CLUSTER_BY_APP_ENV: Record<AppEnv, SolanaCluster>;
export const DEFAULT_SOLANA_KEYPAIR_PATH: string;
export const DEFAULT_SOLANA_RPC_URL_BY_APP_ENV: Record<AppEnv, string>;
export const DEFAULT_SOLANA_WS_URL_BY_APP_ENV: Record<AppEnv, string>;

export function normalizeAppEnv(value: string | undefined): AppEnv | undefined;
export function normalizeSolanaCluster(
  value: string | undefined
): SolanaCluster | undefined;
export function getAppEnvFromProcess(
  env?: Record<string, string | undefined>
): AppEnv;
export function getPublicAppEnvFromProcess(
  env?: Record<string, string | undefined>
): AppEnv;
export function getEnvironmentProfile(appEnv?: AppEnv): EnvironmentProfile;
export function getPublicEnvironmentConfig(
  env?: Record<string, string | undefined>
): PublicEnvironmentConfig;
export function getScriptEnvironmentConfig(
  env?: Record<string, string | undefined>
): ScriptEnvironmentConfig;
