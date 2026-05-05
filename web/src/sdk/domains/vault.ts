import { PublicKey, type ConfirmOptions, type Signer, type TransactionSignature } from "@solana/web3.js";
import type BN from "bn.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import type { CushionSdkContext } from "../core/context.ts";
import { assertU128, assertU64, toU64Bn } from "../core/amounts.ts";
import { buildTransaction, sendBuiltTransaction, type BuiltTx } from "../core/anchor.ts";
import {
  deriveVaultAddress,
  deriveVaultShareMintAddress,
  deriveVaultTokenAddress,
  deriveVaultTreasuryTokenAddress,
} from "../core/pda.ts";
import { ensureAtaInstruction } from "../core/token.ts";

const U64_MAX = (1n << 64n) - 1n;

type RawVaultAccount = {
  bump: number;
  authority: PublicKey;
  assetMint: PublicKey;
  shareMint: PublicKey;
  vaultTokenAccount: PublicKey;
  treasuryTokenAccount: PublicKey;
  totalManagedAssets: BN | bigint | string | number;
  minDeposit: BN | bigint | string | number;
  depositCap: BN | bigint | string | number;
  virtualAssets: BN | bigint | string | number;
  virtualShares: BN | bigint | string | number;
  marketPrice: BN | bigint | string | number;
  marketPriceLastUpdated: BN | bigint | string | number;
  interestLastUpdated: BN | bigint | string | number;
  accumulatedInterest: BN | bigint | string | number;
  interestRate: BN | bigint | string | number;
};

export type VaultState = {
  address: PublicKey;
  bump: number;
  authority: PublicKey;
  assetMint: PublicKey;
  shareMint: PublicKey;
  vaultTokenAccount: PublicKey;
  treasuryTokenAccount: PublicKey;
  totalManagedAssets: bigint;
  minDeposit: bigint;
  depositCap: bigint;
  virtualAssets: bigint;
  virtualShares: bigint;
  marketPrice: bigint;
  marketPriceLastUpdated: bigint;
  interestLastUpdated: bigint;
  accumulatedInterest: bigint;
  interestRate: bigint;
};

export type UserVaultPosition = {
  owner: PublicKey;
  assetMint: PublicKey;
  shareMint: PublicKey;
  userAssetAccount: PublicKey;
  userShareAccount: PublicKey;
  userAssetBalance: bigint;
  userShareBalance: bigint;
};

export type VaultQuote = {
  assets: bigint;
  shares: bigint;
};

export type BuildDepositTxInput = {
  owner?: PublicKey;
  assetMint: PublicKey;
  assetsIn: bigint;
  minSharesOut: bigint;
};

export type BuildMintTxInput = {
  owner?: PublicKey;
  assetMint: PublicKey;
  sharesOut: bigint;
  maxAssetsIn: bigint;
};

export type BuildWithdrawTxInput = {
  owner?: PublicKey;
  assetMint: PublicKey;
  assetsOut: bigint;
  maxSharesBurn: bigint;
};

export type BuildRedeemTxInput = {
  owner?: PublicKey;
  assetMint: PublicKey;
  sharesIn: bigint;
  minAssetsOut: bigint;
};

function toBigInt(value: BN | bigint | string | number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  return BigInt(value.toString(10));
}

function mulDivFloor(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("Division by zero");
  }
  return (a * b) / denominator;
}

function mulDivCeil(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("Division by zero");
  }
  const numerator = a * b;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder === 0n ? quotient : quotient + 1n;
}

function convertToSharesFloor(vault: VaultState, totalShares: bigint, assetsIn: bigint): bigint {
  const denominator = vault.totalManagedAssets + vault.virtualAssets;
  const numeratorRatio = totalShares + vault.virtualShares;

  if (denominator === 0n || numeratorRatio === 0n) {
    if (vault.totalManagedAssets !== 0n || totalShares !== 0n) {
      throw new Error("Invalid vault share state");
    }
    return assetsIn;
  }

  return mulDivFloor(assetsIn, numeratorRatio, denominator);
}

function convertToAssetsFloor(vault: VaultState, totalShares: bigint, sharesIn: bigint): bigint {
  const numeratorRatio = vault.totalManagedAssets + vault.virtualAssets;
  const denominator = totalShares + vault.virtualShares;

  if (denominator === 0n || numeratorRatio === 0n) {
    if (vault.totalManagedAssets !== 0n || totalShares !== 0n) {
      throw new Error("Invalid vault share state");
    }
    return sharesIn;
  }

  return mulDivFloor(sharesIn, numeratorRatio, denominator);
}

