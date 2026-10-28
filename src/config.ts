import "dotenv/config";

export type Network = "coston2" | "flare";

export interface NetworkConfig {
  rpc: string;
  chainId: number;
  fdcHub: string;
  /** Enshrined FDC verification contract (verifyXRPPayment). */
  fdcVerification: string;
  daLayerUrl: string;
  verifierBaseUrl: string;
  firstVotingRoundStart: number;
  sourceId: string;
}

const network: Network = (process.env.FLARE_NETWORK as Network) || "coston2";

export const networkConfigs: Record<Network, NetworkConfig> = {
  coston2: {
    rpc: "https://coston2-api.flare.network/ext/C/rpc",
    chainId: 114,
    fdcHub: "0x48aC463d7975828989331F4De43341627b9c5f1D",
    fdcVerification: "0x906507E0B64bcD494Db73bd0459d1C667e14B933",
    daLayerUrl: "https://ctn2-data-availability.flare.network",
    verifierBaseUrl: "https://fdc-verifiers-testnet.flare.network",
    firstVotingRoundStart: 1658430000,
    sourceId: "testXRP",
  },
  flare: {
    rpc: "https://flare-api.flare.network/ext/C/rpc",
    chainId: 14,
    fdcHub: "0xc25c749DC27Efb1864Cb3DADa8845B7687eB2d44",
    fdcVerification: "0x9394c7A36b3Da8de1b4F27cdD0a554dA4Fa7132d",
    daLayerUrl: "https://flr-data-availability.flare.network",
    verifierBaseUrl: "https://fdc-verifiers-mainnet.flare.network",
    firstVotingRoundStart: 1658430000,
    sourceId: "XRP",
  },
};

export const activeNetwork = networkConfigs[network];

const resolvedKey = network === "flare"
  ? (process.env.PRIVATE_KEY_FLARE || "")
  : (process.env.PRIVATE_KEY_COSTON2 || "");

const resolvedVerifier = network === "flare"
  ? (process.env.PAYMENT_VERIFIER_ADDRESS_FLARE || "")
  : (process.env.PAYMENT_VERIFIER_ADDRESS_COSTON2 || "");

// Backward compat: scripts that read process.env.PRIVATE_KEY directly still work
// Only set if we have a real value - never write undefined/empty to process.env
if (resolvedKey) {
  process.env.PRIVATE_KEY = resolvedKey;
} else if (process.env.PRIVATE_KEY) {
  // Keep existing value
}

if (resolvedVerifier) {
  process.env.PAYMENT_VERIFIER_ADDRESS = resolvedVerifier;
} else if (process.env.PAYMENT_VERIFIER_ADDRESS) {
  // Keep existing value
}

export const config = {
  network,
  port: parseInt(process.env.PORT || "3000", 10),
  mcpSsePort: parseInt(process.env.MCP_SSE_PORT || "3001", 10),
  privateKey: resolvedKey,
  verifierApiKey: process.env.VERIFIER_API_KEY || "00000000-0000-0000-0000-000000000000",
  paymentVerifierAddress: resolvedVerifier,
  submitFeeFlr: process.env.SUBMIT_FEE_FLR || (network === "flare" ? "20" : "1"),
  maxPollAttempts: parseInt(process.env.MAX_POLL_ATTEMPTS || "6", 10),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "30000", 10),
  rateLimits: { free: 10, paid: 100, pro: Infinity },
};
