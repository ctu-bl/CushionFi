const { Client } = require("pg");

function resolveDatabaseUrl() {
  const fromKeeper = process.env.KEEPER_DATABASE_URL?.trim();
  if (fromKeeper) return fromKeeper;

  const dbHost = process.env.KEEPER_DB_HOST?.trim() || "127.0.0.1";
  const dbPort = process.env.KEEPER_DB_PORT?.trim() || "5432";
  const dbUser = process.env.KEEPER_DB_USER?.trim() || "postgres";
  const dbPassword = process.env.KEEPER_DB_PASSWORD?.trim() || "postgres";
  const dbName = process.env.KEEPER_DB_NAME?.trim() || "cushion_keeper";
  if (process.env.KEEPER_DB_HOST || process.env.KEEPER_DB_USER || process.env.KEEPER_DB_PASSWORD || process.env.KEEPER_DB_NAME || process.env.KEEPER_DB_PORT) {
    return `postgres://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@${dbHost}:${dbPort}/${dbName}`;
  }

  const fromGeneric = process.env.DATABASE_URL?.trim();
  if (fromGeneric) return fromGeneric;
  throw new Error(
    "Missing DB config. Set KEEPER_DATABASE_URL, or KEEPER_DB_HOST/PORT/USER/PASSWORD/NAME, or DATABASE_URL."
  );
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