function convertToAssetsCeil(vault: VaultState, totalShares: bigint, sharesOut: bigint): bigint {
  const numeratorRatio = vault.totalManagedAssets + vault.virtualAssets;
  const denominator = totalShares + vault.virtualShares;

  if (denominator === 0n || numeratorRatio === 0n) {
    if (vault.totalManagedAssets !== 0n || totalShares !== 0n) {
      throw new Error("Invalid vault share state");
    }
    return sharesOut;
  }

  return mulDivCeil(sharesOut, numeratorRatio, denominator);
}

function convertToSharesCeil(vault: VaultState, totalShares: bigint, assetsOut: bigint): bigint {
  const numeratorRatio = totalShares + vault.virtualShares;
  const denominator = vault.totalManagedAssets + vault.virtualAssets;

  if (denominator === 0n || numeratorRatio === 0n) {
    if (vault.totalManagedAssets !== 0n || totalShares !== 0n) {
      throw new Error("Invalid vault share state");
    }
    return assetsOut;
  }

  return mulDivCeil(assetsOut, numeratorRatio, denominator);
}

async function fetchTotalShares(context: CushionSdkContext, shareMint: PublicKey): Promise<bigint> {
  const supply = await context.connection.getTokenSupply(shareMint, "confirmed");
  return BigInt(supply.value.amount);
}

function normalizeVault(address: PublicKey, account: RawVaultAccount): VaultState {
  return {
    address,
    bump: account.bump,
    authority: new PublicKey(account.authority),
    assetMint: new PublicKey(account.assetMint),
    shareMint: new PublicKey(account.shareMint),
    vaultTokenAccount: new PublicKey(account.vaultTokenAccount),
    treasuryTokenAccount: new PublicKey(account.treasuryTokenAccount),
    totalManagedAssets: toBigInt(account.totalManagedAssets),
    minDeposit: toBigInt(account.minDeposit),
    depositCap: toBigInt(account.depositCap),
    virtualAssets: toBigInt(account.virtualAssets),
    virtualShares: toBigInt(account.virtualShares),
    marketPrice: toBigInt(account.marketPrice),
    marketPriceLastUpdated: toBigInt(account.marketPriceLastUpdated),
    interestLastUpdated: toBigInt(account.interestLastUpdated),
    accumulatedInterest: toBigInt(account.accumulatedInterest),
    interestRate: toBigInt(account.interestRate),
  };
}

