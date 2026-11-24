import { ethers } from "ethers";
import { validate as isValidBtcAddress, Network as BtcNetwork } from "bitcoin-address-validation";
import {
  EvmBlockchain,
  NonEvmBlockchain,
  isBtcBlockchain,
  isEvmBlockchain,
  type Snapshot,
  type SupportedAsset,
} from "../types";
import { formatTokenAmount } from "../utils/formatNumber";
import { END_OF_DAY_NOT_REACHED_MESSAGE, snapshotTimestamp } from "../utils/snapshot";
import { cacheKey } from "../utils/cacheKey";
import { blockchainLabel } from "../utils/blockchainLabel";
import type { Runtime } from "./runtime";

// Balance lookup for one asset/address at the snapshot instant of a date.
// Framework-free: used by the useWalletBalance hook and by the headless CLI.

export interface FetchBalanceParams {
  asset: SupportedAsset;
  walletAddress: string;
  // Calendar day YYYY-MM-DD, read as UTC.
  date: string;
  snapshot: Snapshot;
}

export interface BalanceAtBlock {
  // Human-readable decimal amount (no trailing zeros).
  balance: string;
  // EVM block number / Bitcoin block height the balance was read at.
  blockNumber: number;
}

const evmRpcHost: Record<EvmBlockchain, string> = {
  [EvmBlockchain.ETH]: "eth-mainnet",
  [EvmBlockchain.POLYGON]: "polygon-mainnet",
  [EvmBlockchain.BSC]: "bnb-mainnet",
  [EvmBlockchain.ARB]: "arb-mainnet",
  [EvmBlockchain.OPT]: "opt-mainnet",
  [EvmBlockchain.BASE]: "base-mainnet",
  [EvmBlockchain.HAQQ]: "haqq-mainnet",
  [EvmBlockchain.GNOSIS]: "gnosis-mainnet",
};

export function evmRpcUrl(rt: Runtime, blockchain: EvmBlockchain): string {
  return `https://${evmRpcHost[blockchain]}.g.alchemy.com/v2/${rt.getAlchemyApiKey()}`;
}

const BTC_DECIMALS = 8;

export async function fetchWalletBalance(
  rt: Runtime,
  { asset, walletAddress, date, snapshot }: FetchBalanceParams,
): Promise<BalanceAtBlock> {
  // "start" = 00:00:00 UTC, "end" = 23:59:59 UTC. The block lookups below
  // resolve the last block at or before this instant, and their caches are
  // keyed by it, so both modes never share a cache entry.
  const targetTimestamp = snapshotTimestamp(date, snapshot);

  // An end-of-day instant in the future (e.g. today) would silently resolve
  // to the chain tip, i.e. the current balance. Refuse instead. The form
  // blocks this case too; this guard covers every other caller. "start" is
  // left untouched: future dates are rejected by the date validation.
  if (snapshot === "end" && targetTimestamp * 1000 > Date.now()) {
    throw new Error(END_OF_DAY_NOT_REACHED_MESSAGE);
  }

  if (isBtcBlockchain(asset.blockchain)) {
    return fetchBitcoinBalance(rt, walletAddress, targetTimestamp);
  }
  if (isEvmBlockchain(asset.blockchain)) {
    return fetchEvmBalance(rt, asset, walletAddress, targetTimestamp, date);
  }
  throw new Error(`Unsupported blockchain: ${asset.blockchain}`);
}

// ---------- EVM ----------

