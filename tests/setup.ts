import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";

import { FARMS_PROGRAM, KLEND } from "./constants";

const PROTOCOL_CONFIG_SEED = Buffer.from("protocol_config_v1");
const MAINNET_KLEND_PROGRAM_ID = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);
const MAINNET_FARMS_PROGRAM_ID = new PublicKey(
  "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr"
);

function deriveWsEndpoint(httpEndpoint: string): string {
  if (httpEndpoint.startsWith("https://")) {
    return `wss://${httpEndpoint.slice("https://".length)}`;
  }
  if (httpEndpoint.startsWith("http://")) {
    return `ws://${httpEndpoint.slice("http://".length)}`;
  }
  return httpEndpoint;
}

// AnchorProvider.env() in anchor v0.32 doesn't expose wsEndpoint configuration.
// Override it in tests so websocket pubsub uses explicit endpoint from env.
(() => {
  const process = require("process");
  const rpcUrl = process.env.ANCHOR_PROVIDER_URL?.trim();
  if (!rpcUrl) return;

  const explicitWs =
    process.env.ANCHOR_WS_URL?.trim() ||
    process.env.SOLANA_WS_URL_DEVNET?.trim() ||
    process.env.SOLANA_WS_URL?.trim();
  const wsEndpoint = explicitWs || deriveWsEndpoint(rpcUrl);

  (anchor.AnchorProvider as any).env = () => {
    const options = anchor.AnchorProvider.defaultOptions();
    const connection = new Connection(rpcUrl, {
      commitment: options.commitment,
      wsEndpoint,
    });
    const NodeWallet = require("@coral-xyz/anchor/dist/cjs/nodewallet.js").default;
    const wallet = NodeWallet.local();
    return new anchor.AnchorProvider(connection, wallet, options);
  };
})();

function discriminator(ixName: string): Buffer {
  return createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);
}

function readProtocolConfig(data: Buffer): {
  klendProgramId: PublicKey;
  farmsProgramId: PublicKey;
  mode: number;
} {
  if (data.length < 8 + 101) {
    throw new Error(`Protocol config account too small: ${data.length}`);
  }
  const klendProgramId = new PublicKey(data.subarray(41, 73));
  const farmsProgramId = new PublicKey(data.subarray(73, 105));
  const mode = data[105];
  return { klendProgramId, farmsProgramId, mode };
}

before(async function () {
  const appEnv = (process.env.APP_ENV ?? "local").trim().toLowerCase();
  if (appEnv !== "local") return;

  this.timeout(60_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const workspaceProgram = (anchor.workspace as Record<string, any>).Cushion;
  if (!workspaceProgram?.programId) {
    throw new Error("anchor.workspace.Cushion is not available in test setup");
  }

  const cushionProgramId = workspaceProgram.programId as PublicKey;
  const [protocolConfig] = PublicKey.findProgramAddressSync(
    [PROTOCOL_CONFIG_SEED],
    cushionProgramId
  );

  const mode =
    KLEND.equals(MAINNET_KLEND_PROGRAM_ID) &&
    FARMS_PROGRAM.equals(MAINNET_FARMS_PROGRAM_ID)
      ? 0
      : 1;

  const current = await provider.connection.getAccountInfo(protocolConfig, "confirmed");

  if (!current) {
    const ix = new TransactionInstruction({
      programId: cushionProgramId,
      keys: [
        { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: protocolConfig, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        discriminator("init_protocol_config"),
        KLEND.toBuffer(),
        FARMS_PROGRAM.toBuffer(),
        Buffer.from([mode]),
      ]),
    });

    await provider.sendAndConfirm(new Transaction().add(ix), []);
    return;
  }

  const parsed = readProtocolConfig(Buffer.from(current.data));
  const needsUpdate =
    !parsed.klendProgramId.equals(KLEND) ||
    !parsed.farmsProgramId.equals(FARMS_PROGRAM) ||
    parsed.mode !== mode;

  if (!needsUpdate) return;

  const ix = new TransactionInstruction({
    programId: cushionProgramId,
    keys: [
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: protocolConfig, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      discriminator("update_protocol_config"),
      KLEND.toBuffer(),
      FARMS_PROGRAM.toBuffer(),
      Buffer.from([mode]),
    ]),
  });

  await provider.sendAndConfirm(new Transaction().add(ix), []);
});

before(function () {
  try {
    const provider = anchor.AnchorProvider.env();
    const endpoint = provider.connection.rpcEndpoint;
    console.log(`[tests/setup] Anchor provider RPC endpoint: ${endpoint}`);
    const wsEndpoint = (provider.connection as any)?._rpcWsEndpoint;
    if (wsEndpoint) {
      console.log(`[tests/setup] Anchor provider WS endpoint: ${wsEndpoint}`);
    }
  } catch (err) {
    console.warn(
      `[tests/setup] Unable to read Anchor provider endpoint from env: ${String(err)}`
    );
  }
});
