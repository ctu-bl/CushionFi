import type { AnchorProvider } from "@coral-xyz/anchor";
import type { ConfirmOptions, PublicKey, Signer, Transaction, TransactionSignature } from "@solana/web3.js";

export type SendTxInput = {
  transaction: Transaction;
  signers?: Signer[];
  options?: ConfirmOptions;
};

export interface TxSender {
  send(input: SendTxInput): Promise<TransactionSignature>;
  getPublicKey(): PublicKey;
}

export class AnchorProviderTxSender implements TxSender {
  private readonly provider: AnchorProvider;

  constructor(provider: AnchorProvider) {
    this.provider = provider;
  }

  async send(input: SendTxInput): Promise<TransactionSignature> {
    return this.provider.sendAndConfirm(input.transaction, input.signers ?? [], input.options);
  }

  getPublicKey(): PublicKey {
    return this.provider.wallet.publicKey;
  }
}

export type WalletAdapterLike = {
  publicKey: PublicKey | null;
  sendTransaction: (
    transaction: Transaction,
    connection: AnchorProvider["connection"],
    options?: ConfirmOptions
  ) => Promise<TransactionSignature>;
};

export class WalletAdapterTxSender implements TxSender {
  private readonly provider: AnchorProvider;
  private readonly wallet: WalletAdapterLike;

  constructor(
    provider: AnchorProvider,
    wallet: WalletAdapterLike
  ) {
    this.provider = provider;
    this.wallet = wallet;
  }

  async send(input: SendTxInput): Promise<TransactionSignature> {
    if (!this.wallet.publicKey) {
      throw new Error("Wallet is not connected");
    }

    if ((input.signers?.length ?? 0) > 0) {
      input.transaction.partialSign(...(input.signers ?? []));
    }

    return this.wallet.sendTransaction(input.transaction, this.provider.connection, input.options);
  }

  getPublicKey(): PublicKey {
    if (!this.wallet.publicKey) {
      throw new Error("Wallet is not connected");
    }
    return this.wallet.publicKey;
  }
}
