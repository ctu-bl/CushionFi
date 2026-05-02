import { PublicKey } from "@solana/web3.js";

export const MPL_CORE_PROGRAM_ID = new PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
);

export const KLEND = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);

export const MARKET = new PublicKey(
  "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
);

export const RESERVE = new PublicKey(
  "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q"
);

export const RESERVE_LIQUIDITY_SUPPLY = new PublicKey(
  "GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U"
);

export const RESERVE_LIQUIDITY_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);

export const RESERVE_COLLATERAL_MINT = new PublicKey(
  "2UywZrUdyqs5vDchy7fKQJKau2RVyuzBev2XKGPDSiX1"
);

export const RESERVE_DESTINATION_COLLATERAL = new PublicKey(
  "8NXMyRD91p3nof61BTkJvrfpGTASHygz1cUvc3HvwyGS"
);

export const RESERVE_FARM_STATE = new PublicKey(
  "955xWFhSDcDiUgUr4sBRtCpTLiMd4H5uZLAmgtP3R3sX"
);

export const FARMS_PROGRAM = new PublicKey(
  "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr"
);

export const USDC_RESERVE = new PublicKey(
  "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"
);


// Legacy v1 pull-oracle account
export const PYTH_SOL_USD_FEED = new PublicKey(
  "H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG"
);

// V2 push-oracle feed ID for SOL/USD (same on all clusters)
// Source: https://pyth.network/developers/price-feed-ids
export const SOL_USD_FEED_ID: Buffer = Buffer.from(
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "hex"
);

// PriceUpdateV2 account for SOL/USD
export const PYTH_SOL_USD_PRICE_UPDATE = new PublicKey(
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
);

export const RESERVE_LIQUIDITY_FEE_RECEIVER = new PublicKey(
  "3JNof8s453bwG5UqiXBLJc77NRQXezYYEBbk3fqnoKph"
);
