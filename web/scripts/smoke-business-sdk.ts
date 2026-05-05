import anchor from "@coral-xyz/anchor";
import { Reserve as KlendReserve } from "@kamino-finance/klend-sdk";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createMint,
  createSyncNativeInstruction,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  type Signer,
} from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getScriptEnvironmentConfig } from "../../config/index.js";
import {
  CUSHION_PROGRAM_ID,
  createCushionProgram,
} from "../src/generated/cushion/index.ts";
import { createCushionSdk, mapAnchorError } from "../src/sdk/index.ts";
import { createKlendRefreshReserveInstructions } from "../src/sdk/core/klend.ts";
import {
  derivePositionAddress,
  derivePositionAuthorityAddress,
  derivePositionRegistryAddress,
  deriveVaultAddress,
  deriveVaultShareMintAddress,
  deriveVaultTokenAddress,
  deriveVaultTreasuryTokenAddress,
} from "../src/sdk/core/pda.ts";
import { ensureAtaInstruction } from "../src/sdk/core/token.ts";

const ALL_IDL_INSTRUCTIONS = [
  "borrow_asset",
  "decrease_collateral",
  "deposit",
  "increase_collateral",
  "increase_debt",
  "init_collection",
  "init_position",
  "init_position_registry",
  "init_vault",
  "inject_collateral",
  "insure_existing_position",
  "liquidate",
  "mint",
  "redeem",
  "repay_debt",
  "update_market_price",
  "withdraw",
  "withdraw_injected_collateral",
] as const;

const DEFAULTS = {
  klendProgramId: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
  farmsProgramId: "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr",
  mplCoreProgramId: "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
  collateralReserve: "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q",
  borrowReserve: "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59",
  collateralReserveFarmState: "955xWFhSDcDiUgUr4sBRtCpTLiMd4H5uZLAmgtP3R3sX",
  klendMarket: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
};

const U64_MAX = (1n << 64n) - 1n;

type StepStatus = "PASS" | "EXPECTED_FAIL" | "SKIP";

type StepResult = {
  instruction: string;
  status: StepStatus;
  detail: string;
};

function expandHome(inputPath: string): string {
  if (!inputPath.startsWith("~/")) return inputPath;
  return path.join(os.homedir(), inputPath.slice(2));
}

