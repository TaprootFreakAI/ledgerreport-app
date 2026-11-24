import { useState, useCallback } from "react";
import { fetchCurrencyPrice, type FetchPriceParams, type PriceQuote } from "../core/price";
import { browserRuntime } from "../browserRuntime";

interface CurrencyPriceResult {
  prices: PriceQuote | null;
  loading: boolean;
  error: string | null;
}

// Thin React wrapper around src/core/price.ts (shared with the headless CLI):
// tracks loading/error state for the form.
export const useCurrencyPrice = () => {
  const [result, setResult] = useState<CurrencyPriceResult>({
    prices: null,
    loading: false,
    error: null,
  });

  const fetchPrice = useCallback(async (params: FetchPriceParams) => {
    setResult({ prices: null, loading: true, error: null });

    try {
      const prices = await fetchCurrencyPrice(browserRuntime, params);
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