export function createVaultDomain(context: CushionSdkContext) {
  const program = context.program as unknown as {
    account: {
      vault: {
        fetch: (address: PublicKey) => Promise<RawVaultAccount>;
      };
    };
    methods: Record<string, (...args: unknown[]) => { accountsStrict: (accounts: Record<string, unknown>) => { transaction: () => Promise<import("@solana/web3.js").Transaction> } }>;
  };

  async function getVaultByAssetMint(assetMint: PublicKey): Promise<VaultState> {
    const vaultAddress = deriveVaultAddress(context.cushionProgramId, assetMint);
    const vaultAccount = await program.account.vault.fetch(vaultAddress);
    return normalizeVault(vaultAddress, vaultAccount);
  }

  async function getVault(vaultAddress: PublicKey): Promise<VaultState> {
    const vaultAccount = await program.account.vault.fetch(vaultAddress);
    return normalizeVault(vaultAddress, vaultAccount);
  }

  async function getUserVaultPosition(input: { owner?: PublicKey; assetMint: PublicKey }): Promise<UserVaultPosition> {
    const owner = input.owner ?? context.walletPublicKey;
    const vault = await getVaultByAssetMint(input.assetMint);

    const [assetAtaResult, shareAtaResult] = await Promise.all([
      ensureAtaInstruction({
        connection: context.connection,
        payer: owner,
        owner,
        mint: vault.assetMint,
      }),
      ensureAtaInstruction({
        connection: context.connection,
        payer: owner,
        owner,
        mint: vault.shareMint,
      }),
    ]);

    const [assetBalance, shareBalance] = await Promise.all([
      context.connection.getTokenAccountBalance(assetAtaResult.ata, "confirmed").catch(() => null),
      context.connection.getTokenAccountBalance(shareAtaResult.ata, "confirmed").catch(() => null),
    ]);

    return {
      owner,
      assetMint: vault.assetMint,
      shareMint: vault.shareMint,
      userAssetAccount: assetAtaResult.ata,
      userShareAccount: shareAtaResult.ata,
      userAssetBalance: BigInt(assetBalance?.value.amount ?? "0"),
      userShareBalance: BigInt(shareBalance?.value.amount ?? "0"),
    };
  }

  async function quoteDeposit(input: { assetMint: PublicKey; assetsIn: bigint }): Promise<VaultQuote> {
    const assetsIn = assertU64(input.assetsIn, "assetsIn");
    const vault = await getVaultByAssetMint(input.assetMint);
    const totalShares = await fetchTotalShares(context, vault.shareMint);
    return {
      assets: assetsIn,
      shares: convertToSharesFloor(vault, totalShares, assetsIn),
    };
  }

  async function quoteMint(input: { assetMint: PublicKey; sharesOut: bigint }): Promise<VaultQuote> {
    const sharesOut = assertU64(input.sharesOut, "sharesOut");
    const vault = await getVaultByAssetMint(input.assetMint);
    const totalShares = await fetchTotalShares(context, vault.shareMint);
    return {
      assets: convertToAssetsCeil(vault, totalShares, sharesOut),
      shares: sharesOut,
    };
  }

  async function quoteWithdraw(input: { assetMint: PublicKey; assetsOut: bigint }): Promise<VaultQuote> {
    const assetsOut = assertU64(input.assetsOut, "assetsOut");
    const vault = await getVaultByAssetMint(input.assetMint);
    const totalShares = await fetchTotalShares(context, vault.shareMint);
    return {
      assets: assetsOut,
      shares: convertToSharesCeil(vault, totalShares, assetsOut),
    };
  }

  async function quoteRedeem(input: { assetMint: PublicKey; sharesIn: bigint }): Promise<VaultQuote> {
    const sharesIn = assertU64(input.sharesIn, "sharesIn");
    const vault = await getVaultByAssetMint(input.assetMint);
    const totalShares = await fetchTotalShares(context, vault.shareMint);
    return {
      assets: convertToAssetsFloor(vault, totalShares, sharesIn),
      shares: sharesIn,
    };
  }

  async function buildDepositTx(input: BuildDepositTxInput): Promise<BuiltTx> {
    const owner = input.owner ?? context.walletPublicKey;
    const assetsIn = assertU64(input.assetsIn, "assetsIn");
    const minSharesOut = assertU64(input.minSharesOut, "minSharesOut");
    const vault = await getVaultByAssetMint(input.assetMint);

    const [assetAta, shareAta] = await Promise.all([
      ensureAtaInstruction({ connection: context.connection, payer: owner, owner, mint: vault.assetMint }),
      ensureAtaInstruction({ connection: context.connection, payer: owner, owner, mint: vault.shareMint }),
    ]);

    const preInstructions = [assetAta.createInstruction, shareAta.createInstruction].filter(
      (ix): ix is NonNullable<typeof ix> => ix !== null
    );

    const method = program.methods.deposit(toU64Bn(assetsIn, "assetsIn"), toU64Bn(minSharesOut, "minSharesOut")).accountsStrict({
      user: owner,
      assetMint: vault.assetMint,
      vault: vault.address,
      shareMint: vault.shareMint,
      userAssetAccount: assetAta.ata,
      userShareAccount: shareAta.ata,
      vaultTokenAccount: vault.vaultTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    });

    return buildTransaction({
      context,
      methodBuilder: method,
      preInstructions,
    });
  }

  async function deposit(input: BuildDepositTxInput, options?: ConfirmOptions): Promise<TransactionSignature> {
    const built = await buildDepositTx(input);
    return sendBuiltTransaction(context, built, options);
  }

  async function buildMintTx(input: BuildMintTxInput): Promise<BuiltTx> {
    const owner = input.owner ?? context.walletPublicKey;
    const sharesOut = assertU64(input.sharesOut, "sharesOut");
    const maxAssetsIn = assertU64(input.maxAssetsIn, "maxAssetsIn");
    const vault = await getVaultByAssetMint(input.assetMint);

    const [assetAta, shareAta] = await Promise.all([
      ensureAtaInstruction({ connection: context.connection, payer: owner, owner, mint: vault.assetMint }),
      ensureAtaInstruction({ connection: context.connection, payer: owner, owner, mint: vault.shareMint }),
    ]);

    const preInstructions = [assetAta.createInstruction, shareAta.createInstruction].filter(
      (ix): ix is NonNullable<typeof ix> => ix !== null
    );

    const method = program.methods
      .mint(toU64Bn(sharesOut, "sharesOut"), toU64Bn(maxAssetsIn, "maxAssetsIn"))
      .accountsStrict({
        user: owner,
        assetMint: vault.assetMint,
        vault: vault.address,
        shareMint: vault.shareMint,
        userAssetAccount: assetAta.ata,
        userShareAccount: shareAta.ata,
        vaultTokenAccount: vault.vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      });

    return buildTransaction({ context, methodBuilder: method, preInstructions });
  }

  async function mint(input: BuildMintTxInput, options?: ConfirmOptions): Promise<TransactionSignature> {
    const built = await buildMintTx(input);
    return sendBuiltTransaction(context, built, options);
  }

  async function buildWithdrawTx(input: BuildWithdrawTxInput): Promise<BuiltTx> {
    const owner = input.owner ?? context.walletPublicKey;
    const assetsOut = assertU64(input.assetsOut, "assetsOut");
    const maxSharesBurn = assertU64(input.maxSharesBurn, "maxSharesBurn");
    const vault = await getVaultByAssetMint(input.assetMint);

    const [assetAta, shareAta] = await Promise.all([
      ensureAtaInstruction({ connection: context.connection, payer: owner, owner, mint: vault.assetMint }),
      ensureAtaInstruction({ connection: context.connection, payer: owner, owner, mint: vault.shareMint }),
    ]);

    const preInstructions = [assetAta.createInstruction, shareAta.createInstruction].filter(
      (ix): ix is NonNullable<typeof ix> => ix !== null
    );

    const method = program.methods
      .withdraw(toU64Bn(assetsOut, "assetsOut"), toU64Bn(maxSharesBurn, "maxSharesBurn"))
      .accountsStrict({
        user: owner,
        assetMint: vault.assetMint,
        vault: vault.address,
        shareMint: vault.shareMint,
        userAssetAccount: assetAta.ata,
        userShareAccount: shareAta.ata,
        vaultTokenAccount: vault.vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      });

    return buildTransaction({ context, methodBuilder: method, preInstructions });
  }

  async function withdraw(
    input: BuildWithdrawTxInput,
    options?: ConfirmOptions
  ): Promise<TransactionSignature> {
    const built = await buildWithdrawTx(input);
    return sendBuiltTransaction(context, built, options);
  }

  async function buildRedeemTx(input: BuildRedeemTxInput): Promise<BuiltTx> {
    const owner = input.owner ?? context.walletPublicKey;
    const sharesIn = assertU64(input.sharesIn, "sharesIn");
    const minAssetsOut = assertU64(input.minAssetsOut, "minAssetsOut");
    const vault = await getVaultByAssetMint(input.assetMint);

    const [assetAta, shareAta] = await Promise.all([
      ensureAtaInstruction({ connection: context.connection, payer: owner, owner, mint: vault.assetMint }),
      ensureAtaInstruction({ connection: context.connection, payer: owner, owner, mint: vault.shareMint }),
    ]);

    const preInstructions = [assetAta.createInstruction, shareAta.createInstruction].filter(
      (ix): ix is NonNullable<typeof ix> => ix !== null
    );

    const method = program.methods
      .redeem(toU64Bn(sharesIn, "sharesIn"), toU64Bn(minAssetsOut, "minAssetsOut"))
      .accountsStrict({
        user: owner,
        assetMint: vault.assetMint,
        vault: vault.address,
        shareMint: vault.shareMint,
        userAssetAccount: assetAta.ata,
        userShareAccount: shareAta.ata,
        vaultTokenAccount: vault.vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      });

    return buildTransaction({ context, methodBuilder: method, preInstructions });
  }

  async function redeem(input: BuildRedeemTxInput, options?: ConfirmOptions): Promise<TransactionSignature> {
    const built = await buildRedeemTx(input);
    return sendBuiltTransaction(context, built, options);
  }

  return {
    deriveVaultAddress: (assetMint: PublicKey) => deriveVaultAddress(context.cushionProgramId, assetMint),
    deriveVaultShareMintAddress: (vault: PublicKey) => deriveVaultShareMintAddress(context.cushionProgramId, vault),
    deriveVaultTokenAddress: (vault: PublicKey) => deriveVaultTokenAddress(context.cushionProgramId, vault),
    deriveVaultTreasuryTokenAddress: (vault: PublicKey) =>
      deriveVaultTreasuryTokenAddress(context.cushionProgramId, vault),
    getVault,
    getVaultByAssetMint,
    getUserVaultPosition,
    quoteDeposit,
    quoteMint,
    quoteWithdraw,
    quoteRedeem,
    buildDepositTx,
    deposit,
    buildMintTx,
    mint,
    buildWithdrawTx,
    withdraw,
    buildRedeemTx,
    redeem,
  };
}
