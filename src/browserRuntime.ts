import { esploraBaseFrom, type Runtime } from "./core/runtime";

// Browser host for the shared report logic: Vite build-time env and
// localStorage. Only the React app imports this module — the headless CLI has
// its own runtime, so no import.meta.env value is ever baked into the CLI
// bundle.
const apiKey = import.meta.env.VITE_ALCHEMY_API_KEY || "YOUR_ALCHEMY_API_KEY";

export const browserRuntime: Runtime = {
  getAlchemyApiKey: () => apiKey,
  esploraBase: esploraBaseFrom(import.meta.env.VITE_ESPLORA_URL),
  cache: {
    get: (key) => localStorage.getItem(key),
    set: (key, value) => localStorage.setItem(key, value),
  },
  fetchCoinGecko: (url) => fetch(url),
};
