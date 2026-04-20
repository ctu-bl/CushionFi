const APP_ENVS = ["local", "devnet", "prod"];

const DEFAULT_SOLANA_CLUSTER_BY_APP_ENV = {
  local: "localnet",
  devnet: "devnet",
  prod: "mainnet",
};

const DEFAULT_SOLANA_RPC_URL_BY_APP_ENV = {
  local: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
  prod: "https://api.mainnet-beta.solana.com",
};

const DEFAULT_EVM_CHAIN_ID_BY_APP_ENV = {
  local: undefined,
  devnet: 11155111,
  prod: 1,
};

const DEFAULT_EVM_RPC_URL_BY_APP_ENV = {
  local: undefined,
  devnet: "https://rpc.sepolia.org",
  prod: "https://ethereum-rpc.publicnode.com",
};

const DEFAULT_KAMINO_NETWORK_BY_APP_ENV = {
  local: "mainnet",
  devnet: "devnet",
  prod: "mainnet",
};

const DEFAULT_KAMINO_DATA_SOURCE_BY_APP_ENV = {
  local: "rpc",
  devnet: "api",
  prod: "api",
};

const DEFAULT_CUSHION_PROGRAM_ID_BY_APP_ENV = {
  local: "H8BhL28KxwHPyNyCNRQWb5MVVadqesiam9HQ9jPfmd8W",
  devnet: "H8BhL28KxwHPyNyCNRQWb5MVVadqesiam9HQ9jPfmd8W",
  prod: "H8BhL28KxwHPyNyCNRQWb5MVVadqesiam9HQ9jPfmd8W",
};

const DEFAULT_CUSHION_COLLECTION_BY_APP_ENV = {
  local: undefined,
  devnet: undefined,
  prod: undefined,
};

const DEFAULT_ENABLE_LOCAL_TEST_WALLET_BY_APP_ENV = {
  local: true,
  devnet: false,
  prod: false,
};

const DEFAULT_SOLANA_KEYPAIR_PATH = "~/.config/solana/id.json";

function normalizeString(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normalizeAppEnv(value) {
  const normalized = normalizeString(value)?.toLowerCase();

  if (!normalized) {
    return undefined;
  }

  if (normalized === "test") {
    return "devnet";
  }

  if (normalized === "production" || normalized === "mainnet") {
    return "prod";
  }

  if (normalized === "localhost" || normalized === "localnet") {
    return "local";
  }

  if (APP_ENVS.includes(normalized)) {
    return normalized;
  }

  return undefined;
}

function normalizeSolanaCluster(value) {
  const normalized = normalizeString(value)?.toLowerCase();

  if (!normalized) {
    return undefined;
  }

  if (
    normalized === "local" ||
    normalized === "localhost" ||
    normalized === "localnet"
  ) {
    return "localnet";
  }

  if (normalized === "devnet") {
    return "devnet";
  }

  if (
    normalized === "prod" ||
    normalized === "mainnet" ||
    normalized === "mainnet-beta"
  ) {
    return "mainnet";
  }

  return undefined;
}

function normalizeKaminoNetwork(value) {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === "mainnet" || normalized === "devnet") {
    return normalized;
  }
  return undefined;
}

function normalizeKaminoDataSource(value) {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === "api" || normalized === "rpc") {
    return normalized;
  }
  return undefined;
}

function parseOptionalNumber(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value, fallback = false) {
  const normalized = normalizeString(value)?.toLowerCase();

  if (!normalized) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(normalized);
}

function getScopedEnvValue(env, baseName, appEnv) {
  const suffixes =
    appEnv === "devnet" ? ["DEVNET", "TEST"] : [appEnv.toUpperCase()];

  for (const suffix of suffixes) {
    const value = normalizeString(env[`${baseName}_${suffix}`]);
    if (value) {
      return value;
    }
  }

  return normalizeString(env[baseName]);
}

function getAppEnvFromProcess(env = process.env) {
  return (
    normalizeAppEnv(env.APP_ENV) ??
    normalizeAppEnv(env.NEXT_PUBLIC_APP_ENV) ??
    normalizeAppEnv(env.NEXT_PUBLIC_ENVIRONMENT) ??
    "local"
  );
}

function getPublicAppEnvFromProcess(env = process.env) {
  return (
    normalizeAppEnv(env.NEXT_PUBLIC_APP_ENV) ??
    normalizeAppEnv(env.NEXT_PUBLIC_ENVIRONMENT) ??
    normalizeAppEnv(env.APP_ENV) ??
    "local"
  );
}

