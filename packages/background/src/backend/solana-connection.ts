import type {
  CustomSplTokenAccountsResponse,
  EventEmitter,
  Notification,
  SolanaTokenAccountWithKeyAndProgramIdString,
  SplNftMetadataString,
  TokenMetadataString,
} from "@coral-xyz/common";
import {
  BACKEND_EVENT,
  BackgroundSolanaConnection,
  Blockchain,
  confirmTransaction,
  customSplTokenAccounts,
  fetchSplMetadataUri,
  getLogger,
  NOTIFICATION_BLOCKCHAIN_KEYRING_CREATED,
  NOTIFICATION_BLOCKCHAIN_KEYRING_DELETED,
  NOTIFICATION_KEYRING_STORE_CREATED,
  NOTIFICATION_KEYRING_STORE_LOCKED,
  NOTIFICATION_KEYRING_STORE_UNLOCKED,
  NOTIFICATION_SOLANA_ACTIVE_WALLET_UPDATED,
  NOTIFICATION_SOLANA_CONNECTION_URL_UPDATED,
  NOTIFICATION_SOLANA_SPL_TOKENS_DID_UPDATE,
} from "@coral-xyz/common";
import type {
  AccountBalancePair,
  AccountChangeCallback,
  AccountInfo,
  AddressLookupTableAccount,
  Blockhash,
  BlockheightBasedTransactionConfirmationStrategy,
  BlockProduction,
  BlockResponse,
  BlockSignatures,
  Commitment,
  ConfirmedBlock,
  ConfirmedSignatureInfo,
  ConfirmedSignaturesForAddress2Options,
  ConfirmedTransaction,
  ContactInfo,
  EpochInfo,
  EpochSchedule,
  FeeCalculator,
  Finality,
  GetAccountInfoConfig,
  GetBlockProductionConfig,
  GetLargestAccountsConfig,
  GetParsedProgramAccountsConfig,
  GetProgramAccountsConfig,
  GetProgramAccountsFilter,
  GetSupplyConfig,
  InflationGovernor,
  InflationReward,
  LeaderSchedule,
  LogsCallback,
  LogsFilter,
  Message,
  NonceAccount,
  ParsedAccountData,
  ParsedConfirmedTransaction,
  PerfSample,
  ProgramAccountChangeCallback,
  RootChangeCallback,
  RpcResponseAndContext,
  SendOptions,
  SignatureResult,
  SignatureResultCallback,
  SignaturesForAddressOptions,
  SignatureStatus,
  SignatureStatusConfig,
  SignatureSubscriptionCallback,
  SignatureSubscriptionOptions,
  Signer,
  SimulatedTransactionResponse,
  SimulateTransactionConfig,
  SlotChangeCallback,
  SlotUpdateCallback,
  StakeActivationData,
  Supply,
  TokenAccountBalancePair,
  TokenAccountsFilter,
  TokenAmount,
  Transaction,
  TransactionResponse,
  TransactionSignature,
  Version,
  VersionedMessage,
  VersionedTransaction,
  VoteAccountStatus,
} from "@solana/web3.js";
import { Connection, PublicKey } from "@solana/web3.js";

import type { CachedValue } from "../types";

const logger = getLogger("solana-connection-backend");

export const LOAD_SPL_TOKENS_REFRESH_INTERVAL = 10 * 1000;
export const RECENT_BLOCKHASH_REFRESH_INTERVAL = 10 * 1000;

// Time until cached values expire. This is arbitrary.
const CACHE_EXPIRY = 15000;
const NFT_CACHE_EXPIRY = 15 * 60000;

export function start(events: EventEmitter): SolanaConnectionBackend {
  const b = new SolanaConnectionBackend(events);
  b.start();
  return b;
}

export class SolanaConnectionBackend {
  private cache = new Map<string, CachedValue<any>>();
  private connection?: Connection;
  private url?: string;
  private pollIntervals: Array<any>;
  private events: EventEmitter;
  private lastCustomSplTokenAccountsKey: string;

  constructor(events: EventEmitter) {
    this.pollIntervals = [];
    this.events = events;
    this.lastCustomSplTokenAccountsKey = "";
  }

  public start() {
    this.setupEventListeners();
  }