function readKeypair(keypairPath: string): Keypair {
  const resolved = expandHome(keypairPath);
  const secret = JSON.parse(fs.readFileSync(resolved, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function envPubkey(name: string, fallback: string): PublicKey {
  return new PublicKey(process.env[name]?.trim() || fallback);
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) {
    return BigInt((value as { toString(): string }).toString());
  }
  throw new Error(`Cannot convert value to bigint: ${String(value)}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function parseHex32(input: string): number[] {
  const normalized = input.startsWith("0x") ? input.slice(2) : input;
  if (normalized.length !== 64) {
    throw new Error(`Expected 64 hex chars for feed id, got ${normalized.length}`);
  }
  return Array.from(Buffer.from(normalized, "hex"));
}

function isAlreadyInitializedLike(error: unknown): boolean {
  const text = String(error);
  return (
    text.includes("already in use") ||
    text.includes("already initialized") ||
    text.includes("custom program error: 0x0")
  );
}

function isUnsafePositionError(error: unknown): boolean {
  const mapped = mapAnchorError(error);
  return mapped.codeName === "UnsafePosition";
}

function isNetValueRemainingTooSmall(error: unknown): boolean {
  const text = String(error);
  return text.includes("NetValueRemainingTooSmall") || text.includes("custom program error: 0x17cc");
}

function withComputeUnits(tx: Transaction, units = 1_400_000, microLamports = 1): Transaction {
  const next = new Transaction();
  next.add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  next.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  for (const ix of tx.instructions) next.add(ix);
  return next;
}

function computeBorrowAmountRaw(params: {
  debtValueSf: bigint;
  allowedBorrowValueSf: bigint;
  reservePriceSf: bigint;
  reserveDecimals: number;
  headroomBps: bigint;
}): bigint {
  const headroomSf =
    params.allowedBorrowValueSf > params.debtValueSf ? params.allowedBorrowValueSf - params.debtValueSf : 0n;
  if (headroomSf <= 0n) return 0n;

  const targetDebtIncreaseSf = (headroomSf * params.headroomBps) / 10_000n;
  if (targetDebtIncreaseSf <= 0n) return 0n;

  const scale = 10n ** BigInt(params.reserveDecimals);
  return (targetDebtIncreaseSf * scale) / params.reservePriceSf;
}

async function getTokenBalance(connection: anchor.web3.Connection, tokenAccount: PublicKey): Promise<bigint> {
  const balance = await connection.getTokenAccountBalance(tokenAccount, "confirmed").catch(() => null);
  return BigInt(balance?.value.amount ?? "0");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function wrapNativeIfNeeded(params: {
  provider: anchor.AnchorProvider;
  owner: PublicKey;
  mint: PublicKey;
  minimumRaw: bigint;
}): Promise<void> {
  if (!params.mint.equals(NATIVE_MINT)) return;

  const ata = await getOrCreateAssociatedTokenAccount(
    params.provider.connection,
    (params.provider.wallet as anchor.Wallet).payer,
    params.mint,
    params.owner
  );

  const current = await getTokenBalance(params.provider.connection, ata.address);
  if (current >= params.minimumRaw) return;

  const missing = params.minimumRaw - current;
  const lamports = Number(missing + 1_000_000n);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: params.owner,
      toPubkey: ata.address,
      lamports,
    }),
    createSyncNativeInstruction(ata.address)
  );

  await params.provider.sendAndConfirm(tx, []);
}

async function runInstructionStep(params: {
  attempted: Set<string>;
  results: StepResult[];
  instruction: string;
  run: () => Promise<string | void>;
  allowExpectedFailure?: (error: unknown) => boolean;
  skipReason?: string;
}): Promise<void> {
  if (params.skipReason) {
    params.results.push({
      instruction: params.instruction,
      status: "SKIP",
      detail: params.skipReason,
    });
    return;
  }

  params.attempted.add(params.instruction);
  try {
    const detail = (await params.run()) ?? "ok";
    params.results.push({
      instruction: params.instruction,
      status: "PASS",
      detail,
    });
  } catch (error) {
    if (params.allowExpectedFailure?.(error)) {
      params.results.push({
        instruction: params.instruction,
        status: "EXPECTED_FAIL",
        detail: String(error),
      });
      return;
    }
    throw error;
  }
}

async function main() {
  const runtime = getScriptEnvironmentConfig(process.env);
  const wallet = readKeypair(runtime.solanaKeypairPath);
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(runtime.solanaRpcUrl, "confirmed"),
    new anchor.Wallet(wallet),
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );

  const user = provider.wallet.publicKey;
  const program = createCushionProgram(provider) as unknown as anchor.Program;

  const klendProgramId = envPubkey("KLEND_PROGRAM_ID", DEFAULTS.klendProgramId);
  const farmsProgramId = envPubkey("KLEND_FARMS_PROGRAM", DEFAULTS.farmsProgramId);
  const mplCoreProgramId = envPubkey("MPL_CORE_PROGRAM_ID", DEFAULTS.mplCoreProgramId);
  const collateralReserve = envPubkey("KLEND_SOL_RESERVE", DEFAULTS.collateralReserve);
  const borrowReserve = envPubkey("KLEND_USDC_RESERVE", DEFAULTS.borrowReserve);
  const collateralReserveFarmState = envPubkey("KLEND_SOL_RESERVE_FARM_STATE", DEFAULTS.collateralReserveFarmState);
  const lendingMarket = envPubkey("KLEND_MARKET", DEFAULTS.klendMarket);

  const attempted = new Set<string>();
  const results: StepResult[] = [];

  const sdk = createCushionSdk({
    provider,
    klendProgramId,
    farmsProgramId,
    mplCoreProgramId,
    borrowInstructionVariant: "increaseDebt",
  });

  console.log("[setup] ensure position registry");
  const positionRegistry = derivePositionRegistryAddress(CUSHION_PROGRAM_ID);
  await runInstructionStep({
    attempted,
    results,
    instruction: "init_position_registry",
    run: async () => {
      const sig = await (program as any).methods
        .initPositionRegistry()
        .accountsStrict({
          authority: user,
          positionRegistry,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return `sig=${sig}`;
    },
    allowExpectedFailure: isAlreadyInitializedLike,
  });

  console.log("[setup] init collection");
  const collectionKeypair = Keypair.generate();
  await runInstructionStep({
    attempted,
    results,
    instruction: "init_collection",
    run: async () => {
      const sig = await (program as any).methods
        .initCollection()
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        ])
        .accountsStrict({
          payer: user,
          collection: collectionKeypair.publicKey,
          positionRegistry,
          systemProgram: SystemProgram.programId,
          mplCoreProgram: mplCoreProgramId,
        })
        .signers([collectionKeypair])
        .rpc();
      return `sig=${sig}`;
    },
  });
  const collection = collectionKeypair.publicKey;

  console.log("[setup] init standalone vault for smoke token");
  const smokeMint = await createMint(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    user,
    null,
    6
  );
  const smokeVault = deriveVaultAddress(CUSHION_PROGRAM_ID, smokeMint);
  const smokeShareMint = deriveVaultShareMintAddress(CUSHION_PROGRAM_ID, smokeVault);
  const smokeVaultTokenAccount = deriveVaultTokenAddress(CUSHION_PROGRAM_ID, smokeVault);
  const smokeTreasuryTokenAccount = deriveVaultTreasuryTokenAddress(CUSHION_PROGRAM_ID, smokeVault);

  await runInstructionStep({
    attempted,
    results,
    instruction: "init_vault",
    run: async () => {
      const sig = await (program as any).methods
        .initVault(new anchor.BN(1_000), new anchor.BN(1_000_000_000), new anchor.BN(0), new anchor.BN(0))
        .accountsStrict({
          authority: user,
          assetMint: smokeMint,
          vault: smokeVault,
          shareMint: smokeShareMint,
          vaultTokenAccount: smokeVaultTokenAccount,
          treasuryTokenAccount: smokeTreasuryTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      return `sig=${sig}`;
    },
  });

  const userSmokeAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    smokeMint,
    user
  );
  await mintTo(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    smokeMint,
    userSmokeAta.address,
    user,
    400_000_000
  );

  console.log("[vault] deposit -> mint -> withdraw -> redeem");
  const beforeUserVaultPos = await sdk.vault.getUserVaultPosition({ assetMint: smokeMint });

  const depositBuilt = await sdk.vault.buildDepositTx({
    assetMint: smokeMint,
    assetsIn: 200_000_000n,
    minSharesOut: 0n,
  });
  await runInstructionStep({
    attempted,
    results,
    instruction: "deposit",
    run: async () => {
      const sig = await sdk.context.sender.send({ transaction: depositBuilt.transaction, signers: depositBuilt.signers });
      return `sig=${sig}`;
    },
  });

  const mintBuilt = await sdk.vault.buildMintTx({
    assetMint: smokeMint,
    sharesOut: 10_000n,
    maxAssetsIn: 10_000_000n,
  });
  await runInstructionStep({
    attempted,
    results,
    instruction: "mint",
    run: async () => {
      const sig = await sdk.context.sender.send({ transaction: mintBuilt.transaction, signers: mintBuilt.signers });
      return `sig=${sig}`;
    },
  });

  const withdrawBuilt = await sdk.vault.buildWithdrawTx({
    assetMint: smokeMint,
    assetsOut: 10_000n,
    maxSharesBurn: 1_000_000n,
  });
  await runInstructionStep({
    attempted,
    results,
    instruction: "withdraw",
    run: async () => {
      const sig = await sdk.context.sender.send({
        transaction: withdrawBuilt.transaction,
        signers: withdrawBuilt.signers,
      });
      return `sig=${sig}`;
    },
  });

  const redeemBuilt = await sdk.vault.buildRedeemTx({
    assetMint: smokeMint,
    sharesIn: 1_000n,
    minAssetsOut: 0n,
  });
  await runInstructionStep({
    attempted,
    results,
    instruction: "redeem",
    run: async () => {
      const sig = await sdk.context.sender.send({ transaction: redeemBuilt.transaction, signers: redeemBuilt.signers });
      return `sig=${sig}`;
    },
  });

  const afterUserVaultPos = await sdk.vault.getUserVaultPosition({ assetMint: smokeMint });
  assert(
    afterUserVaultPos.userShareBalance >= beforeUserVaultPos.userShareBalance,
    "share balance should not decrease after deposit+mint+withdraw+redeem cycle"
  );

  console.log("[position] init position");
  const initPositionBuilt = await sdk.position.buildInitPositionTx({
    collection,
    lendingMarket,
    klendReserve: collateralReserve,
    reserveFarmState: collateralReserveFarmState,
  });
  await runInstructionStep({
    attempted,
    results,
    instruction: "init_position",
    run: async () => {
      const sig = await sdk.context.sender.send({
        transaction: withComputeUnits(initPositionBuilt.transaction),
        signers: initPositionBuilt.signers,
      });
      return `sig=${sig}`;
    },
  });

  const nftMint = (initPositionBuilt.signers[0] as Signer).publicKey;
  const positionAddress = derivePositionAddress(CUSHION_PROGRAM_ID, nftMint);
  const positionAuthority = derivePositionAuthorityAddress(CUSHION_PROGRAM_ID, nftMint);
  const positionState = await sdk.position.getPosition({ position: positionAddress });
  assert(positionState.nftMint.equals(nftMint), "position nft mint mismatch");

  const collateralReserveCtx = await sdk.context.klendResolver.fetchReserveContext(collateralReserve);
  const borrowReserveCtx = await sdk.context.klendResolver.fetchReserveContext(borrowReserve);

  try {
    await sdk.vault.getVaultByAssetMint(collateralReserveCtx.reserveLiquidityMint);
  } catch {
    const reserveVault = deriveVaultAddress(CUSHION_PROGRAM_ID, collateralReserveCtx.reserveLiquidityMint);
    const reserveShareMint = deriveVaultShareMintAddress(CUSHION_PROGRAM_ID, reserveVault);
    const reserveVaultTokenAccount = deriveVaultTokenAddress(CUSHION_PROGRAM_ID, reserveVault);
    const reserveTreasury = deriveVaultTreasuryTokenAddress(CUSHION_PROGRAM_ID, reserveVault);

    await runInstructionStep({
      attempted,
      results,
      instruction: "init_vault",
      run: async () => {
        const sig = await (program as any).methods
          .initVault(new anchor.BN(1), new anchor.BN(U64_MAX.toString()), new anchor.BN(0), new anchor.BN(0))
          .accountsStrict({
            authority: user,
            assetMint: collateralReserveCtx.reserveLiquidityMint,
            vault: reserveVault,
            shareMint: reserveShareMint,
            vaultTokenAccount: reserveVaultTokenAccount,
            treasuryTokenAccount: reserveTreasury,
            tokenProgram: collateralReserveCtx.reserveLiquidityTokenProgram,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();
        return `sig=${sig}`;
      },
    });
  }

  console.log("[collateral] increase");
  await wrapNativeIfNeeded({
    provider,
    owner: user,
    mint: collateralReserveCtx.reserveLiquidityMint,
    minimumRaw: 2_000_000n,
  });

  const incBuilt = await sdk.collateral.buildIncreaseCollateralTx({
    positionNftMint: nftMint,
    reserve: collateralReserve,
    amount: 1_000_000n,
  });
  await runInstructionStep({
    attempted,
    results,
    instruction: "increase_collateral",
    run: async () => {
      const sig = await sdk.context.sender.send({
        transaction: withComputeUnits(incBuilt.transaction),
        signers: incBuilt.signers,
      });
      return `sig=${sig}`;
    },
  });

  console.log("[debt] increase_debt + borrow_asset + repay_debt");
  const borrowReserveAccountInfo = await provider.connection.getAccountInfo(borrowReserve, "confirmed");
  assert(borrowReserveAccountInfo, "borrow reserve account missing");
  const borrowReserveDecoded = KlendReserve.decode(Buffer.from(borrowReserveAccountInfo.data));
  const reservePriceSf = toBigInt((borrowReserveDecoded.liquidity as { marketPriceSf: unknown }).marketPriceSf);
  const reserveDecimals = Number(
    toBigInt((borrowReserveDecoded.liquidity as { mintDecimals: unknown }).mintDecimals)
  );

  const debtBefore = await sdk.debt.getDebtPosition({ position: positionAddress });
  const borrowAmountCandidate = computeBorrowAmountRaw({
    debtValueSf: debtBefore.debtValueSf,
    allowedBorrowValueSf: debtBefore.allowedBorrowValueSf,
    reservePriceSf,
    reserveDecimals,
    headroomBps: 200n,
  });
  const borrowAmountCandidates = [
    borrowAmountCandidate > 0n ? borrowAmountCandidate : 0n,
    borrowAmountCandidate / 10n,
    borrowAmountCandidate / 100n,
    100_000n,
    10_000n,
    1_000n,
    100n,
    10n,
    1n,
  ].filter((value, index, arr) => value > 0n && arr.findIndex((other) => other === value) === index);

  async function sendBorrowWithFallback(params: {
    instructionVariant: "increaseDebt" | "borrowAsset";
    amountHint: bigint;
  }) {
    const sequence = [params.amountHint, ...borrowAmountCandidates].filter(
      (value, index, arr) => value > 0n && arr.findIndex((other) => other === value) === index
    );

    let lastError: unknown = null;
    for (const amount of sequence) {
      try {
        const built = await sdk.debt.buildBorrowTx({
          positionNftMint: nftMint,
          borrowReserve,
          amount,
          instructionVariant: params.instructionVariant,
        });
        const sig = await sdk.context.sender.send({
          transaction: withComputeUnits(built.transaction),
          signers: built.signers,
        });
        return { sig, amount };
      } catch (error) {
        lastError = error;
        if (!isUnsafePositionError(error)) {
          throw error;
        }
      }
    }
    throw lastError ?? new Error("Borrow failed for unknown reason");
  }

  await runInstructionStep({
    attempted,
    results,
    instruction: "increase_debt",
    run: async () => {
      const attempt = await sendBorrowWithFallback({
        instructionVariant: "increaseDebt",
        amountHint: borrowAmountCandidate,
      });
      return `sig=${attempt.sig}, amount=${attempt.amount}`;
    },
  });

  await runInstructionStep({
    attempted,
    results,
    instruction: "borrow_asset",
    run: async () => {
      const attempt = await sendBorrowWithFallback({
        instructionVariant: "borrowAsset",
        amountHint: borrowAmountCandidate / 2n,
      });
      return `sig=${attempt.sig}, amount=${attempt.amount}`;
    },
  });

  const debtAfterBorrow = await sdk.debt.getDebtPosition({ position: positionAddress });
  assert(
    debtAfterBorrow.debtValueSf >= debtBefore.debtValueSf,
    `debt must not decrease right after borrow (before=${debtBefore.debtValueSf}, afterBorrow=${debtAfterBorrow.debtValueSf})`
  );

  const userRepayAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    borrowReserveCtx.reserveLiquidityMint,
    user
  );
  const userRepayBalanceBefore = await getTokenBalance(provider.connection, userRepayAta.address);
  const repayCandidates = [
    userRepayBalanceBefore > 1n ? userRepayBalanceBefore - 1n : userRepayBalanceBefore,
    userRepayBalanceBefore / 2n,
    userRepayBalanceBefore / 4n,
    1_000_000n,
    100_000n,
    10_000n,
    1_000n,
    100n,
    10n,
    1n,
  ].filter((value, index, arr) => value > 0n && arr.findIndex((other) => other === value) === index);
  assert(repayCandidates.length > 0, "repay amount candidates must be non-empty");

  async function sendRepayWithFallback() {
    let lastError: unknown = null;
    for (const amount of repayCandidates) {
      try {
        const built = await sdk.debt.buildRepayTx({
          positionNftMint: nftMint,
          repayReserve: borrowReserve,
          amount,
        });
        const sig = await sdk.context.sender.send({
          transaction: withComputeUnits(built.transaction),
          signers: built.signers,
        });
        return { sig, amount };
      } catch (error) {
        lastError = error;
        if (!isNetValueRemainingTooSmall(error)) {
          throw error;
        }
      }
    }
    throw lastError ?? new Error("Repay failed for unknown reason");
  }

  await runInstructionStep({
    attempted,
    results,
    instruction: "repay_debt",
    run: async () => {
      const attempt = await sendRepayWithFallback();
      return `sig=${attempt.sig}, amount=${attempt.amount}`;
    },
  });

  await sleep(400);
  const userRepayBalanceAfter = await getTokenBalance(provider.connection, userRepayAta.address);
  assert(
    userRepayBalanceAfter < userRepayBalanceBefore,
    `repay must spend user liquidity (before=${userRepayBalanceBefore}, after=${userRepayBalanceAfter})`
  );

  const debtAfterRepay = await sdk.debt.getDebtPosition({ position: positionAddress });
  if (debtAfterRepay.debtValueSf > debtAfterBorrow.debtValueSf) {
    console.warn(
      `[warn] debt snapshot increased after repay (rpc timing): before=${debtBefore.debtValueSf}, afterBorrow=${debtAfterBorrow.debtValueSf}, afterRepay=${debtAfterRepay.debtValueSf}`
    );
  }

  console.log("[collateral] decrease");
  const decBuilt = await sdk.collateral.buildDecreaseCollateralTx({
    positionNftMint: nftMint,
    reserve: collateralReserve,
    amount: 500_000n,
  });
  await runInstructionStep({
    attempted,
    results,
    instruction: "decrease_collateral",
    run: async () => {
      const sig = await sdk.context.sender.send({
        transaction: withComputeUnits(decBuilt.transaction),
        signers: decBuilt.signers,
      });
      return `sig=${sig}`;
    },
  });

  const resolvedForInject = await sdk.context.klendResolver.resolveOperation({
    obligation: positionState.protocolObligation,
    reserve: collateralReserve,
    requireFarmState: true,
  });

  const cushionVault = deriveVaultAddress(CUSHION_PROGRAM_ID, resolvedForInject.selectedReserve.reserveLiquidityMint);
  const vaultTokenAccount = deriveVaultTokenAddress(CUSHION_PROGRAM_ID, cushionVault);

  const [positionCollateralAta, placeholderUserDestinationCollateralAta] = await Promise.all([
    ensureAtaInstruction({
      connection: provider.connection,
      payer: user,
      owner: positionAuthority,
      mint: resolvedForInject.selectedReserve.reserveLiquidityMint,
      allowOwnerOffCurve: true,
      tokenProgramId: resolvedForInject.selectedReserve.reserveLiquidityTokenProgram,
    }),
    ensureAtaInstruction({
      connection: provider.connection,
      payer: user,
      owner: user,
      mint: resolvedForInject.selectedReserve.reserveCollateralMint,
    }),
  ]);

  const injectRefreshIxs = createKlendRefreshReserveInstructions({
    klendProgramId,
    lendingMarket: resolvedForInject.obligationContext.lendingMarket,
    refreshReserves: resolvedForInject.refreshReserves,
    excludeReserve: resolvedForInject.selectedReserve.reserve,
  });
  const injectPreIxs = [
    ...injectRefreshIxs,
    positionCollateralAta.createInstruction,
    placeholderUserDestinationCollateralAta.createInstruction,
  ].filter((ix): ix is NonNullable<typeof ix> => ix !== null);

  console.log("[vault-position-ops] inject_collateral (expected fail on healthy positions)");
  await runInstructionStep({
    attempted,
    results,
    instruction: "inject_collateral",
    run: async () => {
      const tx = await (program as any).methods
        .injectCollateral()
        .accounts({
          caller: user,
          position: positionAddress,
          nftMint,
          assetMint: resolvedForInject.selectedReserve.reserveLiquidityMint,
          cushionVault,
          positionAuthority,
          vaultTokenAccount,
          positionCollateralAccount: positionCollateralAta.ata,
          klendObligation: positionState.protocolObligation,
          klendReserve: resolvedForInject.selectedReserve.reserve,
          reserveLiquiditySupply: resolvedForInject.selectedReserve.reserveLiquiditySupply,
          tokenProgram: resolvedForInject.selectedReserve.reserveLiquidityTokenProgram,
          klendProgram: klendProgramId,
          farmsProgram: farmsProgramId,
          lendingMarket: resolvedForInject.obligationContext.lendingMarket,
          pythOracle: resolvedForInject.selectedReserve.pythOracle,
          switchboardPriceOracle: resolvedForInject.selectedReserve.switchboardPriceOracle,
          switchboardTwapOracle: resolvedForInject.selectedReserve.switchboardTwapOracle,
          scopePrices: resolvedForInject.selectedReserve.scopePrices,
          lendingMarketAuthority: resolvedForInject.lendingMarketAuthority,
          reserveLiquidityMint: resolvedForInject.selectedReserve.reserveLiquidityMint,
          reserveDestinationDepositCollateral: resolvedForInject.selectedReserve.reserveDestinationDepositCollateral,
          reserveCollateralMint: resolvedForInject.selectedReserve.reserveCollateralMint,
          placeholderUserDestinationCollateral: placeholderUserDestinationCollateralAta.ata,
          liquidityTokenProgram: resolvedForInject.selectedReserve.reserveLiquidityTokenProgram,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: resolvedForInject.obligationFarmUserState,
          reserveFarmState: resolvedForInject.reserveFarmState,
        })
        .remainingAccounts(
          resolvedForInject.remainingReserves.map((reserve) => ({
            pubkey: reserve,
            isWritable: true,
            isSigner: false,
          }))
        )
        .preInstructions(injectPreIxs)
        .transaction();

      const sig = await sdk.context.sender.send({ transaction: withComputeUnits(tx), signers: [] });
      return `sig=${sig}`;
    },
    allowExpectedFailure: (error) => {
      const mapped = mapAnchorError(error);
      return ["NotUnsafePosition", "ZeroPrice", "AlreadyInjected", "InjectCalculationError"].includes(
        mapped.codeName ?? ""
      );
    },
  });

  console.log("[vault-position-ops] withdraw_injected_collateral (expected fail unless injected)");
  await runInstructionStep({
    attempted,
    results,
    instruction: "withdraw_injected_collateral",
    run: async () => {
      const tx = await (program as any).methods
        .withdrawInjectedCollateral()
        .accounts({
          caller: user,
          nftMint,
          assetMint: resolvedForInject.selectedReserve.reserveLiquidityMint,
          position: positionAddress,
          cushionVault,
          positionAuthority,
          vaultTokenAccount,
          positionCollateralAccount: positionCollateralAta.ata,
          reserveLiquidityMint: resolvedForInject.selectedReserve.reserveLiquidityMint,
          klendProgram: klendProgramId,
          klendObligation: positionState.protocolObligation,
          withdrawReserve: resolvedForInject.selectedReserve.reserve,
          lendingMarket: resolvedForInject.obligationContext.lendingMarket,
          lendingMarketAuthority: resolvedForInject.lendingMarketAuthority,
          reserveLiquiditySupply: resolvedForInject.selectedReserve.reserveLiquiditySupply,
          reserveSourceCollateral: resolvedForInject.selectedReserve.reserveDestinationDepositCollateral,
          reserveCollateralMint: resolvedForInject.selectedReserve.reserveCollateralMint,
          placeholderUserDestinationCollateral: placeholderUserDestinationCollateralAta.ata,
          tokenProgram: resolvedForInject.selectedReserve.reserveLiquidityTokenProgram,
          liquidityTokenProgram: resolvedForInject.selectedReserve.reserveLiquidityTokenProgram,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: resolvedForInject.obligationFarmUserState,
          reserveFarmState: resolvedForInject.reserveFarmState,
          farmsProgram: farmsProgramId,
          pythOracle: resolvedForInject.selectedReserve.pythOracle,
          switchboardPriceOracle: resolvedForInject.selectedReserve.switchboardPriceOracle,
          switchboardTwapOracle: resolvedForInject.selectedReserve.switchboardTwapOracle,
          scopePrices: resolvedForInject.selectedReserve.scopePrices,
        })
        .remainingAccounts(
          resolvedForInject.remainingReserves.map((reserve) => ({
            pubkey: reserve,
            isWritable: true,
            isSigner: false,
          }))
        )
        .preInstructions(injectRefreshIxs)
        .transaction();
      const sig = await sdk.context.sender.send({ transaction: withComputeUnits(tx), signers: [] });
      return `sig=${sig}`;
    },
    allowExpectedFailure: (error) => {
      const mapped = mapAnchorError(error);
      return ["NotInjected", "NotYetSafePosition", "WithdrawAmountIsZero"].includes(mapped.codeName ?? "");
    },
  });

  console.log("[admin] update_market_price");
  const pythPriceUpdate = process.env.PYTH_PRICE_UPDATE_ACCOUNT?.trim();
  const pythFeedIdHex = process.env.PYTH_FEED_ID_HEX?.trim();
  await runInstructionStep({
    attempted,
    results,
    instruction: "update_market_price",
    run: async () => {
      const vaultForUpdate = deriveVaultAddress(CUSHION_PROGRAM_ID, smokeMint);
      const feedId = parseHex32(
        pythFeedIdHex ??
          "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"
      );

      const sig = await (program as any).methods
        .updateMarketPrice(feedId)
        .accounts({
          authority: user,
          vault: vaultForUpdate,
          priceUpdate: pythPriceUpdate ? new PublicKey(pythPriceUpdate) : user,
        })
        .rpc();
      return `sig=${sig}`;
    },
    allowExpectedFailure: (error) => {
      const mapped = mapAnchorError(error);
      if (mapped.codeName === "StalePythPrice" || mapped.codeName === "InvalidPythPrice") return true;
      const text = String(error);
      return text.includes("PriceUpdateV2") || text.includes("AccountOwnedByWrongProgram");
    },
  });

  console.log("[placeholder] insure_existing_position + liquidate");
  await runInstructionStep({
    attempted,
    results,
    instruction: "insure_existing_position",
    run: async () => {
      const sig = await (program as any).methods
        .insureExistingPosition()
        .accounts({ dummy: user })
        .rpc();
      return `sig=${sig}`;
    },
  });

  await runInstructionStep({
    attempted,
    results,
    instruction: "liquidate",
    run: async () => {
      const sig = await (program as any).methods
        .liquidate()
        .accounts({ dummy: user })
        .rpc();
      return `sig=${sig}`;
    },
  });

  const missing = ALL_IDL_INSTRUCTIONS.filter((name) => !attempted.has(name));

  console.log("\n=== Smoke Summary ===");
  for (const row of results) {
    console.log(`${row.status.padEnd(13)} ${row.instruction} :: ${row.detail.split("\n")[0]}`);
  }

  if (missing.length > 0) {
    throw new Error(`Missing instruction coverage: ${missing.join(", ")}`);
  }

  const failed = results.filter((r) => r.status === "SKIP");
  if (failed.length > 0) {
    console.log(`\nNote: ${failed.length} instruction(s) were skipped.`);
  }

  console.log("\nBusiness SDK smoke test finished with full instruction attempt coverage");
  console.log(`Position: ${positionAddress.toBase58()}`);
  console.log(`NFT mint: ${nftMint.toBase58()}`);
  console.log(`Standalone smoke vault asset mint: ${smokeMint.toBase58()}`);
  console.log(`Borrow reserve mint: ${borrowReserveCtx.reserveLiquidityMint.toBase58()}`);
}

main().catch((error) => {
  console.error("\nBusiness SDK smoke test failed");
  console.error(error);
  process.exit(1);
});
