import { config, activeNetwork } from "../config.js";
import { store } from "../store.js";
import { whiteLabel } from "../white-label.js";
import { FDC_XRP_PAYMENT_LUT_LIMIT_SECONDS, FDC_XRP_PAYMENT_LUT_LIMIT_DAYS } from "../xrpl-tx.js";
import { NETWORK_STATUS_URI } from "../attestation-view.js";
import { getMcpContext } from "./context.js";

interface ResourceTemplate {
  uri: string;
  name: string;
  description: string;
  handler(): string | Promise<string>;
}

const templates: ResourceTemplate[] = [
  {
    uri: "xrplink://docs/overview",
    name: "Project Overview",
    description: "XRPLink project description, purpose, and version information",
    handler: () =>
      `# XRPLink — XRP Payment Attestation on Flare FDC\n\nXRPLink wraps Flare's enshrined FDC protocol into a simple API + MCP server, letting developers and AI agents verify XRP payments on Flare without managing attestation rounds, Merkle proofs, or DA Layer interactions.\n\n## Version: 0.3.0 (agent-native)\n## Network: ${config.network}\n## Status: Operational\n\nTo get started, call verify_xrp_payment with an XRP transaction hash.`,
  },
  {
    uri: "xrplink://docs/config",
    name: "Configuration Reference",
    description: "Environment variables, their purposes, and how to configure XRPLink",
    handler: () =>
      `# XRPLink Configuration\n\n## Environment Variables\n\n| Variable | Description | Default |\n|----------|-------------|---------|\n| FLARE_NETWORK | Network: coston2 or flare | coston2 |\n| PRIVATE_KEY | Wallet private key | (required) |\n| VERIFIER_API_KEY | Flare verifier API key | 00000000-... |\n| PAYMENT_VERIFIER_ADDRESS | PaymentVerifier contract | (optional) |\n| PORT | HTTP API port | 3000 |\n| MCP_SSE_PORT | MCP SSE transport port | 3001 |\n| MAX_POLL_ATTEMPTS | DA Layer poll count | 6 |\n| POLL_INTERVAL_MS | Milliseconds between polls | 30000 |\n\n## Current Network: ${config.network}\n## Source ID: ${activeNetwork.sourceId}\n## Chain ID: ${activeNetwork.chainId}\n## FdcHub: ${activeNetwork.fdcHub}\n## PaymentVerifier: ${config.paymentVerifierAddress || "not configured"}`,
  },
  {
    uri: "xrplink://docs/network",
    name: "Network Information",
    description: "Current Flare network details, contract addresses, and RPC endpoints",
    handler: () =>
      `# Network: ${config.network}\n\n| Parameter | Value |\n|-----------|-------|\n| RPC | ${activeNetwork.rpc} |\n| Chain ID | ${activeNetwork.chainId} |\n| FdcHub | ${activeNetwork.fdcHub} |\n| Source ID | ${activeNetwork.sourceId} |\n| First Voting Round | ${activeNetwork.firstVotingRoundStart} |\n| DA Layer | ${activeNetwork.daLayerUrl} |\n| Verifier API | ${activeNetwork.verifierBaseUrl} |\n| XRPPayment lookback | ${FDC_XRP_PAYMENT_LUT_LIMIT_DAYS} days (${FDC_XRP_PAYMENT_LUT_LIMIT_SECONDS} seconds, IXRPPayment lutlimit 0x127500) |\n| PaymentVerifier | ${config.paymentVerifierAddress || "not deployed"} |\n\nFlare FDC XRPPayment can only prove native XRP Payments whose ledger close time is within this lookback window. Older hashes exist on XRPL but the hosted verifier returns INVALID: TRANSACTION DOES NOT EXIST.\n\n## Brand: ${whiteLabel.get().brandName}\n## Company: ${whiteLabel.get().companyUrl}`,
  },
  {
    uri: "xrplink://docs/tools",
    name: "Tool Usage Guide",
    description: "How to use each MCP tool with examples and common workflows",
    handler: () =>
      `# XRPLink MCP Tools\n\n## verify_xrp_payment\nSubmit an XRP transaction hash for FDC attestation.\n\`\`\`\nInput:  { "txHash": "388076B7245A60A13D6A764C8D0B5919F8A77E04E720C32CA1E30E9B7A291F22" }\nOutput: { "id": "uuid", "txHash": "...", "roundId": 1234, "status": "pending" }\n\`\`\`\nWait ~90s then call get_attestation_status.\n\n## get_attestation_status\nCheck attestation status by UUID.\n\n## lookup_attestation_by_tx\nFind attestation by XRP txHash.\n\n## get_server_info\nGet server, network, and branding info.\n\n## Workflow\n1. Call verify_xrp_payment with txHash\n2. Wait ~90s\n3. Call get_attestation_status with returned ID\n4. "verified" means confirmed on-chain`,
  },
  {
    uri: NETWORK_STATUS_URI,
    name: "Live Network Status",
    description: "Real-time server health, wallet balance, and network status",
    handler: async () => {
      const { ethers } = await import("ethers");
      const provider = new ethers.providers.JsonRpcProvider(activeNetwork.rpc);
      let balance = "unknown";
      let blockNumber = "unknown";
      try {
        if (config.privateKey) {
          const wallet = new ethers.Wallet(config.privateKey, provider);
          balance = ethers.utils.formatEther(await provider.getBalance(wallet.address));
        }
        blockNumber = (await provider.getBlockNumber()).toString();
      } catch {}
      const attestations = await store.listAttestations();
      const apiKeys = await store.listApiKeys();
      return [
        "# Network Status",
        "",
        "| Metric | Value |",
        "|--------|-------|",
        `| Status | online |`,
        `| Network | ${config.network} |`,
        `| Block | ${blockNumber} |`,
        `| Wallet Balance | ${balance} FLR |`,
        `| Attestations | ${attestations.length} |`,
        `| API Keys | ${apiKeys.length} |`,
        `| Brand | ${whiteLabel.get().brandName} |`,
        `| Uptime | ${Math.floor(process.uptime())}s |`,
      ].join("\n");
    },
  },
];

export function getResources(opts?: { includePrivate?: boolean }) {
  const ctx = getMcpContext();
  const includePrivate = opts?.includePrivate ?? (!ctx.http || Boolean(ctx.apiKeyRecord));
  return templates
    .filter((t) => includePrivate || t.uri !== NETWORK_STATUS_URI)
    .map((t) => ({
      uri: t.uri,
      name: t.name,
      description: t.description,
      mimeType: "text/markdown" as const,
    }));
}

export async function readResource(uri: string): Promise<string | null> {
  const ctx = getMcpContext();
  if (uri === NETWORK_STATUS_URI && ctx.http && !ctx.apiKeyRecord) {
    return null;
  }
  const t = templates.find((x) => x.uri === uri);
  return t ? t.handler() : null;
}

export function resourceUris(): string[] {
  return templates.map((t) => t.uri);
}
