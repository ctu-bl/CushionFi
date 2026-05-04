/**
 * Option A: Volá Orca swap instrukci přímo (bez našeho programu).
 *
 * Co tohle testuje:
 *   - pool adresy v constants.ts jsou správně naklonované a validní
 *   - tick array derivace (stejná logika jako v orca_swap.rs) dává správné adresy
 *   - WSOL → USDC swap na localnetovém validátoru skutečně projde
 *
 * Co NETESTUJE:
 *   - náš Rust kód (liquidate_handler, swap_wsol_to_usdc, ...)
 *   - podepisování vault PDA
 */

import * as anchor from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  AccountMeta,
} from "@solana/web3.js";
import { expect } from "chai";
import {
  WHIRLPOOL,
  WSOL_USDC_MARKET,
  WHIRLPOOL_WSOL_USDC_ORACLE,
  USDC_RESERVE,
} from "./constants";
import { Reserve as KlendReserveAccount } from "@kamino-finance/klend-sdk";

// ── Orca swap instruction layout (musí sedět s orca_swap.rs) ────────────────

// sha256("global:swap")[0..8]
const ORCA_SWAP_DISCRIMINATOR = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);

// MIN_SQRT_PRICE_X64 = 4295048016u128 little-endian (16 bytes)
const MIN_SQRT_PRICE_BYTES = (() => {
  const buf = Buffer.alloc(16);
  let val = BigInt("4295048016");
  for (let i = 0; i < 16; i++) {
    buf[i] = Number(val & BigInt(0xff));
    val >>= BigInt(8);
  }
  return buf;
})();

const TICKS_PER_ARRAY = 88;

// Byte offsets uvnitř raw Whirlpool accountu (po 8byte discriminátoru)
const TICK_SPACING_OFFSET      = 41;
const TICK_CURRENT_INDEX_OFFSET = 81;
// Layout (z @orca-so/whirlpools-client IDL — vault_a/b jsou PŘED reward_infos):
//   [101] tokenMintA (32), [133] tokenVaultA (32), [165] feeGrowthGlobalA (16)
//   [181] tokenMintB (32), [213] tokenVaultB (32)
const TOKEN_VAULT_A_OFFSET      = 133;
const TOKEN_VAULT_B_OFFSET      = 213;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** JavaScript ekvivalent Rust div_euclid pro správné záporné tick indexy. */
function divEuclid(a: number, b: number): number {
  const r = a % b;
  return r < 0 ? Math.trunc(a / b) - 1 : Math.trunc(a / b);
}

function deriveTickArray(whirlpool: PublicKey, startTick: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("tick_array"),
      whirlpool.toBuffer(),
      Buffer.from(startTick.toString()),
    ],
    WHIRLPOOL
  );
  return pda;
}

/**
 * Sestaví 42-bajtový payload Orca swap instrukce (stejný layout jako build_swap_ix_data v orca_swap.rs):
 *   [0..8]  discriminator
 *   [8..16] amount (u64 LE)
 *   [16..24] other_amount_threshold (u64 LE)
 *   [24..40] sqrt_price_limit (u128 LE)
 *   [40]    amount_specified_is_input = 1 (exact in)
 *   [41]    a_to_b = 1 (WSOL je token A)
 */
function buildSwapIxData(wsolAmount: bigint, minUsdcOut: bigint): Buffer {
  const buf = Buffer.alloc(42);
  ORCA_SWAP_DISCRIMINATOR.copy(buf, 0);
  buf.writeBigUInt64LE(wsolAmount, 8);
  buf.writeBigUInt64LE(minUsdcOut, 16);
  MIN_SQRT_PRICE_BYTES.copy(buf, 24);
  buf[40] = 1; // amount_specified_is_input = true
  buf[41] = 1; // a_to_b = true
  return buf;
}

// ── Test ─────────────────────────────────────────────────────────────────────