  //
  // The connection backend needs to change its behavior based on what happens
  // in the core backend. E.g., if the keyring store gets locked, then we
  // need to stop polling.
  //
  private setupEventListeners() {
    this.events.addListener(BACKEND_EVENT, (notif: Notification) => {
      logger.debug(`received notification: ${notif.name}`, notif);

      switch (notif.name) {
        case NOTIFICATION_KEYRING_STORE_CREATED:
          handleKeyringStoreCreated(notif);
          break;
        case NOTIFICATION_KEYRING_STORE_UNLOCKED:
          handleKeyringStoreUnlocked(notif);
          break;
        case NOTIFICATION_KEYRING_STORE_LOCKED:
          handleKeyringStoreLocked(notif);
          break;
        case NOTIFICATION_SOLANA_ACTIVE_WALLET_UPDATED:
          handleActiveWalletUpdated(notif);
          break;
        case NOTIFICATION_SOLANA_CONNECTION_URL_UPDATED:
          handleConnectionUrlUpdated(notif);
          break;
        case NOTIFICATION_BLOCKCHAIN_KEYRING_CREATED:
          handleBlockchainKeyringCreated(notif);
          break;
        case NOTIFICATION_BLOCKCHAIN_KEYRING_DELETED:
          handleBlockchainKeyringDeleted(notif);
          break;
        default:
          break;
      }
    });

    const handleKeyringStoreCreated = (notif: Notification) => {
      handleKeyringStoreUnlocked(notif);
    };

    const handleKeyringStoreUnlocked = (notif: Notification) => {
      const { blockchainActiveWallets, solanaConnectionUrl, solanaCommitment } =
        notif.data;

      this.connection = new Connection(solanaConnectionUrl, solanaCommitment);
      this.url = solanaConnectionUrl;

      this.hookRpcRequest();

      const activeWallet = blockchainActiveWallets[Blockchain.SOLANA];
      if (activeWallet) {
        this.startPolling(new PublicKey(activeWallet));
      }
    };

    const handleKeyringStoreLocked = (_notif: Notification) => {
      this.stopPolling();
    };

    const handleActiveWalletUpdated = (notif: Notification) => {
      const { activeWallet } = notif.data;
      this.stopPolling();
      this.startPolling(new PublicKey(activeWallet));
    };

    const handleConnectionUrlUpdated = (notif: Notification) => {
      const { activeWallet, url } = notif.data;
      this.connection = new Connection(url, this.connection!.commitment);
      this.url = url;
      // activeWallet can be null if the blockchain is disabled, in that case
      // we don't want to start polling
      if (activeWallet) {
        this.stopPolling();
        this.hookRpcRequest();
        this.startPolling(new PublicKey(activeWallet));
      }
    };

    const handleBlockchainKeyringCreated = (notif: Notification) => {
      const { blockchain, activeWallet } = notif.data;
      if (blockchain === Blockchain.SOLANA) {
        // Start polling if Solana was enabled in wallet settings
        this.startPolling(new PublicKey(activeWallet));
      }
    };

    const handleBlockchainKeyringDeleted = (notif: Notification) => {
      const { blockchain } = notif.data;
      if (blockchain === Blockchain.SOLANA) {
        this.stopPolling();
      }
    };
  }

  //
  // Poll for data in the background script so that, even if the popup closes
  // the data is still fresh.
  //
  private async startPolling(activeWallet: PublicKey) {
    const connection = new Connection(this.url!); // Unhooked connection.
    this.pollIntervals.push(
      setInterval(async () => {
        const data = await customSplTokenAccounts(connection, activeWallet);
        const dataKey = this.intoCustomSplTokenAccountsKey(data);

        if (dataKey === this.lastCustomSplTokenAccountsKey) {
          return;
        }

        this.lastCustomSplTokenAccountsKey = dataKey;
        const key = JSON.stringify({
          url: this.url,
          method: "customSplTokenAccounts",
          args: [activeWallet.toString()],
        });
        this.cache.set(key, {
          ts: Date.now(),
          value: data,
        });
        this.events.emit(BACKEND_EVENT, {
          name: NOTIFICATION_SOLANA_SPL_TOKENS_DID_UPDATE,
          data: {
            connectionUrl: this.url,
            publicKey: activeWallet.toString(),
            customSplTokenAccounts:
              BackgroundSolanaConnection.customSplTokenAccountsToJson(data),
          },
        });
      }, LOAD_SPL_TOKENS_REFRESH_INTERVAL)
    );

    this.pollIntervals.push(
      setInterval(async () => {
        const conn = new Connection(this.url!); // Unhooked connection.
        const data = await conn.getLatestBlockhash();
        const key = JSON.stringify({
          url: this.url,
          method: "getLatestBlockhash",
          args: [],
        });
        this.cache.set(key, {
          ts: Date.now(),
          value: data,
        });
      }, RECENT_BLOCKHASH_REFRESH_INTERVAL)
    );
  }

