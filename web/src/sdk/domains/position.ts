import { Keypair, PublicKey, SystemProgram, type ConfirmOptions, type Signer, type TransactionSignature } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SYSVAR_RENT_PUBKEY } from "@solana/web3.js";

import type { CushionSdkContext } from "../core/context.ts";
import { buildTransaction, sendBuiltTransaction, type BuiltTx } from "../core/anchor.ts";
import {
  deriveFarmUserStateAddress,
  deriveKlendLendingMarketAuthorityAddress,
  deriveKlendObligationAddress,
  deriveKlendUserMetadataAddress,
  derivePositionAddress,
  derivePositionAuthorityAddress,
  derivePositionRegistryAddress,
  derivePositionRegistryEntryAddress,
} from "../core/pda.ts";

const POSITION_REGISTRY_ENTRY_SIZE = 8 + 32 + 32 + 32 + 32 + 8 + 1;
const POSITION_REGISTRY_ENTRY_BORROWER_OFFSET = 8 + 32 + 32 + 32;

export type PositionState = {
  address: PublicKey;
  nftMint: PublicKey;
  positionAuthority: PublicKey;
  owner: PublicKey;
  borrower: PublicKey;
  protocolObligation: PublicKey;
  protocolUserMetadata: PublicKey;
  collateralVault: PublicKey;
  injectedAmount: bigint;
  bump: number;
  injected: boolean;
};

export type PositionRegistryEntryState = {
  address: PublicKey;
  nftMint: PublicKey;
  position: PublicKey;
  positionAuthority: PublicKey;
  borrower: PublicKey;
  createdAt: bigint;
  bump: number;
};

export type InitPositionInput = {
  user?: PublicKey;
  collection: PublicKey;
  lendingMarket: PublicKey;
  klendReserve: PublicKey;
  reserveFarmState: PublicKey;
  nftMintSigner?: Signer;
};

type RawObligation = {
  nftMint: PublicKey;
  positionAuthority: PublicKey;
  owner: PublicKey;
  borrower: PublicKey;
  protocolObligation: PublicKey;
  protocolUserMetadata: PublicKey;
  collateralVault: PublicKey;
  injectedAmount: bigint | string | number | { toString(): string };
  bump: number;
  injected: boolean;
};

type RawPositionRegistryEntry = {
  nftMint: PublicKey;
  position: PublicKey;
  positionAuthority: PublicKey;
  borrower: PublicKey;
  createdAt: bigint | string | number | { toString(): string };
  bump: number;
};

function asBigInt(value: RawObligation["injectedAmount"]): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  return BigInt(value.toString());
}

function normalizePosition(address: PublicKey, raw: RawObligation): PositionState {
  return {
    address,
    nftMint: new PublicKey(raw.nftMint),
    positionAuthority: new PublicKey(raw.positionAuthority),
    owner: new PublicKey(raw.owner),
    borrower: new PublicKey(raw.borrower),
    protocolObligation: new PublicKey(raw.protocolObligation),
    protocolUserMetadata: new PublicKey(raw.protocolUserMetadata),
    collateralVault: new PublicKey(raw.collateralVault),
    injectedAmount: asBigInt(raw.injectedAmount),
    bump: raw.bump,
    injected: raw.injected,
  };
}

function normalizePositionRegistryEntry(
  address: PublicKey,
  raw: RawPositionRegistryEntry
): PositionRegistryEntryState {
  return {
    address,
    nftMint: new PublicKey(raw.nftMint),
    position: new PublicKey(raw.position),
    positionAuthority: new PublicKey(raw.positionAuthority),
    borrower: new PublicKey(raw.borrower),
    createdAt: asBigInt(raw.createdAt),
    bump: raw.bump,
  };
}

function toSigner(signer: Signer | undefined): Signer {
  if (!signer) {
    return Keypair.generate();
  }
  return signer;
}

