import { config, activeNetwork } from "../config.js";
import { whiteLabel } from "../white-label.js";
import { formatPublicStatusMarkdown, getPublicStatus } from "../status.js";

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
    description: "Public network and contract settings agents need to call XRPLink",
    handler: () =>
      `# XRPLink Configuration\n\nAgents authenticate with an API key or x402 payment. Operator environment variables are not part of the public API.\n\n## Current Network: ${config.network}\n## Source ID: ${activeNetwork.sourceId}\n## Chain ID: ${activeNetwork.chainId}\n## FdcHub: ${activeNetwork.fdcHub}\n## PaymentVerifier: ${config.paymentVerifierAddress || "not configured"}`,
  },
  {
    uri: "xrplink://docs/network",
    name: "Network Information",
    description: "Current Flare network details and public contract addresses",
    handler: () =>
      `# Network: ${config.network}\n\n| Parameter | Value |\n|-----------|-------|\n| Chain ID | ${activeNetwork.chainId} |\n| Source ID | ${activeNetwork.sourceId} |\n| FdcHub | ${activeNetwork.fdcHub} |\n| PaymentVerifier | ${config.paymentVerifierAddress || "not configured"} |\n\n## Brand: ${whiteLabel.get().brandName}`,
  },
  {
    uri: "xrplink://docs/tools",
    name: "Tool Usage Guide",
    description: "How to use each MCP tool with examples and common workflows",
    handler: () =>
      `# XRPLink MCP Tools\n\n## verify_xrp_payment\nSubmit an XRP transaction hash for FDC attestation.\n\`\`\`\nInput:  { "txHash": "388076B7245A60A13D6A764C8D0B5919F8A77E04E720C32CA1E30E9B7A291F22" }\nOutput: { "id": "uuid", "txHash": "...", "roundId": 1234, "status": "pending" }\n\`\`\`\nWait ~90s then call get_attestation_status.\n\n## get_attestation_status\nCheck attestation status by UUID.\n\n## lookup_attestation_by_tx\nFind attestation by XRP txHash.\n\n## get_server_info\nGet public server, network, and branding info.\n\n## Workflow\n1. Call verify_xrp_payment with txHash\n2. Wait ~90s\n3. Call get_attestation_status with returned ID\n4. "verified" means confirmed on-chain`,
  },
  {
    uri: "xrplink://network/status",
    name: "Live Network Status",
    description: "Public server status: online/degraded, network, chain id, brand, and whether attestations are available",
    handler: async () => formatPublicStatusMarkdown(await getPublicStatus()),
  },
];

export function getResources() {
  return templates.map((t) => ({
    uri: t.uri,
    name: t.name,
    description: t.description,
    mimeType: "text/markdown" as const,
  }));
}

export async function readResource(uri: string): Promise<string | null> {
  const t = templates.find((x) => x.uri === uri);
  return t ? t.handler() : null;
}

export function resourceUris(): string[] {
  return templates.map((t) => t.uri);
}