  private intoCustomSplTokenAccountsKey(
    resp: CustomSplTokenAccountsResponse
  ): string {
    //
    // We sort the data so that we can have a consistent key when teh data
    // doesn't change. We remove the mints and metadata from the key because
    // it's not neceessary at all when calculating whether something has
    // changed.
    //
    return JSON.stringify({
      nfts: {
        nftTokens: resp.nfts.nftTokens
          .slice()
          .sort((a: any, b: any) =>
            a.key.toString().localeCompare(b.key.toString())
          ),
      },
      fts: {
        fungibleTokens: resp.fts.fungibleTokens
          .slice()
          .sort((a: any, b: any) =>
            a.key.toString().localeCompare(b.key.toString())
          ),
      },
    });
  }

  private stopPolling() {
    this.pollIntervals.forEach((interval: number) => {
      clearInterval(interval);
    });
  }

  private hookRpcRequest() {
    // @ts-ignore
    const _rpcRequest = this.connection._rpcRequest;
    // @ts-ignore
    this.connection._rpcRequest = async (method: string, args: any[]) => {
      const key = JSON.stringify({
        url: this.url,
        method,
        args,
      });

      // Only use cached values at most 15 seconds old.
      const value = this.cache.get(key);
      //
      // This should never expire, but some projects use mutable urls rather
      // than IPFS or Arweave :(.
      //
      if (value && value.ts + CACHE_EXPIRY > Date.now()) {
        return value.value;
      }
      const resp = await _rpcRequest(method, args);
      this.cache.set(key, {
        ts: Date.now(),
        value: resp,
      });
      return resp;
    };
  }

  //////////////////////////////////////////////////////////////////////////////
  // Custom endpoints.
  //////////////////////////////////////////////////////////////////////////////

  async customSplTokenAccounts(
    publicKey: PublicKey
  ): Promise<CustomSplTokenAccountsResponse> {
    const key = JSON.stringify({
      url: this.url,
      method: "customSplTokenAccounts",
      args: [publicKey.toString()],
    });
    const value = this.cache.get(key);
    if (value && value.ts + CACHE_EXPIRY > Date.now()) {
      return value.value;
    }
    const resp = await customSplTokenAccounts(this.connection!, publicKey);

    // Set once if the background poller hasn't run yet.
    if (this.lastCustomSplTokenAccountsKey === "") {
      this.lastCustomSplTokenAccountsKey =
        this.intoCustomSplTokenAccountsKey(resp);
    }

    this.cache.set(key, {
      ts: Date.now(),
      value: resp,
    });
    return resp;
  }

  async customSplMetadataUri(
    tokens: Array<SolanaTokenAccountWithKeyAndProgramIdString>,
    tokenMetadata: Array<TokenMetadataString | null>
  ): Promise<Array<[string, SplNftMetadataString]>> {
    const key = JSON.stringify({
      url: this.url,
      method: "customSplMetadataUri",
      args: [tokens.map((t) => t.key).sort()],
    });
    const value = this.cache.get(key);
    if (value && value.ts + NFT_CACHE_EXPIRY > Date.now()) {
      return value.value;
    }
    const resp = await fetchSplMetadataUri(tokens, tokenMetadata);
    this.cache.set(key, {
      ts: Date.now(),
      value: resp,
    });
    return resp;
  }

  //////////////////////////////////////////////////////////////////////////////
  // Solana Connection API.
  //////////////////////////////////////////////////////////////////////////////

  async getAccountInfo(
    publicKey: PublicKey,
    commitment?: Commitment
  ): Promise<AccountInfo<Buffer> | null> {
    return await this.connection!.getAccountInfo(publicKey, commitment);
  }

  async getAccountInfoAndContext(
    publicKey: PublicKey,
    commitment?: Commitment
  ): Promise<RpcResponseAndContext<AccountInfo<Buffer> | null>> {
    return await this.connection!.getAccountInfoAndContext(
      publicKey,
      commitment
    );
  }

