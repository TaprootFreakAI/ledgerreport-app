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

  // Price errors are a normal outcome (not published yet, token unknown to
  // CoinGecko, outside its 365-day window). The form clears them on change
  // so the user can retry: reset() for fields that invalidate the price,
  // clearError() for the currency toggle, which keeps the fetched prices.
  const reset = useCallback(() => setResult({ prices: null, loading: false, error: null }), []);
  const clearError = useCallback(() => setResult((current) => ({ ...current, error: null })), []);

  return {
    ...result,
    fetchPrice,
    reset,
    clearError,
  };
};