async function fetchEvmBalance(
  rt: Runtime,
  asset: SupportedAsset,
  walletAddress: string,
  targetTimestamp: number,
  date: string,
): Promise<BalanceAtBlock> {
  if (!ethers.isAddress(walletAddress)) throw new Error("Invalid Ethereum address");

  const blockchain = asset.blockchain as EvmBlockchain;
  const blockNumber = await findEvmBlockByTimestamp(rt, blockchain, targetTimestamp);
  if (isNaN(blockNumber)) throw new Error(`Failed to find block for timestamp: ${date}`);

  const label = blockchainLabel(blockchain);
  if (asset.decimals === undefined || asset.decimals === null) {
    throw new Error(`Asset ${asset.name} on ${label} has no decimals — please report this on GitHub.`);
  }

  const normalizedAddress = ethers.getAddress(walletAddress.toLowerCase());
  const blockTag = `0x${blockNumber.toString(16)}`;

  // Native coins (ETH, BNB, POL, xDAI, ...) are not ERC-20 contracts. The DFX
  // asset list carries the *wrapped* token's address as their chainId (WETH
  // for ETH etc.), so balanceOf on it would report the wrapped balance, not
  // the native one. Read the account balance itself instead.
  let rpcRequest: { method: string; params: unknown[] };
  if (asset.type === "Coin") {
    rpcRequest = { method: "eth_getBalance", params: [normalizedAddress, blockTag] };
  } else if (asset.type === "Token") {
    if (!asset.chainId || !ethers.isAddress(asset.chainId)) {
      throw new Error(`Token ${asset.name} on ${label} has no contract address — please report this on GitHub.`);
    }
    const iface = new ethers.Interface(["function balanceOf(address account)"]);
    const edata = iface.encodeFunctionData("balanceOf", [normalizedAddress]);
    rpcRequest = { method: "eth_call", params: [{ to: asset.chainId, data: edata }, blockTag] };
  } else {
    throw new Error(`Asset ${asset.name} on ${label} has an unknown type — please report this on GitHub.`);
  }

  const response = await fetch(evmRpcUrl(rt, blockchain), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...rpcRequest }),
  });

  if (!response.ok) {
    throw new Error(`Alchemy ${response.status} on ${label}: ${response.statusText || "request failed"}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(`RPC error: ${data.error.message}`);

  // A quantity is "0x" + at least one hex digit. eth_call against an address
  // without contract code answers a bare "0x" — that is not a zero balance.
  if (typeof data.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(data.result)) {
    throw new Error(`Unexpected ${rpcRequest.method} response for ${asset.name} on ${label}`);
  }
  const balanceFormatted = ethers.formatUnits(BigInt(data.result), asset.decimals);
  return { balance: formatTokenAmount(balanceFormatted), blockNumber };
}

async function findEvmBlockByTimestamp(
  rt: Runtime,
  blockchain: EvmBlockchain,
  targetTimestamp: number,
): Promise<number> {
  const key = cacheKey(["block", blockchain, targetTimestamp]);

  const cached = rt.cache.get(key);
  if (cached) {
    const parsed = parseInt(cached, 10);
    if (!isNaN(parsed)) return parsed;
  }

  const currentBlock = await getEvmCurrentBlockNumber(rt, blockchain);
  if (isNaN(currentBlock) || currentBlock <= 0) {
    throw new Error(`Invalid current block number for ${blockchainLabel(blockchain)}`);
  }

  let low = 1;
  let high = currentBlock;
  let bestBlock = high;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const blockTimestamp = await getEvmBlockTimestamp(rt, blockchain, mid);

    if (isNaN(blockTimestamp)) {
      throw new Error(`Failed to get timestamp for block ${mid} on ${blockchainLabel(blockchain)}`);
    }

    if (blockTimestamp <= targetTimestamp) {
      bestBlock = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  rt.cache.set(key, bestBlock.toString());
  return bestBlock;
}

async function getEvmCurrentBlockNumber(rt: Runtime, blockchain: EvmBlockchain): Promise<number> {
  const response = await fetch(evmRpcUrl(rt, blockchain), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  if (!response.ok) {
    throw new Error(
      `Alchemy ${response.status} on ${blockchainLabel(blockchain)}: ${response.statusText || "request failed"}`,
    );
  }
  const data = await response.json();
  if (data.error) throw new Error(`Failed to get current block number: ${data.error.message}`);
  const result = parseInt(data.result, 16);
  if (isNaN(result)) throw new Error("Invalid block number response");
  return result;
}

async function getEvmBlockTimestamp(rt: Runtime, blockchain: EvmBlockchain, blockNumber: number): Promise<number> {
  const response = await fetch(evmRpcUrl(rt, blockchain), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: [`0x${blockNumber.toString(16)}`, false],
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Alchemy ${response.status} on ${blockchainLabel(blockchain)}: ${response.statusText || "request failed"}`,
    );
  }
  const data = await response.json();
  if (data.error) throw new Error(`Failed to get block timestamp: ${data.error.message}`);
  if (!data.result || !data.result.timestamp) throw new Error("Invalid block response");
  const result = parseInt(data.result.timestamp, 16);
  if (isNaN(result)) throw new Error("Invalid timestamp in block");
  return result;
}