  async getLatestBlockhash(commitment?: Commitment): Promise<{
    blockhash: Blockhash;
    lastValidBlockHeight: number;
  }> {
    if (!this.connection) {
      throw new Error("inner connection not found");
    }
    const resp = await this.connection!.getLatestBlockhash(commitment);
    return resp;
  }

  async getLatestBlockhashAndContext(commitment?: Commitment): Promise<
    RpcResponseAndContext<{
      blockhash: Blockhash;
      lastValidBlockHeight: number;
    }>
  > {
    const resp = await this.connection!.getLatestBlockhashAndContext(
      commitment
    );
    return resp;
  }

  async getTokenAccountsByOwner(
    ownerAddress: PublicKey,
    filter: TokenAccountsFilter,
    commitment?: Commitment
  ): Promise<
    RpcResponseAndContext<
      Array<{
        pubkey: PublicKey;
        account: AccountInfo<Buffer>;
      }>
    >
  > {
    return await this.connection!.getTokenAccountsByOwner(
      ownerAddress,
      filter,
      commitment
    );
  }

  async sendRawTransaction(
    rawTransaction: Buffer | Uint8Array | Array<number>,
    options?: SendOptions
  ): Promise<TransactionSignature> {
    return await this.connection!.sendRawTransaction(rawTransaction, options);
  }

  async confirmTransaction(
    strategy: BlockheightBasedTransactionConfirmationStrategy,
    commitment?: Commitment
  ): Promise<RpcResponseAndContext<SignatureResult>> {
    const tx = await confirmTransaction(
      this.connection!,
      strategy.signature,
      commitment === "confirmed" || commitment === "finalized"
        ? commitment
        : "confirmed"
    );
    return {
      context: {
        slot: tx!.slot,
      },
      value: {
        err: null,
      },
    };
  }