describe("orca swap (direct — Option A)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const payer = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  async function confirm(sig: string) {
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed"
    );
  }

  it("swapne 0.05 WSOL za USDC přímo přes Orca Whirlpool", async () => {
    // ── 1. Zjisti USDC mint z Kamino USDC reserve ────────────────────────────
    const reserveInfo = await connection.getAccountInfo(USDC_RESERVE);
    if (!reserveInfo) throw new Error("USDC reserve není naklonovaná — spusť yarn validator:local");
    const reserveData = KlendReserveAccount.decode(Buffer.from(reserveInfo.data));
    const usdcMint = new PublicKey(reserveData.liquidity.mintPubkey);
    console.log("USDC mint:", usdcMint.toBase58());

    // ── 2. Načti Whirlpool account ───────────────────────────────────────────
    const poolInfo = await connection.getAccountInfo(WSOL_USDC_MARKET);
    if (!poolInfo) throw new Error("WSOL/USDC Whirlpool není naklonovaný — spusť yarn validator:local");
    const poolData = Buffer.from(poolInfo.data);

    const tickSpacing     = poolData.readUInt16LE(TICK_SPACING_OFFSET);
    const tickCurrentIdx  = poolData.readInt32LE(TICK_CURRENT_INDEX_OFFSET);
    const tokenVaultA     = new PublicKey(poolData.subarray(TOKEN_VAULT_A_OFFSET, TOKEN_VAULT_A_OFFSET + 32));
    const tokenVaultB     = new PublicKey(poolData.subarray(TOKEN_VAULT_B_OFFSET, TOKEN_VAULT_B_OFFSET + 32));

    console.log("tick_spacing:", tickSpacing);
    console.log("tick_current_index:", tickCurrentIdx);
    console.log("token_vault_a (WSOL):", tokenVaultA.toBase58());
    console.log("token_vault_b (USDC):", tokenVaultB.toBase58());

    // ── 3. Odvoď tick array adresy (stejná logika jako compute_tick_array_starts v orca_swap.rs) ──
    const ticksInArray = TICKS_PER_ARRAY * tickSpacing;
    const start0 = divEuclid(tickCurrentIdx, ticksInArray) * ticksInArray;
    const tickArrays = [
      deriveTickArray(WSOL_USDC_MARKET, start0),
      deriveTickArray(WSOL_USDC_MARKET, start0 - ticksInArray),
      deriveTickArray(WSOL_USDC_MARKET, start0 - 2 * ticksInArray),
    ];
    console.log("tick_arrays:", tickArrays.map(t => t.toBase58()));

    // ── 4. Připrav payer WSOL a USDC účty ────────────────────────────────────
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
    const usdcAta = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);

    const setupTx = new Transaction();
    if (!await connection.getAccountInfo(wsolAta)) {
      setupTx.add(createAssociatedTokenAccountInstruction(payer.publicKey, wsolAta, payer.publicKey, NATIVE_MINT));
    }
    if (!await connection.getAccountInfo(usdcAta)) {
      setupTx.add(createAssociatedTokenAccountInstruction(payer.publicKey, usdcAta, payer.publicKey, usdcMint));
    }

    // Wrap 0.05 SOL → WSOL
    const WSOL_IN = BigInt(50_000_000); // 0.05 SOL
    setupTx.add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: wsolAta, lamports: Number(WSOL_IN) }),
      createSyncNativeInstruction(wsolAta),
    );

    if (setupTx.instructions.length > 0) {
      await confirm(await provider.sendAndConfirm(setupTx, []));
    }

    const wsolBefore = (await getAccount(connection, wsolAta)).amount;
    const usdcBefore = (await getAccount(connection, usdcAta)).amount;
    console.log("WSOL před swapem:", wsolBefore.toString());
    console.log("USDC před swapem:", usdcBefore.toString());

    // ── 5. Sestav a pošli Orca swap instrukci ────────────────────────────────
    const ixData = buildSwapIxData(WSOL_IN, BigInt(0) /* min USDC out = 0, testujeme jen průchod */);

    const accounts: AccountMeta[] = [
      { pubkey: TOKEN_PROGRAM_ID,          isSigner: false, isWritable: false }, // token_program
      { pubkey: payer.publicKey,           isSigner: true,  isWritable: false }, // token_authority
      { pubkey: WSOL_USDC_MARKET,          isSigner: false, isWritable: true  }, // whirlpool
      { pubkey: wsolAta,                   isSigner: false, isWritable: true  }, // token_owner_account_a (WSOL)
      { pubkey: tokenVaultA,               isSigner: false, isWritable: true  }, // token_vault_a
      { pubkey: usdcAta,                   isSigner: false, isWritable: true  }, // token_owner_account_b (USDC)
      { pubkey: tokenVaultB,               isSigner: false, isWritable: true  }, // token_vault_b
      { pubkey: tickArrays[0],             isSigner: false, isWritable: true  },
      { pubkey: tickArrays[1],             isSigner: false, isWritable: true  },
      { pubkey: tickArrays[2],             isSigner: false, isWritable: true  },
      { pubkey: WHIRLPOOL_WSOL_USDC_ORACLE, isSigner: false, isWritable: true }, // oracle
    ];

    const swapIx = new TransactionInstruction({
      programId: WHIRLPOOL,
      keys: accounts,
      data: ixData,
    });

    const swapTx = new Transaction().add(swapIx);
    await confirm(await provider.sendAndConfirm(swapTx, []));

    // ── 6. Ověř výsledky ─────────────────────────────────────────────────────
    const wsolAfter = (await getAccount(connection, wsolAta)).amount;
    const usdcAfter = (await getAccount(connection, usdcAta)).amount;
    console.log("WSOL po swapu:", wsolAfter.toString());
    console.log("USDC po swapu:", usdcAfter.toString());

    expect(wsolAfter < wsolBefore).to.be.true;   // WSOL byl utracen
    expect(usdcAfter > usdcBefore).to.be.true;   // USDC přibyl
  });
});
