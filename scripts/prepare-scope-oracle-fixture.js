#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const BN = require("bn.js");
const {
  OraclePrices,
} = require("@kamino-finance/scope-sdk/dist/@codegen/scope/accounts/OraclePrices");

function usage() {
  console.error(
    "Usage: node scripts/prepare-scope-oracle-fixture.js <rpc-url> <scope-account> <output-path> <slot> <unix-timestamp>"
  );
  process.exit(1);
}

function readSnapshot(filePath) {
  const rawText = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(rawText);
  const dataField = parsed?.account?.data;

  if (!Array.isArray(dataField) || typeof dataField[0] !== "string") {
    throw new Error(
      `Unexpected Solana account snapshot format in ${filePath}. Expected account.data[0] to be a base64 string.`
    );
  }

  return {
    rawText,
    encodedData: dataField[0],
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patchOraclePrices(encodedAccountData, slot, unixTimestamp) {
  const decoded = OraclePrices.decode(encodedAccountData);

  const patchedPrices = decoded.prices.map((entry) => ({
      ...entry.toEncodable(),
      lastUpdatedSlot: slot,
      unixTimestamp,
    }));

  const payload = Buffer.alloc(OraclePrices.layout.span);
  OraclePrices.layout.encode(
    {
      oracleMappings: decoded.oracleMappings,
      prices: patchedPrices,
    },
    payload
  );

  return Buffer.concat([OraclePrices.discriminator, payload]);
}

function main() {
  const [rpcUrl, scopeAccount, outputPath, slotArg, timestampArg] =
    process.argv.slice(2);

  if (!rpcUrl || !scopeAccount || !outputPath || !slotArg || !timestampArg) {
    usage();
  }

  const slot = new BN(slotArg, 10);
  const unixTimestamp = new BN(timestampArg, 10);
  const resolvedOutputPath = path.resolve(outputPath);

  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });

  execFileSync(
    "solana",
    [
      "account",
      scopeAccount,
      "--url",
      rpcUrl,
      "--output",
      "json-compact",
      "--output-file",
      resolvedOutputPath,
    ],
    { stdio: "inherit" }
  );

  const snapshot = readSnapshot(resolvedOutputPath);
  const currentData = Buffer.from(snapshot.encodedData, "base64");
  const patchedData = patchOraclePrices(currentData, slot, unixTimestamp);
  const patchedBase64 = patchedData.toString("base64");
  const updatedSnapshot = snapshot.rawText.replace(
    new RegExp(`"${escapeRegExp(snapshot.encodedData)}"`),
    `"${patchedBase64}"`
  );

  fs.writeFileSync(resolvedOutputPath, updatedSnapshot);
  console.error(
    `Patched Scope oracle ${scopeAccount} with slot=${slot.toString()} unixTimestamp=${unixTimestamp.toString()}`
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
