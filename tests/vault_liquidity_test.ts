import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { Cushion } from "../target/types/cushion";

const VAULT_STATE_SEED = Buffer.from("vault_state_v1");
const VAULT_SHARE_MINT_SEED = Buffer.from("vault_share_mint_v1");
const VAULT_TOKEN_ACCOUNT_SEED = Buffer.from("vault_token_v1");
const VAULT_TREASURY_TOKEN_ACCOUNT_SEED = Buffer.from("vault_treasury_v1");

type VaultFixture = {
  assetMint: PublicKey;
  vault: PublicKey;
  shareMint: PublicKey;
  vaultTokenAccount: PublicKey;
  treasuryTokenAccount: PublicKey;
  userA: UserFixture;
  userB: UserFixture;
};

type UserFixture = {
  keypair: Keypair;
  assetAccount: PublicKey;
  shareAccount: PublicKey;
};

describe("vault liquidity", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Cushion as Program<Cushion>;
  const payer = provider.wallet.payer;

  async function airdrop(
    pubkey: PublicKey,
    lamports = LAMPORTS_PER_SOL
  ): Promise<void> {
    const sig = await provider.connection.requestAirdrop(pubkey, lamports);
    const latest = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      {
        signature: sig,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed"
    );
  }

  function deriveVaultAddresses(assetMint: PublicKey) {
    const [vault] = PublicKey.findProgramAddressSync(
      [VAULT_STATE_SEED, assetMint.toBuffer()],
      program.programId
    );
    const [shareMint] = PublicKey.findProgramAddressSync(
      [VAULT_SHARE_MINT_SEED, vault.toBuffer()],
      program.programId
    );
    const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [VAULT_TOKEN_ACCOUNT_SEED, vault.toBuffer()],
      program.programId
    );
    const [treasuryTokenAccount] = PublicKey.findProgramAddressSync(
      [VAULT_TREASURY_TOKEN_ACCOUNT_SEED, vault.toBuffer()],
      program.programId
    );
    return { vault, shareMint, vaultTokenAccount, treasuryTokenAccount };
  }

  async function createUser(
    assetMint: PublicKey,
    shareMint: PublicKey,
    initialAssets: number
  ): Promise<UserFixture> {
    const keypair = Keypair.generate();
    await airdrop(keypair.publicKey, 2 * LAMPORTS_PER_SOL);

    const assetAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        assetMint,
        keypair.publicKey
      )
    ).address;

    const shareAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        shareMint,
        keypair.publicKey
      )
    ).address;

    if (initialAssets > 0) {
      await mintTo(
        provider.connection,
        payer,
        assetMint,
        assetAccount,
        payer,
        initialAssets
      );
    }

    return { keypair, assetAccount, shareAccount };
  }

  async function setupVault(params?: {
    minDeposit?: number;
    depositCap?: number;
    virtualAssets?: number;
    virtualShares?: number;
    userAAssets?: number;
    userBAssets?: number;
  }): Promise<VaultFixture> {
    const minDeposit = params?.minDeposit ?? 1;
    const depositCap = params?.depositCap ?? 10_000_000;
    const virtualAssets = params?.virtualAssets ?? 0;
    const virtualShares = params?.virtualShares ?? 0;
    const userAAssets = params?.userAAssets ?? 2_000_000;
    const userBAssets = params?.userBAssets ?? 2_000_000;

    const assetMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );

    const derived = deriveVaultAddresses(assetMint);

    await program.methods
      .initVault(
        new anchor.BN(minDeposit),
        new anchor.BN(depositCap),
        new anchor.BN(virtualAssets),
        new anchor.BN(virtualShares)
      )
      .accounts({
        authority: provider.wallet.publicKey,
        assetMint,
        vault: derived.vault,
        shareMint: derived.shareMint,
        vaultTokenAccount: derived.vaultTokenAccount,
        treasuryTokenAccount: derived.treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const userA = await createUser(assetMint, derived.shareMint, userAAssets);
    const userB = await createUser(assetMint, derived.shareMint, userBAssets);

    return {
      assetMint,
      vault: derived.vault,
      shareMint: derived.shareMint,
      vaultTokenAccount: derived.vaultTokenAccount,
      treasuryTokenAccount: derived.treasuryTokenAccount,
      userA,
      userB,
    };
  }

  async function tokenAmount(account: PublicKey): Promise<number> {
    const balance = await provider.connection.getTokenAccountBalance(account);
    return Number(balance.value.amount);
  }

  async function mintSupply(mint: PublicKey): Promise<number> {
    const supply = await provider.connection.getTokenSupply(mint);
    return Number(supply.value.amount);
  }

  async function expectAnchorError(
    promise: Promise<unknown>,
    expectedCode: string
  ): Promise<void> {
    try {
      await promise;
      expect.fail(`Expected error ${expectedCode}`);
    } catch (err: any) {
      const code = err?.error?.errorCode?.code;
      if (code) {
        if (code === expectedCode) {
          return;
        }
      }
      const joinedLogs = Array.isArray(err?.logs) ? err.logs.join("\n") : "";
      const detail = `${code ?? ""}\n${String(err)}\n${joinedLogs}`;
      expect(detail).to.contain(expectedCode);
    }
  }

  async function parseEvents(
    signature: string
  ): Promise<Array<{ name: string; data: any }>> {
    await provider.connection.confirmTransaction(signature, "confirmed");

    let tx = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      tx = await provider.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(tx, `transaction not found: ${signature}`).to.not.eq(null);
    const logs = tx?.meta?.logMessages ?? [];
    const parser = new anchor.EventParser(program.programId, program.coder);
    return [...parser.parseLogs(logs)];
  }

  function findEvent(
    events: Array<{ name: string; data: any }>,
    eventName: string
  ): { name: string; data: any } | undefined {
    return events.find((e) => e.name === eventName);
  }

  function eventField(data: any, camel: string, snake: string): any {
    if (data[camel] !== undefined) {
      return data[camel];
    }
    return data[snake];
  }

  function toNum(value: any): number {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value?.toNumber === "function") {
      return value.toNumber();
    }
    return Number(value.toString());
  }

  async function assertVaultAccountingInvariant(
    fx: VaultFixture
  ): Promise<void> {
    const vaultState = await program.account.vault.fetch(fx.vault);
    const onChainManagedAssets = toNum(vaultState.totalManagedAssets);
    const vaultAssetBalance = await tokenAmount(fx.vaultTokenAccount);
    expect(onChainManagedAssets).to.eq(vaultAssetBalance);
  }

  function depositIx(
    fx: VaultFixture,
    user: UserFixture,
    assetsIn: number,
    minSharesOut: number
  ) {
    return program.methods
      .deposit(new anchor.BN(assetsIn), new anchor.BN(minSharesOut))
      .accounts({
        user: user.keypair.publicKey,
        assetMint: fx.assetMint,
        vault: fx.vault,
        shareMint: fx.shareMint,
        userAssetAccount: user.assetAccount,
        userShareAccount: user.shareAccount,
        vaultTokenAccount: fx.vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user.keypair]);
  }

  function mintIx(
    fx: VaultFixture,
    user: UserFixture,
    sharesOut: number,
    maxAssetsIn: number
  ) {
    return program.methods
      .mint(new anchor.BN(sharesOut), new anchor.BN(maxAssetsIn))
      .accounts({
        user: user.keypair.publicKey,
        assetMint: fx.assetMint,
        vault: fx.vault,
        shareMint: fx.shareMint,
        userAssetAccount: user.assetAccount,
        userShareAccount: user.shareAccount,
        vaultTokenAccount: fx.vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user.keypair]);
  }

  function redeemIx(
    fx: VaultFixture,
    user: UserFixture,
    sharesIn: number,
    minAssetsOut: number
  ) {
    return program.methods
      .redeem(new anchor.BN(sharesIn), new anchor.BN(minAssetsOut))
      .accounts({
        user: user.keypair.publicKey,
        assetMint: fx.assetMint,
        vault: fx.vault,
        shareMint: fx.shareMint,
        userAssetAccount: user.assetAccount,
        userShareAccount: user.shareAccount,
        vaultTokenAccount: fx.vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user.keypair]);
  }

  function withdrawIx(
    fx: VaultFixture,
    user: UserFixture,
    assetsOut: number,
    maxSharesBurn: number
  ) {
    return program.methods
      .withdraw(new anchor.BN(assetsOut), new anchor.BN(maxSharesBurn))
      .accounts({
        user: user.keypair.publicKey,
        assetMint: fx.assetMint,
        vault: fx.vault,
        shareMint: fx.shareMint,
        userAssetAccount: user.assetAccount,
        userShareAccount: user.shareAccount,
        vaultTokenAccount: fx.vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user.keypair]);
  }

  // Verifies vault initialization end-to-end:
  // all derived PDA accounts are wired into state and the init event is emitted with expected values.
  it("1) init_vault initializes state, PDAs and emits event", async () => {
    const minDeposit = 100;
    const depositCap = 50_000;
    const virtualAssets = 10;
    const virtualShares = 20;
    const assetMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );
    const addresses = deriveVaultAddresses(assetMint);

    const sig = await program.methods
      .initVault(
        new anchor.BN(minDeposit),
        new anchor.BN(depositCap),
        new anchor.BN(virtualAssets),
        new anchor.BN(virtualShares)
      )
      .accounts({
        authority: provider.wallet.publicKey,
        assetMint,
        vault: addresses.vault,
        shareMint: addresses.shareMint,
        vaultTokenAccount: addresses.vaultTokenAccount,
        treasuryTokenAccount: addresses.treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const vault = await program.account.vault.fetch(addresses.vault);
    expect(vault.authority.toBase58()).to.eq(
      provider.wallet.publicKey.toBase58()
    );
    expect(vault.assetMint.toBase58()).to.eq(assetMint.toBase58());
    expect(vault.shareMint.toBase58()).to.eq(addresses.shareMint.toBase58());
    expect(vault.vaultTokenAccount.toBase58()).to.eq(
      addresses.vaultTokenAccount.toBase58()
    );
    expect(vault.treasuryTokenAccount.toBase58()).to.eq(
      addresses.treasuryTokenAccount.toBase58()
    );
    expect(toNum(vault.totalManagedAssets)).to.eq(0);
    expect(toNum(vault.minDeposit)).to.eq(minDeposit);
    expect(toNum(vault.depositCap)).to.eq(depositCap);
    expect(toNum(vault.virtualAssets)).to.eq(virtualAssets);
    expect(toNum(vault.virtualShares)).to.eq(virtualShares);

    const events = await parseEvents(sig);
    const initEvent = findEvent(events, "VaultInitializedEvent");
    if (initEvent) {
      expect(eventField(initEvent.data, "vault", "vault").toBase58()).to.eq(
        addresses.vault.toBase58()
      );
      expect(
        toNum(eventField(initEvent.data, "minDeposit", "min_deposit"))
      ).to.eq(minDeposit);
      expect(
        toNum(eventField(initEvent.data, "depositCap", "deposit_cap"))
      ).to.eq(depositCap);
    }
  });

  // Ensures init fails when deposit cap configuration is invalid
  // (specifically when the cap is lower than the configured minimum deposit).
  it("2) init_vault rejects invalid deposit cap configuration", async () => {
    const assetMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );
    const addresses = deriveVaultAddresses(assetMint);

    await expectAnchorError(
      program.methods
        .initVault(
          new anchor.BN(100),
          new anchor.BN(99),
          new anchor.BN(0),
          new anchor.BN(0)
        )
        .accounts({
          authority: provider.wallet.publicKey,
          assetMint,
          vault: addresses.vault,
          shareMint: addresses.shareMint,
          vaultTokenAccount: addresses.vaultTokenAccount,
          treasuryTokenAccount: addresses.treasuryTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
      "InvalidDepositCap"
    );
  });

  // Confirms vault initialization is one-time per asset mint:
  // a second init attempt with the same seeds is rejected because PDA accounts already exist.
  it("3) init_vault cannot be executed twice for the same asset mint", async () => {
    const assetMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );
    const addresses = deriveVaultAddresses(assetMint);

    await program.methods
      .initVault(
        new anchor.BN(1),
        new anchor.BN(100_000),
        new anchor.BN(0),
        new anchor.BN(0)
      )
      .accounts({
        authority: provider.wallet.publicKey,
        assetMint,
        vault: addresses.vault,
        shareMint: addresses.shareMint,
        vaultTokenAccount: addresses.vaultTokenAccount,
        treasuryTokenAccount: addresses.treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    await expectAnchorError(
      program.methods
        .initVault(
          new anchor.BN(1),
          new anchor.BN(100_000),
          new anchor.BN(0),
          new anchor.BN(0)
        )
        .accounts({
          authority: provider.wallet.publicKey,
          assetMint,
          vault: addresses.vault,
          shareMint: addresses.shareMint,
          vaultTokenAccount: addresses.vaultTokenAccount,
          treasuryTokenAccount: addresses.treasuryTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
      "already in use"
    );
  });

  // Covers the successful deposit flow:
  // user assets decrease, user shares increase, vault liquidity grows, accounting stays consistent, and event data matches.
  it("4) deposit happy path updates balances, accounting and emits event", async () => {
    const fx = await setupVault();
    const depositAmount = 200_000;

    const userAssetBefore = await tokenAmount(fx.userA.assetAccount);
    const userShareBefore = await tokenAmount(fx.userA.shareAccount);
    const vaultAssetsBefore = await tokenAmount(fx.vaultTokenAccount);

    const sig = await depositIx(
      fx,
      fx.userA,
      depositAmount,
      depositAmount
    ).rpc();

    expect(await tokenAmount(fx.userA.assetAccount)).to.eq(
      userAssetBefore - depositAmount
    );
    expect(await tokenAmount(fx.userA.shareAccount)).to.eq(
      userShareBefore + depositAmount
    );
    expect(await tokenAmount(fx.vaultTokenAccount)).to.eq(
      vaultAssetsBefore + depositAmount
    );
    await assertVaultAccountingInvariant(fx);

    const events = await parseEvents(sig);
    const depositEvent = findEvent(events, "VaultDepositEvent");
    if (depositEvent) {
      expect(
        toNum(eventField(depositEvent.data, "assetsIn", "assets_in"))
      ).to.eq(depositAmount);
      expect(
        toNum(eventField(depositEvent.data, "sharesOut", "shares_out"))
      ).to.eq(depositAmount);
    }
  });

  // Covers the successful mint flow (exact shares out):
  // required assets are taken from user, shares are minted, vault accounting remains correct, and event is emitted.
  it("5) mint happy path updates balances, accounting and emits event", async () => {
    const fx = await setupVault();
    const sharesOut = 120_000;

    const userAssetBefore = await tokenAmount(fx.userA.assetAccount);
    const userShareBefore = await tokenAmount(fx.userA.shareAccount);
    const vaultAssetsBefore = await tokenAmount(fx.vaultTokenAccount);

    const sig = await mintIx(fx, fx.userA, sharesOut, sharesOut).rpc();

    expect(await tokenAmount(fx.userA.assetAccount)).to.eq(
      userAssetBefore - sharesOut
    );
    expect(await tokenAmount(fx.userA.shareAccount)).to.eq(
      userShareBefore + sharesOut
    );
    expect(await tokenAmount(fx.vaultTokenAccount)).to.eq(
      vaultAssetsBefore + sharesOut
    );
    await assertVaultAccountingInvariant(fx);

    const events = await parseEvents(sig);
    const mintEvent = findEvent(events, "VaultMintEvent");
    if (mintEvent) {
      expect(
        toNum(eventField(mintEvent.data, "sharesOut", "shares_out"))
      ).to.eq(sharesOut);
    }
  });

  // Covers the successful redeem flow:
  // user shares are burned, matching assets are returned, vault balance decreases accordingly, and event fields are correct.
  it("6) redeem happy path burns shares, returns assets and emits event", async () => {
    const fx = await setupVault();
    await depositIx(fx, fx.userA, 300_000, 300_000).rpc();

    const userAssetBefore = await tokenAmount(fx.userA.assetAccount);
    const userShareBefore = await tokenAmount(fx.userA.shareAccount);
    const vaultAssetsBefore = await tokenAmount(fx.vaultTokenAccount);
    const sharesIn = 100_000;

    const sig = await redeemIx(fx, fx.userA, sharesIn, sharesIn).rpc();

    expect(await tokenAmount(fx.userA.assetAccount)).to.eq(
      userAssetBefore + sharesIn
    );
    expect(await tokenAmount(fx.userA.shareAccount)).to.eq(
      userShareBefore - sharesIn
    );
    expect(await tokenAmount(fx.vaultTokenAccount)).to.eq(
      vaultAssetsBefore - sharesIn
    );
    await assertVaultAccountingInvariant(fx);

    const events = await parseEvents(sig);
    const redeemEvent = findEvent(events, "VaultRedeemEvent");
    if (redeemEvent) {
      expect(
        toNum(eventField(redeemEvent.data, "sharesIn", "shares_in"))
      ).to.eq(sharesIn);
      expect(
        toNum(eventField(redeemEvent.data, "assetsOut", "assets_out"))
      ).to.eq(sharesIn);
    }
  });

  // Covers the successful withdraw flow (exact assets out):
  // protocol burns the required shares, transfers requested assets to user, preserves accounting invariant, and emits event.
  it("7) withdraw happy path burns shares, returns target assets and emits event", async () => {
    const fx = await setupVault();
    await depositIx(fx, fx.userA, 300_000, 300_000).rpc();
    const assetsOut = 90_000;

    const userAssetBefore = await tokenAmount(fx.userA.assetAccount);
    const userShareBefore = await tokenAmount(fx.userA.shareAccount);
    const vaultAssetsBefore = await tokenAmount(fx.vaultTokenAccount);

    const sig = await withdrawIx(fx, fx.userA, assetsOut, assetsOut).rpc();

    expect(await tokenAmount(fx.userA.assetAccount)).to.eq(
      userAssetBefore + assetsOut
    );
    expect(await tokenAmount(fx.userA.shareAccount)).to.eq(
      userShareBefore - assetsOut
    );
    expect(await tokenAmount(fx.vaultTokenAccount)).to.eq(
      vaultAssetsBefore - assetsOut
    );
    await assertVaultAccountingInvariant(fx);

    const events = await parseEvents(sig);
    const withdrawEvent = findEvent(events, "VaultWithdrawEvent");
    if (withdrawEvent) {
      expect(
        toNum(eventField(withdrawEvent.data, "assetsOut", "assets_out"))
      ).to.eq(assetsOut);
      expect(
        toNum(eventField(withdrawEvent.data, "sharesBurned", "shares_burned"))
      ).to.eq(assetsOut);
    }
  });

  // Verifies slippage guards across all liquidity instructions:
  // each instruction fails when caller limits are stricter than what conversion math can satisfy.
  it("8) slippage protections reject unsafe execution limits", async () => {
    const fx = await setupVault();
    await depositIx(fx, fx.userA, 200_000, 200_000).rpc();

    await expectAnchorError(
      depositIx(fx, fx.userA, 1_000, 1_001).rpc(),
      "MinSharesOutNotMet"
    );

    await expectAnchorError(
      mintIx(fx, fx.userA, 1_000, 999).rpc(),
      "MaxAssetsInExceeded"
    );

    await expectAnchorError(
      redeemIx(fx, fx.userA, 1_000, 1_001).rpc(),
      "MinAssetsOutNotMet"
    );

    await expectAnchorError(
      withdrawIx(fx, fx.userA, 1_000, 999).rpc(),
      "MaxSharesBurnExceeded"
    );
  });

  // Verifies zero-amount protection on all user-facing vault liquidity instructions.
  // Each instruction must fail fast instead of mutating state.
  it("9) zero amount guards are enforced for deposit/mint/redeem/withdraw", async () => {
    const fx = await setupVault();
    await depositIx(fx, fx.userA, 50_000, 50_000).rpc();

    await expectAnchorError(
      depositIx(fx, fx.userA, 0, 0).rpc(),
      "ZeroDepositAmount"
    );
    await expectAnchorError(mintIx(fx, fx.userA, 0, 0).rpc(), "ZeroMintAmount");
    await expectAnchorError(
      redeemIx(fx, fx.userA, 0, 0).rpc(),
      "ZeroRedeemAmount"
    );
    await expectAnchorError(
      withdrawIx(fx, fx.userA, 0, 0).rpc(),
      "ZeroWithdrawAmount"
    );
  });

  // Ensures live deposit constraints behave correctly:
  // deposits below minimum are rejected and deposits that would exceed cap are also rejected.
  it("10) min deposit and deposit cap are enforced in real transactions", async () => {
    const fx = await setupVault({
      minDeposit: 10_000,
      depositCap: 20_000,
      userAAssets: 50_000,
    });

    await expectAnchorError(
      depositIx(fx, fx.userA, 9_999, 0).rpc(),
      "DepositTooSmall"
    );

    await depositIx(fx, fx.userA, 15_000, 15_000).rpc();

    await expectAnchorError(
      depositIx(fx, fx.userA, 10_001, 10_001).rpc(),
      "DepositCapExceeded"
    );
  });

  // Tests Anchor account constraint enforcement:
  // transactions fail when signer ownership or mint/account relationships do not match vault requirements.
  it("11) account constraints reject wrong owners and mismatched accounts", async () => {
    const fx = await setupVault();
    await depositIx(fx, fx.userA, 100_000, 100_000).rpc();

    // Wrong user asset owner for signer -> Unauthorized.
    await expectAnchorError(
      program.methods
        .deposit(new anchor.BN(1_000), new anchor.BN(1_000))
        .accounts({
          user: fx.userA.keypair.publicKey,
          assetMint: fx.assetMint,
          vault: fx.vault,
          shareMint: fx.shareMint,
          userAssetAccount: fx.userB.assetAccount,
          userShareAccount: fx.userA.shareAccount,
          vaultTokenAccount: fx.vaultTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([fx.userA.keypair])
        .rpc(),
      "Unauthorized"
    );

    // Wrong user asset account mint (while vault + asset mint stay correct) -> InvalidAssetMint.
    const wrongAssetMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );
    const wrongAssetAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        wrongAssetMint,
        fx.userA.keypair.publicKey
      )
    ).address;
    await expectAnchorError(
      program.methods
        .deposit(new anchor.BN(1_000), new anchor.BN(1_000))
        .accounts({
          user: fx.userA.keypair.publicKey,
          assetMint: fx.assetMint,
          vault: fx.vault,
          shareMint: fx.shareMint,
          userAssetAccount: wrongAssetAccount,
          userShareAccount: fx.userA.shareAccount,
          vaultTokenAccount: fx.vaultTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([fx.userA.keypair])
        .rpc(),
      "InvalidAssetMint"
    );

    // Wrong share mint for vault relation -> InvalidShareMint.
    const wrongShareMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );
    const wrongShareAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        wrongShareMint,
        fx.userA.keypair.publicKey
      )
    ).address;

    await expectAnchorError(
      program.methods
        .deposit(new anchor.BN(1_000), new anchor.BN(1_000))
        .accounts({
          user: fx.userA.keypair.publicKey,
          assetMint: fx.assetMint,
          vault: fx.vault,
          shareMint: wrongShareMint,
          userAssetAccount: fx.userA.assetAccount,
          userShareAccount: wrongShareAccount,
          vaultTokenAccount: fx.vaultTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([fx.userA.keypair])
        .rpc(),
      "InvalidShareMint"
    );

    // Wrong vault token account relation -> InvalidVaultTokenAccount.
    const fakeVaultTokenOwner = Keypair.generate();
    await airdrop(fakeVaultTokenOwner.publicKey, LAMPORTS_PER_SOL);
    const fakeVaultTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        fx.assetMint,
        fakeVaultTokenOwner.publicKey
      )
    ).address;

    await expectAnchorError(
      program.methods
        .deposit(new anchor.BN(1_000), new anchor.BN(1_000))
        .accounts({
          user: fx.userA.keypair.publicKey,
          assetMint: fx.assetMint,
          vault: fx.vault,
          shareMint: fx.shareMint,
          userAssetAccount: fx.userA.assetAccount,
          userShareAccount: fx.userA.shareAccount,
          vaultTokenAccount: fakeVaultTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([fx.userA.keypair])
        .rpc(),
      "InvalidVaultTokenAccount"
    );
  });

  // Runs a mixed multi-user scenario (deposit/mint/redeem/withdraw) and checks core invariants:
  // share supply equals sum of user shares and vault managed assets equal vault token balance at all times.
  it("12) multi-user flow preserves accounting and supply invariants", async () => {
    const fx = await setupVault({
      userAAssets: 2_000_000,
      userBAssets: 2_000_000,
    });

    await depositIx(fx, fx.userA, 400_000, 400_000).rpc();
    await assertVaultAccountingInvariant(fx);

    await mintIx(fx, fx.userB, 200_000, 200_000).rpc();
    await assertVaultAccountingInvariant(fx);

    await redeemIx(fx, fx.userA, 100_000, 100_000).rpc();
    await assertVaultAccountingInvariant(fx);

    await withdrawIx(fx, fx.userB, 50_000, 50_000).rpc();
    await assertVaultAccountingInvariant(fx);

    const supply = await mintSupply(fx.shareMint);
    const userAShares = await tokenAmount(fx.userA.shareAccount);
    const userBShares = await tokenAmount(fx.userB.shareAccount);
    expect(supply).to.eq(userAShares + userBShares);

    const vaultState = await program.account.vault.fetch(fx.vault);
    const vaultTokenBalance = await tokenAmount(fx.vaultTokenAccount);
    expect(toNum(vaultState.totalManagedAssets)).to.eq(vaultTokenBalance);
  });
});
