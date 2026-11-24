import { useState, useCallback } from "react";
import type { Blockchain } from "../types";
import { fetchCurrencyPrice, type PriceData } from "../core/price";
import { browserRuntime } from "../browserRuntime";

interface CurrencyPriceResult {
  prices: PriceData | null;
  loading: boolean;
  error: string | null;
}

interface FetchPriceParams {
  contractAddress?: string;
  isNativeCoin: boolean;
  blockchain: Blockchain;
  date: string;
}

// Thin React wrapper around src/core/price.ts (shared with the headless CLI):
// tracks loading/error state for the form. The browser keeps the existing
// price fallbacks (historicalOnly: false).
export const useCurrencyPrice = () => {
  const [result, setResult] = useState<CurrencyPriceResult>({
    prices: null,
    loading: false,
    error: null,
  });

  const fetchPrice = useCallback(async ({ contractAddress, isNativeCoin, blockchain, date }: FetchPriceParams) => {
    setResult({ prices: null, loading: true, error: null });

    try {
      const prices = await fetchCurrencyPrice(browserRuntime, {
        contractAddress,
        isNativeCoin,
        blockchain,
        date,
        historicalOnly: false,
      });
      setResult({ prices, loading: false, error: null });
      return prices;
    } catch (error: unknown) {
      setResult({
        prices: null,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }, []);

  return {
    ...result,
    fetchPrice,
  };
};
