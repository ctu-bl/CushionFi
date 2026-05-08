#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  Connection,
  Keypair,
  PublicKey,
} = require("@solana/web3.js");
const {
  AccountLayout,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");

const MAINNET_USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

function readArg(name, fallback = "") {
  const pref = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(pref));
  return found ? found.slice(pref.length) : fallback;
}

function readKeypair(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const arr = JSON.parse(raw);
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

async function main() {
  const walletPath = readArg("--wallet", path.join(os.homedir(), ".config/solana/id.json"));
  const rpcUrl = readArg("--rpc", "https://api.mainnet-beta.solana.com");
  const amountRaw = readArg("--amount", "5000000000000");
  const outFile = readArg("--out", path.resolve(os.tmpdir(), "cushion-usdc-payer-ata.json"));
  const rentLamportsArg = readArg("--rent-lamports", "").trim();

  const amount = BigInt(amountRaw);
  if (amount < 0n) {
    throw new Error(`Amount must be >= 0, got ${amountRaw}`);
  }

  const payer = readKeypair(walletPath);
  const payerUsdcAta = getAssociatedTokenAddressSync(
    MAINNET_USDC_MINT,
    payer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tokenAccountData = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: MAINNET_USDC_MINT,
      owner: payer.publicKey,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    tokenAccountData
  );

  let rentLamports;
  if (rentLamportsArg.length > 0) {
    rentLamports = Number(rentLamportsArg);
  } else {
    const conn = new Connection(rpcUrl, "confirmed");
    rentLamports = await conn.getMinimumBalanceForRentExemption(AccountLayout.span);
  }
  if (!Number.isFinite(rentLamports) || rentLamports <= 0) {
    throw new Error(`Invalid rent lamports resolved: ${rentLamports}`);
  }

  const payload = {
    pubkey: payerUsdcAta.toBase58(),
    account: {
      lamports: rentLamports,
      data: [tokenAccountData.toString("base64"), "base64"],
      owner: TOKEN_PROGRAM_ID.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: AccountLayout.span,
    },
  };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

  console.log(`PAYER_PUBKEY=${payer.publicKey.toBase58()}`);
  console.log(`USDC_ATA=${payerUsdcAta.toBase58()}`);
  console.log(`FIXTURE_PATH=${outFile}`);
  console.log(`USDC_AMOUNT_RAW=${amount.toString()}`);
}

main().catch((err) => {
  console.error("Failed to prepare local USDC ATA fixture:", err);
  process.exit(1);
});