// ---------- Bitcoin (Esplora) ----------

interface EsploraTxStatus {
  confirmed: boolean;
  block_height?: number;
  block_time?: number;
}

interface EsploraVin {
  prevout: { scriptpubkey_address?: string; value: number } | null;
}

interface EsploraVout {
  scriptpubkey_address?: string;
  value: number;
}

interface EsploraTx {
  txid: string;
  status: EsploraTxStatus;
  vin: EsploraVin[];
  vout: EsploraVout[];
}

interface EsploraChainStats {
  funded_txo_sum: number;
  spent_txo_sum: number;
  tx_count: number;
}

const ESPLORA_PAGE_SIZE = 25;
// Gap between two history pages. An unpaced walk through hundreds of pages
// runs into mempool.space's rate limit (HTTP 429); two requests per second
// stays below it while a 500-page history still finishes in a few minutes.
const ESPLORA_PAGE_DELAY_MS = 500;
// Retries for HTTP 429, 502/503/504 and network failures. All Esplora calls
// are idempotent GETs, so repeating one is safe. Without Retry-After the wait
// doubles from 5 s up to 120 s: 5+10+20+40+80+120 s ≈ 4.5 min in total
// before giving up.
const ESPLORA_MAX_RETRIES = 6;
const ESPLORA_BACKOFF_START_MS = 5_000;
const ESPLORA_BACKOFF_CAP_MS = 120_000;
// A Retry-After beyond this is not waited out (a browser tab would look
// frozen); the request fails with the provider's requested wait instead.
const ESPLORA_MAX_RETRY_AFTER_MS = 300_000;
const ESPLORA_PROGRESS_EVERY_PAGES = 20;
// How often the history is re-read when the address changes while paging.
const BTC_SNAPSHOT_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const PROVIDER_UNREACHABLE = "Bitcoin data provider unreachable. Check VITE_ESPLORA_URL or retry.";

function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

// GET an Esplora URL, retrying rate limits (429), gateway errors (502/503/504)
// and network failures with Retry-After or capped exponential backoff. Any
// other status is returned to the caller; exhausting the retries throws.
async function esploraFetch(rt: Runtime, url: string): Promise<Response> {
  for (let retry = 0; ; retry++) {
    let response: Response | undefined;
    try {
      response = await fetch(url);
    } catch (e) {
      // `fetch` rejects with TypeError for network-level failures: DNS, TLS,
      // CORS, the provider being down, an offline browser.
      if (!(e instanceof TypeError)) throw e;
    }
    const retryable = response === undefined || [429, 502, 503, 504].includes(response.status);
    if (!retryable) return response!;

    const reason = response === undefined ? "network error" : `HTTP ${response.status}`;
    if (retry >= ESPLORA_MAX_RETRIES) {
      if (response === undefined) throw new Error(PROVIDER_UNREACHABLE);
      throw new Error(
        response.status === 429
          ? `Bitcoin data provider is rate limiting requests (HTTP 429) and still did after ${ESPLORA_MAX_RETRIES} retries. Wait a few minutes and try again.`
          : `Bitcoin data provider failed with HTTP ${response.status} after ${ESPLORA_MAX_RETRIES} retries. Try again later.`,
      );
    }

    const requested = response === undefined ? undefined : retryAfterMs(response.headers.get("retry-after"));
    if (requested !== undefined && requested > ESPLORA_MAX_RETRY_AFTER_MS) {
      throw new Error(
        `Bitcoin data provider asks to wait ${Math.ceil(requested / 1000)} s (${reason}). Try again later.`,
      );
    }
    const waitMs =
      requested !== undefined
        ? requested
        : Math.min(ESPLORA_BACKOFF_START_MS * 2 ** retry, ESPLORA_BACKOFF_CAP_MS);
    rt.log(`Bitcoin data provider: ${reason}, retry ${retry + 1}/${ESPLORA_MAX_RETRIES} in ${Math.round(waitMs / 1000)} s`);
    await sleep(waitMs);
  }
}

