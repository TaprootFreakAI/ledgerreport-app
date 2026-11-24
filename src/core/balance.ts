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
  [EvmBlockchain.BSC]: "bsc-mainnet",
  [EvmBlockchain.ARB]: "arb-mainnet",
  [EvmBlockchain.OPT]: "opt-mainnet",
  [EvmBlockchain.BASE]: "base-mainnet",
  [EvmBlockchain.HAQQ]: "haqq-mainnet",
  [EvmBlockchain.GNOSIS]: "gnosis-mainnet",
};

function evmRpcUrl(rt: Runtime, blockchain: EvmBlockchain): string {
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

async function fetchBitcoinBalance(
  rt: Runtime,
  walletAddress: string,
  targetTimestamp: number,
): Promise<BalanceAtBlock> {
  if (!isValidBtcAddress(walletAddress, BtcNetwork.mainnet)) {
    throw new Error("Invalid Bitcoin address");
  }

  const targetHeight = await findBtcBlockByTimestamp(rt, targetTimestamp);

  let satsBalance = 0;
  let lastSeenTxid: string | undefined;

  // Esplora returns confirmed TXs newest-first, 25 per page. We page until we've seen
  // every TX confirmed at or before targetHeight, then stop. TXs newer than targetHeight
  // are skipped (not yet existed at the snapshot date).
  while (true) {
    const url = lastSeenTxid
      ? `${rt.esploraBase}/address/${walletAddress}/txs/chain/${lastSeenTxid}`
      : `${rt.esploraBase}/address/${walletAddress}/txs/chain`;

    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      // `fetch` rejects with TypeError for network-level failures: DNS,
      // TLS, CORS preflight, the provider being down, an offline browser.
      // The default "TypeError: Failed to fetch" tells the user nothing
      // actionable. Translate it once at the boundary and re-throw so the
      // existing error path (setResult({error}) + re-throw to the form
      // handler) still runs unchanged.
      if (e instanceof TypeError) {
        throw new Error(
          `Bitcoin data provider unreachable. Check VITE_ESPLORA_URL or retry.`,
        );
      }
      throw e;
    }
    if (!res.ok) {
      if (res.status === 400 || res.status === 404) {
        // Address format is already validated above (isValidBtcAddress), so a
        // 400/404 here means Esplora has no record of any on-chain activity.
        throw new Error(
          `No on-chain activity found for ${walletAddress}. Double-check the address and try again.`,
        );
      }
      throw new Error(`Esplora request failed: ${res.status} ${res.statusText}`);
    }
    const page: EsploraTx[] = await res.json();
    if (page.length === 0) break;

    for (const tx of page) {
      if (!tx.status.confirmed || tx.status.block_height === undefined) continue;
      if (tx.status.block_height > targetHeight) continue;

      for (const out of tx.vout) {
        if (out.scriptpubkey_address === walletAddress) satsBalance += out.value;
      }
      for (const inp of tx.vin) {
        if (inp.prevout?.scriptpubkey_address === walletAddress) satsBalance -= inp.prevout.value;
      }
    }

    if (page.length < 25) break;
    lastSeenTxid = page[page.length - 1].txid;
  }

  if (satsBalance < 0) {
    throw new Error("Computed negative Bitcoin balance — chain data inconsistent");
  }

  const btc = satsBalance / 10 ** BTC_DECIMALS;
  return { balance: formatTokenAmount(btc.toFixed(BTC_DECIMALS)), blockNumber: targetHeight };
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
  let res: Response;
  try {
    res = await fetch(`${rt.esploraBase}/v1/mining/blocks/timestamp/${targetTimestamp}`);
  } catch (e) {
    // Same network-level translation as the address-paging fetch above:
    // surface an actionable message instead of "Failed to fetch".
    if (e instanceof TypeError) {
      throw new Error(
        `Bitcoin data provider unreachable. Check VITE_ESPLORA_URL or retry.`,
      );
    }
    throw e;
  }
  if (!res.ok) throw new Error(`Failed to resolve Bitcoin block for timestamp: ${res.status}`);
  const data = await res.json();
  if (typeof data.height !== "number") throw new Error("Invalid Esplora timestamp response");

  rt.cache.set(key, data.height.toString());
  return data.height;
}
