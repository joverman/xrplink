import "dotenv/config";

export type Network = "coston2" | "flare";

export interface NetworkConfig {
  rpc: string;
  chainId: number;
  fdcHub: string;
  daLayerUrl: string;
  verifierBaseUrl: string;
  firstVotingRoundStart: number;
  sourceId: string;
}

const network: Network = (process.env.FLARE_NETWORK as Network) || "coston2";

const networks: Record<Network, NetworkConfig> = {
  coston2: {
    rpc: "https://coston2-api.flare.network/ext/C/rpc",
    chainId: 114,
    fdcHub: "0x48aC463d7975828989331F4De43341627b9c5f1D",
    daLayerUrl: "https://ctn2-data-availability.flare.network",
    verifierBaseUrl: "https://fdc-verifiers-testnet.flare.network",
    firstVotingRoundStart: 1658430000,
    sourceId: "testXRP",
  },
  flare: {
    rpc: "https://flare-api.flare.network/ext/C/rpc",
    chainId: 14,
    fdcHub: "0x1000000000000000000000000000000000000004",
    daLayerUrl: "https://data-availability.flare.network",
    verifierBaseUrl: "https://fdc-verifiers.flare.network",
    firstVotingRoundStart: 1668510000,
    sourceId: "XRP",
  },
};

export const activeNetwork = networks[network];

const resolvedKey = network === "flare"
  ? (process.env.PRIVATE_KEY_FLARE || "")
  : (process.env.PRIVATE_KEY_COSTON2 || "");

const resolvedVerifier = network === "flare"
  ? (process.env.PAYMENT_VERIFIER_ADDRESS_FLARE || "")
  : (process.env.PAYMENT_VERIFIER_ADDRESS_COSTON2 || "");

// Backward compat: scripts that read process.env.PRIVATE_KEY directly still work
process.env.PRIVATE_KEY = resolvedKey || process.env.PRIVATE_KEY;
process.env.PAYMENT_VERIFIER_ADDRESS = resolvedVerifier || process.env.PAYMENT_VERIFIER_ADDRESS;

export const config = {
  network,
  port: parseInt(process.env.PORT || "3000", 10),
  mcpSsePort: parseInt(process.env.MCP_SSE_PORT || "3001", 10),
  privateKey: resolvedKey,
  verifierApiKey: process.env.VERIFIER_API_KEY || "00000000-0000-0000-0000-000000000000",
  paymentVerifierAddress: resolvedVerifier,
  submitFeeFlr: process.env.SUBMIT_FEE_FLR || "1",
  maxPollAttempts: parseInt(process.env.MAX_POLL_ATTEMPTS || "6", 10),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "30000", 10),
  rateLimits: { free: 10, paid: 100, pro: Infinity },
};