// Address endpoints: a 400/404 means Esplora knows nothing about the address
// (its format is validated before), anything else non-OK is an error.
async function esploraAddressJson(rt: Runtime, url: string, walletAddress: string): Promise<unknown> {
  const res = await esploraFetch(rt, url);
  if (!res.ok) {
    if (res.status === 400 || res.status === 404) {
      throw new Error(`No on-chain activity found for ${walletAddress}. Double-check the address and try again.`);
    }
    throw new Error(`Esplora request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchChainStats(rt: Runtime, walletAddress: string): Promise<EsploraChainStats> {
  const data = (await esploraAddressJson(rt, `${rt.esploraBase}/address/${walletAddress}`, walletAddress)) as {
    chain_stats?: Partial<EsploraChainStats>;
  };
  const stats = data.chain_stats;
  if (
    !stats ||
    !Number.isSafeInteger(stats.funded_txo_sum) ||
    !Number.isSafeInteger(stats.spent_txo_sum) ||
    !Number.isSafeInteger(stats.tx_count)
  ) {
    throw new Error("Invalid Esplora address response");
  }
  return stats as EsploraChainStats;
}

const sameStats = (a: EsploraChainStats, b: EsploraChainStats) =>
  a.funded_txo_sum === b.funded_txo_sum && a.spent_txo_sum === b.spent_txo_sum && a.tx_count === b.tx_count;

// Net satoshi effect on the address of all confirmed TXs above targetHeight.
// Esplora lists confirmed TXs newest-first, so paging stops at the first TX
// at or below targetHeight instead of walking the whole history.
async function netSatsAfterHeight(rt: Runtime, walletAddress: string, targetHeight: number): Promise<number> {
  let net = 0;
  let pages = 0;
  let lastSeenTxid: string | undefined;
  let previousHeight = Number.POSITIVE_INFINITY;
  const finish = () => {
    if (pages >= ESPLORA_PROGRESS_EVERY_PAGES) rt.log(`Bitcoin history: done after ${pages} pages`);
    return net;
  };

  while (true) {
    if (pages > 0) await sleep(ESPLORA_PAGE_DELAY_MS);
    const url = lastSeenTxid
      ? `${rt.esploraBase}/address/${walletAddress}/txs/chain/${lastSeenTxid}`
      : `${rt.esploraBase}/address/${walletAddress}/txs/chain`;
    const page = (await esploraAddressJson(rt, url, walletAddress)) as EsploraTx[];
    if (!Array.isArray(page)) throw new Error("Invalid Esplora transaction list response");
    pages++;
    if (pages % ESPLORA_PROGRESS_EVERY_PAGES === 0) {
      rt.log(`Bitcoin history: ${pages} pages (${pages * ESPLORA_PAGE_SIZE} transactions) read`);
    }

    for (const tx of page) {
      const height = tx.status.block_height;
      if (!tx.status.confirmed || height === undefined) {
        throw new Error("Esplora returned an unconfirmed transaction in the confirmed history");
      }
      // The early stop below is only correct for newest-first order; refuse
      // to compute anything if the provider ever returns another order.
      if (height > previousHeight) {
        throw new Error("Esplora transaction history is not ordered newest-first");
      }
      previousHeight = height;
      if (height <= targetHeight) return finish();

      for (const out of tx.vout) {
        if (out.scriptpubkey_address === walletAddress) net += out.value;
      }
      for (const inp of tx.vin) {
        if (inp.prevout?.scriptpubkey_address === walletAddress) net -= inp.prevout.value;
      }
    }

    if (page.length < ESPLORA_PAGE_SIZE) return finish();
    lastSeenTxid = page[page.length - 1].txid;
  }
}

async function fetchBitcoinBalance(
  rt: Runtime,
  walletAddress: string,
  targetTimestamp: number,
): Promise<BalanceAtBlock> {
  if (!isValidBtcAddress(walletAddress, BtcNetwork.mainnet)) {
    throw new Error("Invalid Bitcoin address");
  }

  const targetHeight = await findBtcBlockByTimestamp(rt, targetTimestamp);

  // Balance at targetHeight = today's confirmed balance (chain_stats: sum of
  // all confirmed outputs to the address minus all confirmed spends of them)
  // minus the net effect of every confirmed TX above targetHeight. That only
  // needs the TXs after the snapshot, not the whole history.
  //
  // Both terms must describe the same set of confirmed TXs. The totals are
  // read before and after paging; if they are identical, no TX for the
  // address was confirmed in between, so the pages saw exactly the TXs the
  // totals include. If they differ, the whole read is repeated. Any failed
  // request throws — a partially read history never yields a number.
  for (let attempt = 1; attempt <= BTC_SNAPSHOT_ATTEMPTS; attempt++) {
    const before = await fetchChainStats(rt, walletAddress);
    const netAfter = await netSatsAfterHeight(rt, walletAddress, targetHeight);
    const after = await fetchChainStats(rt, walletAddress);
    if (!sameStats(before, after)) {
      rt.log("Bitcoin address received new transactions while reading its history, reading again");
      continue;
    }

    const satsBalance = before.funded_txo_sum - before.spent_txo_sum - netAfter;
    if (satsBalance < 0) {
      throw new Error("Computed negative Bitcoin balance — chain data inconsistent");
    }
    const btc = satsBalance / 10 ** BTC_DECIMALS;
    return { balance: formatTokenAmount(btc.toFixed(BTC_DECIMALS)), blockNumber: targetHeight };
  }
  throw new Error("Bitcoin address kept receiving new transactions while its history was read. Try again.");
}

// Bitcoin genesis block timestamp (2009-01-03 18:15:05 UTC). Any earlier
// timestamp can't resolve to a real block; Esplora answers with a 500 and
// the raw status code leaked into the UI before this client-side check.
const BTC_GENESIS_TIMESTAMP = 1230940800;

async function findBtcBlockByTimestamp(rt: Runtime, targetTimestamp: number): Promise<number> {
  if (targetTimestamp < BTC_GENESIS_TIMESTAMP) {
    throw new Error("Date is before Bitcoin existed");
  }

  const key = cacheKey(["block", NonEvmBlockchain.BTC, targetTimestamp]);
  const cached = rt.cache.get(key);
  if (cached) {
    const parsed = parseInt(cached, 10);
    if (!isNaN(parsed)) return parsed;
  }

  // mempool.space answers with the block whose timestamp is the latest one
  // at or before targetTimestamp (`WHERE blockTimestamp <= ? ORDER BY
  // blockTimestamp DESC LIMIT 1`), so both the 00:00:00 and the 23:59:59
  // snapshot resolve to the last block at or before that instant.
  const res = await esploraFetch(rt, `${rt.esploraBase}/v1/mining/blocks/timestamp/${targetTimestamp}`);
  if (!res.ok) throw new Error(`Failed to resolve Bitcoin block for timestamp: ${res.status}`);
  const data = await res.json();
  if (typeof data.height !== "number") throw new Error("Invalid Esplora timestamp response");

  rt.cache.set(key, data.height.toString());
  return data.height;
}