  async simulateTransaction(
    transactionOrMessage: Transaction | VersionedTransaction | Message,
    configOrSigners?: Array<Signer> | SimulateTransactionConfig,
    includeAccounts?: boolean | Array<PublicKey>
  ): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
    if ("message" in transactionOrMessage) {
      // VersionedTransaction
      if (Array.isArray(configOrSigners)) {
        throw new Error("Invalid arguments to simulateTransaction");
      }
      return await this.connection!.simulateTransaction(
        transactionOrMessage,
        configOrSigners
      );
    } else {
      // Deprecated
      return await this.connection!.simulateTransaction(
        transactionOrMessage,
        configOrSigners as Array<Signer>,
        includeAccounts
      );
    }
  }

  async getMultipleAccountsInfo(
    publicKeys: PublicKey[],
    commitment?: Commitment
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    return await this.connection!.getMultipleAccountsInfo(
      publicKeys,
      commitment
    );
  }

  async getConfirmedSignaturesForAddress2(
    address: PublicKey,
    options?: ConfirmedSignaturesForAddress2Options,
    commitment?: Finality
  ): Promise<Array<ConfirmedSignatureInfo>> {
    return await this.connection!.getConfirmedSignaturesForAddress2(
      address,
      options,
      commitment ?? "confirmed"
    );
  }

  async getParsedTransactions(
    signatures: TransactionSignature[],
    commitment?: Finality
  ): Promise<ReturnType<Connection["getParsedTransactions"]>> {
    return await this.connection!.getParsedTransactions(signatures, {
      commitment: commitment ?? "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  }

  async getParsedTransaction(
    signature: TransactionSignature,
    commitment?: Finality
  ): ReturnType<Connection["getParsedTransaction"]> {
    const conn = new Connection(this.url!); // Unhooked connection.
    return await conn.getParsedTransaction(signature, {
      commitment: commitment ?? "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  }

  async getProgramAccounts(
    programId: PublicKey,
    configOrCommitment?: GetProgramAccountsConfig | Commitment
  ): Promise<
    Array<{
      pubkey: PublicKey;
      account: AccountInfo<Buffer>;
    }>
  > {
    return await this.connection!.getProgramAccounts(
      programId,
      configOrCommitment
    );
  }

  async getFeeForMessage(
    message: VersionedMessage,
    commitment?: Commitment
  ): Promise<RpcResponseAndContext<number>> {
    const encodedMessage = Buffer.from(message.serialize()).toString("base64");
    return await this.connection!.getFeeForMessage(
      {
        serialize: () => ({
          toString: () => {
            return encodedMessage;
          },
        }),
      } as Message,
      commitment
    );
  }

  async getMinimumBalanceForRentExemption(
    dataLength: number,
    commitment?: Commitment
  ): Promise<number> {
    return await this.connection!.getMinimumBalanceForRentExemption(
      dataLength,
      commitment
    );
  }

  async getTokenAccountBalance(
    tokenAddress: PublicKey,
    commitment?: Commitment
  ): Promise<RpcResponseAndContext<TokenAmount>> {
    return await this.connection!.getTokenAccountBalance(
      tokenAddress,
      commitment
    );
  }

  async getBalance(
    publicKey: PublicKey,
    commitment?: Commitment
  ): Promise<number> {
    return await this.connection!.getBalance(publicKey, commitment);
  }

  async getSlot(commitment?: Commitment): Promise<number> {
    return await this.connection!.getSlot(commitment);
  }

  async getBlockTime(slot: number): Promise<number | null> {
    return await this.connection!.getBlockTime(slot);
  }

  async getParsedTokenAccountsByOwner(
    ownerAddress: PublicKey,
    filter: TokenAccountsFilter,
    commitment?: Commitment
  ): Promise<
    RpcResponseAndContext<
      Array<{
        pubkey: PublicKey;
        account: AccountInfo<ParsedAccountData>;
      }>
    >
  > {
    return await this.connection!.getParsedTokenAccountsByOwner(
      ownerAddress,
      filter,
      commitment
    );
  }

  async getTokenLargestAccounts(
    mintAddress: PublicKey,
    commitment?: Commitment
  ): Promise<RpcResponseAndContext<Array<TokenAccountBalancePair>>> {
    return await this.connection!.getTokenLargestAccounts(
      mintAddress,
      commitment
    );
  }

  async getParsedAccountInfo(
    publicKey: PublicKey,
    commitment?: Commitment
  ): Promise<
    RpcResponseAndContext<AccountInfo<Buffer | ParsedAccountData> | null>
  > {
    return await this.connection!.getParsedAccountInfo(publicKey, commitment);
  }

  async getParsedProgramAccounts(
    programId: PublicKey,
    configOrCommitment?: GetParsedProgramAccountsConfig | Commitment
  ): Promise<
    Array<{
      pubkey: PublicKey;
      account: AccountInfo<Buffer | ParsedAccountData>;
    }>
  > {
    return await this.connection!.getParsedProgramAccounts(
      programId,
      configOrCommitment
    );
  }

  async getAddressLookupTable(
    programId: PublicKey,
    config?: GetAccountInfoConfig
  ): Promise<RpcResponseAndContext<AddressLookupTableAccount | null>> {
    return await this.connection!.getAddressLookupTable(programId, config);
  }

  ///////////////////////////////////////////////////////////////////////////////
  // Methods below not used currently.
  ///////////////////////////////////////////////////////////////////////////////

  async getBalanceAndContext(
    _publicKey: PublicKey,
    _commitment?: Commitment
  ): Promise<RpcResponseAndContext<number>> {
    throw new Error("not implemented");
  }

  async getMinimumLedgerSlot(): Promise<number> {
    throw new Error("not implemented");
  }

  async getFirstAvailableBlock(): Promise<number> {
    throw new Error("not implemented");
  }

  async getSupply(
    _config?: GetSupplyConfig | Commitment
  ): Promise<RpcResponseAndContext<Supply>> {
    throw new Error("not implemented");
  }

  async getTokenSupply(
    _tokenMintAddress: PublicKey,
    _commitment?: Commitment
  ): Promise<RpcResponseAndContext<TokenAmount>> {
    throw new Error("not implemented");
  }

  async getLargestAccounts(
    _config?: GetLargestAccountsConfig
  ): Promise<RpcResponseAndContext<Array<AccountBalancePair>>> {
    throw new Error("not implemented");
  }

  async getMultipleAccountsInfoAndContext(
    _publicKeys: PublicKey[],
    _commitment?: Commitment
  ): Promise<RpcResponseAndContext<(AccountInfo<Buffer> | null)[]>> {
    throw new Error("not implemented");
  }

  async getStakeActivation(
    _publicKey: PublicKey,
    _commitment?: Commitment,
    _epoch?: number
  ): Promise<StakeActivationData> {
    throw new Error("not implemented");
  }

  getClusterNodes(): Promise<Array<ContactInfo>> {
    throw new Error("not implemented");
  }

  getVoteAccounts(_commitment?: Commitment): Promise<VoteAccountStatus> {
    throw new Error("not implemented");
  }

  getSlotLeader(_commitment?: Commitment): Promise<string> {
    throw new Error("not implemented");
  }

  getSlotLeaders(
    _startSlot: number,
    _limit: number
  ): Promise<Array<PublicKey>> {
    throw new Error("not implemented");
  }

  getSignatureStatus(
    _signature: TransactionSignature,
    _config?: SignatureStatusConfig
  ): Promise<RpcResponseAndContext<SignatureStatus | null>> {
    throw new Error("not implemented");
  }

  getSignatureStatuses(
    _signatures: Array<TransactionSignature>,
    _config?: SignatureStatusConfig
  ): Promise<RpcResponseAndContext<Array<SignatureStatus | null>>> {
    throw new Error("not implemented");
  }

  getTransactionCount(_commitment?: Commitment): Promise<number> {
    throw new Error("not implemented");
  }

  getTotalSupply(_commitment?: Commitment): Promise<number> {
    throw new Error("not implemented");
  }

  getInflationGovernor(_commitment?: Commitment): Promise<InflationGovernor> {
    throw new Error("not implemented");
  }

  getInflationReward(
    _addresses: PublicKey[],
    _epoch?: number,
    _commitment?: Commitment
  ): Promise<(InflationReward | null)[]> {
    throw new Error("not implemented");
  }

  getEpochInfo(_commitment?: Commitment): Promise<EpochInfo> {
    throw new Error("not implemented");
  }

  getEpochSchedule(): Promise<EpochSchedule> {
    throw new Error("not implemented");
  }

  getLeaderSchedule(): Promise<LeaderSchedule> {
    throw new Error("not implemented");
  }

  getRecentBlockhashAndContext(_commitment?: Commitment): Promise<
    RpcResponseAndContext<{
      blockhash: Blockhash;
      feeCalculator: FeeCalculator;
    }>
  > {
    throw new Error("not implemented");
  }

  getRecentPerformanceSamples(_limit?: number): Promise<Array<PerfSample>> {
    throw new Error("not implemented");
  }

  getFeeCalculatorForBlockhash(
    _blockhash: Blockhash,
    _commitment?: Commitment
  ): Promise<RpcResponseAndContext<FeeCalculator | null>> {
    throw new Error("not implemented");
  }

  getRecentBlockhash(_commitment?: Commitment): Promise<{
    blockhash: Blockhash;
    feeCalculator: FeeCalculator;
  }> {
    throw new Error("not implemented");
  }

  getVersion(): Promise<Version> {
    throw new Error("not implemented");
  }

  getGenesisHash(): Promise<string> {
    throw new Error("not implemented");
  }
  getBlock(
    _slot: number,
    _opts?: {
      commitment?: Finality;
    }
  ): Promise<BlockResponse | null> {
    throw new Error("not implemented");
  }
  getBlockHeight(_commitment?: Commitment): Promise<number> {
    throw new Error("not implemented");
  }
  getBlockProduction(
    _configOrCommitment?: GetBlockProductionConfig | Commitment
  ): Promise<RpcResponseAndContext<BlockProduction>> {
    throw new Error("not implemented");
  }

  getTransaction(
    _signature: string,
    _opts?: {
      commitment?: Finality;
    }
  ): Promise<TransactionResponse | null> {
    throw new Error("not implemented");
  }

  getConfirmedBlock(
    _slot: number,
    _commitment?: Finality
  ): Promise<ConfirmedBlock> {
    throw new Error("not implemented");
  }

  getBlocks(
    _startSlot: number,
    _endSlot?: number,
    _commitment?: Finality
  ): Promise<Array<number>> {
    throw new Error("not implemented");
  }

  getBlockSignatures(
    _slot: number,
    _commitment?: Finality
  ): Promise<BlockSignatures> {
    throw new Error("not implemented");
  }

  getConfirmedBlockSignatures(
    _slot: number,
    _commitment?: Finality
  ): Promise<BlockSignatures> {
    throw new Error("not implemented");
  }

  getConfirmedTransaction(
    _signature: TransactionSignature,
    _commitment?: Finality
  ): Promise<ConfirmedTransaction | null> {
    throw new Error("not implemented");
  }

  getParsedConfirmedTransaction(
    _signature: TransactionSignature,
    _commitment?: Finality
  ): Promise<ParsedConfirmedTransaction | null> {
    throw new Error("not implemented");
  }

  getParsedConfirmedTransactions(
    _signatures: TransactionSignature[],
    _commitment?: Finality
  ): Promise<(ParsedConfirmedTransaction | null)[]> {
    throw new Error("not implemented");
  }

  getConfirmedSignaturesForAddress(
    _address: PublicKey,
    _startSlot: number,
    _endSlot: number
  ): Promise<Array<TransactionSignature>> {
    throw new Error("not implemented");
  }

  getSignaturesForAddress(
    _address: PublicKey,
    _options?: SignaturesForAddressOptions,
    _commitment?: Finality
  ): Promise<Array<ConfirmedSignatureInfo>> {
    throw new Error("not implemented");
  }

  getNonceAndContext(
    _nonceAccount: PublicKey,
    _commitment?: Commitment
  ): Promise<RpcResponseAndContext<NonceAccount | null>> {
    throw new Error("not implemented");
  }

  getNonce(
    _nonceAccount: PublicKey,
    _commitment?: Commitment
  ): Promise<NonceAccount | null> {
    throw new Error("not implemented");
  }

  requestAirdrop(
    _to: PublicKey,
    _lamports: number
  ): Promise<TransactionSignature> {
    throw new Error("not implemented");
  }

  sendTransaction(
    _transaction: Transaction,
    _signers: Array<Signer>,
    _options?: SendOptions
  ): Promise<TransactionSignature> {
    throw new Error("not implemented");
  }

  sendEncodedTransaction(
    _encodedTransaction: string,
    _options?: SendOptions
  ): Promise<TransactionSignature> {
    throw new Error("not implemented");
  }

  onAccountChange(
    _publicKey: PublicKey,
    _callback: AccountChangeCallback,
    _commitment?: Commitment
  ): number {
    throw new Error("not implemented");
  }

  removeAccountChangeListener(_id: number): Promise<void> {
    throw new Error("not implemented");
  }

  onProgramAccountChange(
    _programId: PublicKey,
    _callback: ProgramAccountChangeCallback,
    _commitment?: Commitment,
    _filters?: GetProgramAccountsFilter[]
  ): number {
    throw new Error("not implemented");
  }

  removeProgramAccountChangeListener(_id: number): Promise<void> {
    throw new Error("not implemented");
  }

  onLogs(
    _filter: LogsFilter,
    _callback: LogsCallback,
    _commitment?: Commitment
  ): number {
    throw new Error("not implemented");
  }

  removeOnLogsListener(_id: number): Promise<void> {
    throw new Error("not implemented");
  }
  onSlotChange(_callback: SlotChangeCallback): number {
    throw new Error("not implemented");
  }
  removeSlotChangeListener(_id: number): Promise<void> {
    throw new Error("not implemented");
  }
  onSlotUpdate(_callback: SlotUpdateCallback): number {
    throw new Error("not implemented");
  }
  removeSlotUpdateListener(_id: number): Promise<void> {
    throw new Error("not implemented");
  }

  _buildArgs(
    _args: Array<any>,
    _override?: Commitment,
    _encoding?: "jsonParsed" | "base64",
    _extra?: any
  ): Array<any> {
    throw new Error("not implemented");
  }

  onSignature(
    _signature: TransactionSignature,
    _callback: SignatureResultCallback,
    _commitment?: Commitment
  ): number {
    throw new Error("not implemented");
  }

  onSignatureWithOptions(
    _signature: TransactionSignature,
    _callback: SignatureSubscriptionCallback,
    _options?: SignatureSubscriptionOptions
  ): number {
    throw new Error("not implemented");
  }

  removeSignatureListener(_id: number): Promise<void> {
    throw new Error("not implemented");
  }

  onRootChange(_callback: RootChangeCallback): number {
    throw new Error("not implemented");
  }

  removeRootChangeListener(_id: number): Promise<void> {
    throw new Error("not implemented");
  }
}