export function createPositionDomain(context: CushionSdkContext) {
  const program = context.program as unknown as {
    account: {
      obligation: { fetch: (address: PublicKey) => Promise<RawObligation> };
      positionRegistryEntry: { fetch: (address: PublicKey) => Promise<RawPositionRegistryEntry> };
    };
    methods: {
      initPosition: () => { accountsStrict: (accounts: Record<string, unknown>) => { transaction: () => Promise<import("@solana/web3.js").Transaction> } };
    };
    coder: {
      accounts: {
        decode: (name: string, data: Buffer) => RawPositionRegistryEntry;
      };
    };
  };

  async function getPosition(input: { position?: PublicKey; nftMint?: PublicKey }): Promise<PositionState> {
    if (!input.position && !input.nftMint) {
      throw new Error("Either position or nftMint must be provided");
    }

    const positionAddress =
      input.position ?? derivePositionAddress(context.cushionProgramId, input.nftMint as PublicKey);

    const account = await program.account.obligation.fetch(positionAddress);
    return normalizePosition(positionAddress, account);
  }

  async function getPositionRegistryEntryByNftMint(
    nftMint: PublicKey
  ): Promise<PositionRegistryEntryState> {
    const address = derivePositionRegistryEntryAddress(context.cushionProgramId, nftMint);
    const account = await program.account.positionRegistryEntry.fetch(address);
    return normalizePositionRegistryEntry(address, account);
  }

  async function getUserPositions(input?: { owner?: PublicKey }): Promise<PositionState[]> {
    const owner = input?.owner ?? context.walletPublicKey;
    const accounts = await context.connection.getProgramAccounts(context.cushionProgramId, {
      commitment: "confirmed",
      filters: [
        { dataSize: POSITION_REGISTRY_ENTRY_SIZE },
        {
          memcmp: {
            offset: POSITION_REGISTRY_ENTRY_BORROWER_OFFSET,
            bytes: owner.toBase58(),
          },
        },
      ],
    });

    const positions: PositionState[] = [];

    for (const account of accounts) {
      let entry: RawPositionRegistryEntry;
      try {
        entry = program.coder.accounts.decode("positionRegistryEntry", Buffer.from(account.account.data));
      } catch {
        continue;
      }

      try {
        const position = await getPosition({ position: new PublicKey(entry.position) });
        positions.push(position);
      } catch {
        continue;
      }
    }

    return positions;
  }

  async function buildInitPositionTx(input: InitPositionInput): Promise<BuiltTx> {
    const user = input.user ?? context.walletPublicKey;
    const nftMintSigner = toSigner(input.nftMintSigner);
    const nftMint = nftMintSigner.publicKey;

    const position = derivePositionAddress(context.cushionProgramId, nftMint);
    const positionAuthority = derivePositionAuthorityAddress(context.cushionProgramId, nftMint);
    const positionRegistry = derivePositionRegistryAddress(context.cushionProgramId);
    const positionRegistryEntry = derivePositionRegistryEntryAddress(context.cushionProgramId, nftMint);

    const klendUserMetadata = deriveKlendUserMetadataAddress(
      context.config.klendProgramId,
      positionAuthority
    );

    const klendObligation = deriveKlendObligationAddress(
      context.config.klendProgramId,
      positionAuthority,
      input.lendingMarket
    );

    const lendingMarketAuthority = deriveKlendLendingMarketAuthorityAddress(
      context.config.klendProgramId,
      input.lendingMarket
    );

    const obligationFarmUserState = deriveFarmUserStateAddress(
      context.config.farmsProgramId,
      input.reserveFarmState,
      klendObligation
    );

    const method = program.methods.initPosition().accountsStrict({
      user,
      nftMint,
      collection: input.collection,
      positionAuthority,
      position,
      positionRegistry,
      positionRegistryEntry,
      klendUserMetadata,
      klendObligation,
      klendReserve: input.klendReserve,
      reserveFarmState: input.reserveFarmState,
      obligationFarmUserState,
      lendingMarket: input.lendingMarket,
      lendingMarketAuthority,
      klendProgram: context.config.klendProgramId,
      farmsProgram: context.config.farmsProgramId,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
      mplCoreProgram: context.config.mplCoreProgramId,
    });

    return buildTransaction({
      context,
      methodBuilder: method,
      signers: [nftMintSigner],
    });
  }

  async function initPosition(
    input: InitPositionInput,
    options?: ConfirmOptions
  ): Promise<TransactionSignature> {
    const built = await buildInitPositionTx(input);
    return sendBuiltTransaction(context, built, options);
  }

  return {
    derivePositionAddress: (nftMint: PublicKey) => derivePositionAddress(context.cushionProgramId, nftMint),
    derivePositionAuthorityAddress: (nftMint: PublicKey) =>
      derivePositionAuthorityAddress(context.cushionProgramId, nftMint),
    derivePositionRegistryAddress: () => derivePositionRegistryAddress(context.cushionProgramId),
    derivePositionRegistryEntryAddress: (nftMint: PublicKey) =>
      derivePositionRegistryEntryAddress(context.cushionProgramId, nftMint),
    getPosition,
    getPositionRegistryEntryByNftMint,
    getUserPositions,
    buildInitPositionTx,
    initPosition,
  };
}