function getEnvironmentProfile(appEnv = "local") {
  return {
    appEnv,
    solanaCluster: DEFAULT_SOLANA_CLUSTER_BY_APP_ENV[appEnv],
    solanaRpcUrl: DEFAULT_SOLANA_RPC_URL_BY_APP_ENV[appEnv],
    evmChainId: DEFAULT_EVM_CHAIN_ID_BY_APP_ENV[appEnv],
    evmRpcUrl: DEFAULT_EVM_RPC_URL_BY_APP_ENV[appEnv],
    kaminoNetwork: DEFAULT_KAMINO_NETWORK_BY_APP_ENV[appEnv],
    kaminoDataSource: DEFAULT_KAMINO_DATA_SOURCE_BY_APP_ENV[appEnv],
    cushionProgramId: DEFAULT_CUSHION_PROGRAM_ID_BY_APP_ENV[appEnv],
    enableLocalTestWallet: DEFAULT_ENABLE_LOCAL_TEST_WALLET_BY_APP_ENV[appEnv],
  };
}

function getPublicEnvironmentConfig(env = process.env) {
  const appEnv = getPublicAppEnvFromProcess(env);
  const profile = getEnvironmentProfile(appEnv);

  return {
    appEnv,
    solanaCluster:
      normalizeSolanaCluster(env.NEXT_PUBLIC_SOLANA_CLUSTER) ??
      profile.solanaCluster,
    solanaRpcUrl:
      getScopedEnvValue(env, "NEXT_PUBLIC_SOLANA_RPC_URL", appEnv) ??
      profile.solanaRpcUrl,
    evmChainId:
      parseOptionalNumber(
        getScopedEnvValue(env, "NEXT_PUBLIC_EVM_CHAIN_ID", appEnv)
      ) ?? profile.evmChainId,
    evmRpcUrl:
      getScopedEnvValue(env, "NEXT_PUBLIC_EVM_RPC_URL", appEnv) ??
      profile.evmRpcUrl,
    kaminoNetwork:
      normalizeKaminoNetwork(
        getScopedEnvValue(env, "NEXT_PUBLIC_KAMINO_NETWORK", appEnv)
      ) ?? profile.kaminoNetwork,
    kaminoDataSource:
      normalizeKaminoDataSource(
        getScopedEnvValue(env, "NEXT_PUBLIC_KAMINO_DATA_SOURCE", appEnv)
      ) ?? profile.kaminoDataSource,
    cushionProgramId:
      getScopedEnvValue(env, "NEXT_PUBLIC_CUSHION_PROGRAM_ID", appEnv) ??
      getScopedEnvValue(env, "NEXT_PUBLIC_VAULT_PROGRAM_ID", appEnv) ??
      profile.cushionProgramId,
    cushionCollection:
      getScopedEnvValue(env, "NEXT_PUBLIC_CUSHION_COLLECTION", appEnv) ??
      DEFAULT_CUSHION_COLLECTION_BY_APP_ENV[appEnv],
    enableLocalTestWallet: parseBoolean(
      getScopedEnvValue(env, "NEXT_PUBLIC_ENABLE_LOCAL_TEST_WALLET", appEnv),
      profile.enableLocalTestWallet
    ),
  };
}

function getScriptEnvironmentConfig(env = process.env) {
  const appEnv = getAppEnvFromProcess(env);
  const profile = getEnvironmentProfile(appEnv);
  const solanaCluster =
    normalizeSolanaCluster(env.SOLANA_CLUSTER ?? env.SOLANA_NETWORK) ??
    profile.solanaCluster;

  return {
    appEnv,
    solanaCluster,
    solanaRpcUrl:
      getScopedEnvValue(env, "SOLANA_RPC_URL", appEnv) ??
      normalizeString(env.ANCHOR_PROVIDER_URL) ??
      DEFAULT_SOLANA_RPC_URL_BY_APP_ENV[appEnv],
    solanaKeypairPath:
      getScopedEnvValue(env, "SOLANA_KEYPAIR", appEnv) ??
      normalizeString(env.ANCHOR_WALLET) ??
      DEFAULT_SOLANA_KEYPAIR_PATH,
    cushionProgramId:
      getScopedEnvValue(env, "CUSHION_PROGRAM_ID", appEnv) ??
      profile.cushionProgramId,
    kaminoNetwork:
      normalizeKaminoNetwork(
        getScopedEnvValue(env, "KAMINO_NETWORK", appEnv)
      ) ?? profile.kaminoNetwork,
    kaminoDataSource:
      normalizeKaminoDataSource(
        getScopedEnvValue(env, "KAMINO_DATA_SOURCE", appEnv)
      ) ?? profile.kaminoDataSource,
    enableLocalTestWallet: parseBoolean(
      getScopedEnvValue(env, "ENABLE_LOCAL_TEST_WALLET", appEnv),
      profile.enableLocalTestWallet
    ),
  };
}

export {
  APP_ENVS,
  DEFAULT_CUSHION_PROGRAM_ID_BY_APP_ENV,
  DEFAULT_SOLANA_CLUSTER_BY_APP_ENV,
  DEFAULT_SOLANA_KEYPAIR_PATH,
  DEFAULT_SOLANA_RPC_URL_BY_APP_ENV,
  getAppEnvFromProcess,
  getPublicAppEnvFromProcess,
  getEnvironmentProfile,
  getPublicEnvironmentConfig,
  getScriptEnvironmentConfig,
  normalizeAppEnv,
  normalizeSolanaCluster,
};
