import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { config, activeNetwork } from "./config.js";
import { store } from "./store.js";
import * as fdc from "./fdc-service.js";
import { whiteLabel } from "./white-label.js";

// --- Tool Definitions ---

const tools: Tool[] = [
  {
    name: "verify_xrp_payment",
    description: "Submit an XRP transaction hash for FDC attestation verification on the Flare network",
    inputSchema: {
      type: "object",
      properties: {
        txHash: {
          type: "string",
          description: "XRP transaction hash (64 hex characters, with or without 0x prefix)",
        },
      },
      required: ["txHash"],
    },
  },
  {
    name: "get_attestation_status",
    description: "Get the current status of an attestation by its ID",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Attestation UUID returned from verify_xrp_payment",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "lookup_attestation_by_tx",
    description: "Look up an attestation by its XRP transaction hash",
    inputSchema: {
      type: "object",
      properties: {
        txHash: {
          type: "string",
          description: "XRP transaction hash (64 hex characters)",
        },
      },
      required: ["txHash"],
    },
  },
  {
    name: "get_server_info",
    description: "Get XRPLink server information, network details, and white-label branding",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// --- Server Setup ---

const server = new Server(
  { name: "xrplink-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "verify_xrp_payment": {
        const txHash: string = (args as any).txHash;
        const cleanHash = txHash.replace(/^0x/i, "").toUpperCase();

        if (!/^[0-9A-F]{64}$/.test(cleanHash)) {
          return toolError("Invalid txHash format (expected 64 hex characters)");
        }

        // Check cache / already verified
        const cached = store.getByTxHash(cleanHash);
        if (cached) {
          return toolResult(`Attestation already ${cached.status}`, {
            id: cached.id,
            txHash: cleanHash,
            roundId: cached.roundId,
            status: cached.status,
            verifiedTxHash: cached.verifiedTxHash,
            cached: true,
          });
        }

        if (config.paymentVerifierAddress) {
          try {
            const alreadyVerified = await fdc.isAlreadyVerified(cleanHash);
            if (alreadyVerified) {
              const record = store.createAttestation(cleanHash);
              store.updateAttestation(record.id, { status: "verified" });
              return toolResult("Transaction already verified on-chain", {
                id: record.id, txHash: cleanHash, status: "verified",
              });
            }
          } catch {}
        }

        // Submit new attestation
        const attestation = store.createAttestation(cleanHash);
        const proofOwner = fdc.getProofOwner();
        const abiEncoded = await fdc.prepareRequest(cleanHash, proofOwner);
        store.updateAttestation(attestation.id, { abiEncodedRequest: abiEncoded });

        const { roundId, txHash: submitTxHash } = await fdc.submitRequest(abiEncoded);
        store.updateAttestation(attestation.id, { roundId, status: "pending" });

        // Start background polling
        pollForProof(attestation.id, roundId, abiEncoded).catch((err) => {
          console.error(`MCP poll failed for ${attestation.id}:`, err.message);
        });

        return toolResult("Attestation submitted to FdcHub", {
          id: attestation.id,
          txHash: cleanHash,
          roundId,
          status: "pending",
          submitTxHash,
          message: `Submitted to voting round ${roundId}. Check back in ~90s for the proof.`,
        });
      }

      case "get_attestation_status": {
        const id: string = (args as any).id;
        const attestation = store.getAttestation(id);
        if (!attestation) {
          return toolError(`Attestation not found: ${id}`);
        }
        return toolResult("Attestation found", attestation);
      }

      case "lookup_attestation_by_tx": {
        const txHash: string = (args as any).txHash;
        const cleanHash = txHash.replace(/^0x/i, "").toUpperCase();
        const attestation = store.getByTxHash(cleanHash);
        if (!attestation) {
          return toolError(`No attestation found for txHash: ${cleanHash}`);
        }
        return toolResult("Attestation found", attestation);
      }

      case "get_server_info": {
        const wl = whiteLabel.get();
        return toolResult("XRPLink server info", {
          brand: wl.brandName,
          network: config.network,
          sourceId: activeNetwork.sourceId,
          rpc: activeNetwork.rpc,
          paymentVerifier: config.paymentVerifierAddress || "not configured",
          chainId: activeNetwork.chainId,
          fdcHub: activeNetwork.fdcHub,
          companyUrl: wl.companyUrl,
          uptime: process.uptime(),
        });
      }

      default:
        return toolError(`Unknown tool: ${name}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`MCP tool error (${name}):`, message);
    return toolError(message);
  }
});

// --- Background polling (same as routes.ts) ---

async function pollForProof(id: string, roundId: number, abiEncoded: string, attempt = 1) {
  await new Promise((r) => setTimeout(r, config.pollIntervalMs));

  try {
    const proofData = await fdc.fetchProof(roundId, abiEncoded);
    if (!proofData) {
      if (attempt < config.maxPollAttempts) return pollForProof(id, roundId, abiEncoded, attempt + 1);
      store.updateAttestation(id, { status: "not_found", error: "Proof not found after max poll attempts" });
      return;
    }
    store.updateAttestation(id, { proof: proofData, status: "ready" });

    if (config.paymentVerifierAddress) {
      const verifiedTxHash = await fdc.verifyProofOnChain(proofData, config.paymentVerifierAddress);
      store.updateAttestation(id, { verifiedTxHash, status: "verified" });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempt < config.maxPollAttempts) return pollForProof(id, roundId, abiEncoded, attempt + 1);
    store.updateAttestation(id, { status: "failed", error: message });
  }
}

// --- Helpers ---

function toolResult(text: string, data: Record<string, unknown>) {
  return {
    content: [
      { type: "text" as const, text: `${text}\n\n${JSON.stringify(data, null, 2)}` },
    ],
  };
}

function toolError(text: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  };
}

// --- Start ---

async function main() {
  if (!config.privateKey) {
    console.error("PRIVATE_KEY not set in .env");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const wl = whiteLabel.get();
  console.error(`${wl.brandName} MCP server running`);
  console.error(`  Network: ${config.network} (${activeNetwork.sourceId})`);
  console.error(`  PaymentVerifier: ${config.paymentVerifierAddress || "not configured"}`);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
