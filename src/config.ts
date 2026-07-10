import "dotenv/config";

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  rpc: process.env.RPC_URL || "https://coston2-api.flare.network/ext/C/rpc",
  fdcHub: process.env.FDC_HUB || "0x48aC463d7975828989331F4De43341627b9c5f1D",
  verifierApiKey: process.env.VERIFIER_API_KEY || "00000000-0000-0000-0000-000000000000",
  verifierBaseUrl: process.env.VERIFIER_BASE_URL || "https://fdc-verifiers-testnet.flare.network",
  daLayerUrl: process.env.DA_LAYER_URL || "https://ctn2-data-availability.flare.network",
  paymentVerifierAddress: process.env.PAYMENT_VERIFIER_ADDRESS || "",
  privateKey: process.env.PRIVATE_KEY || "",
  firstVotingRoundStart: parseInt(process.env.FIRST_VOTING_ROUND_START || "1658430000", 10),
  votingEpochDuration: parseInt(process.env.VOTING_EPOCH_DURATION || "90", 10),
  submitFeeFlr: process.env.SUBMIT_FEE_FLR || "1",
  maxPollAttempts: parseInt(process.env.MAX_POLL_ATTEMPTS || "6", 10),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "30000", 10),
};
