import { useState, useCallback } from "react";
import type { Snapshot, SupportedAsset } from "../types";
import { fetchWalletBalance } from "../core/balance";
import { browserRuntime } from "../browserRuntime";

interface BalanceResult {
  balance: string | null;
  loading: boolean;
  error: string | null;
}

interface FetchBalanceParams {
  asset: SupportedAsset;
  walletAddress: string;
  timestamp: string;
  snapshot: Snapshot;
}

// Thin React wrapper around src/core/balance.ts (shared with the headless
// CLI): tracks loading/error state for the form.
export const useWalletBalance = () => {
  const [result, setResult] = useState<BalanceResult>({
    balance: null,
    loading: false,
    error: null,
  });

  const reset = useCallback(
    () => setResult({ balance: null, loading: false, error: null }),
    [],
  );

  const fetchBalance = useCallback(async ({ asset, walletAddress, timestamp, snapshot }: FetchBalanceParams) => {
    setResult({ balance: null, loading: true, error: null });

    try {
      const { balance } = await fetchWalletBalance(browserRuntime, {
        asset,
        walletAddress,
        date: timestamp,
        snapshot,
      });
      setResult({ balance, loading: false, error: null });
    } catch (error: unknown) {
      setResult({
        balance: null,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
      // Re-throw so the form submit handler short-circuits — there's no point
      // continuing to a price fetch when the balance lookup already failed.
      // Mirrors useCurrencyPrice.fetchPrice, which also re-throws after
      // recording the error in local state.
      throw error;
    }
  }, []);

  return {
    ...result,
    fetchBalance,
    reset,
  };
};
