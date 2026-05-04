const { Client } = require("pg");

function resolveDatabaseUrl() {
  const fromKeeper = process.env.KEEPER_DATABASE_URL?.trim();
  if (fromKeeper) return fromKeeper;
  const fromGeneric = process.env.DATABASE_URL?.trim();
  if (fromGeneric) return fromGeneric;
  throw new Error("Missing KEEPER_DATABASE_URL (or DATABASE_URL).");
}

async function main() {
  const connectionString = resolveDatabaseUrl();
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE keeper_positions CASCADE");
    await client.query("COMMIT");
    console.log("Keeper DB reset complete: keeper_positions and dependent risk snapshots cleared.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Failed to reset keeper DB:", error);
  process.exit(1);
});
