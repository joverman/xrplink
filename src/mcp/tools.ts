import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { config, activeNetwork } from "../config.js";
import { store } from "../store.js";
import * as fdc from "../fdc-service.js";
import { whiteLabel } from "../white-label.js";
import { formatError } from "./errors.js";

export const tools: Tool[] = [
  {
    name: "verify_xrp_payment",
    description: "Submit an XRP transaction hash for FDC attestation verification on the Flare network. Returns immediately with an attestation ID; actual verification takes ~90-180 seconds. Use get_attestation_status to check the result.",
    inputSchema: {
      type: "object",
      properties: {
        txHash: {
          type: "string",
          description: "XRP transaction hash (64 hex characters, with or without 0x prefix). Example: 388076B7245A60A13D6A764C8D0B5919F8A77E04E720C32CA1E30E9B7A291F22",
        },
      },
      required: ["txHash"],
    },
  },
  {
    name: "get_attestation_status",
    description: "Get the current status of an attestation by its UUID. Call this after verify_xrp_payment to check if the proof is ready and verified on-chain.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Attestation UUID returned from verify_xrp_payment" },
      },
      required: ["id"],
    },
  },
  {
    name: "lookup_attestation_by_tx",
    description: "Look up an attestation by its original XRP transaction hash. Returns the full attestation record if one exists.",
    inputSchema: {
      type: "object",
      properties: {
        txHash: {
          type: "string",
          description: "XRP transaction hash (64 hex characters). Example: 388076B7245A60A13D6A764C8D0B5919F8A77E04E720C32CA1E30E9B7A291F22",
        },
      },
      required: ["txHash"],
    },
  },
  {
    name: "get_server_info",
    description: "Get XRPLink server information, network details, contract addresses, and white-label branding.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_attestation_by_round",
    description: "List all attestations for a given FDC voting round ID.",
    inputSchema: {
      type: "object",
      properties: {
        roundId: { type: "number", description: "FDC voting round ID to query" },
      },
      required: ["roundId"],
    },
  },
];

export async function handleVerifyXrpPayment(args: Record<string, unknown>) {
  const txHash = args.txHash as string;
  const cleanHash = txHash.replace(/^0x/i, "").toUpperCase();

  if (!/^[0-9A-F]{64}$/.test(cleanHash)) {
    const err = formatError("INVALID_TX_HASH");
    return { isError: true, content: [{ type: "text" as const, text: `${err.message}\n\n${err.suggestedAction}` }] };
  }

  const cached = store.getByTxHash(cleanHash);
  if (cached) {
    return {
      content: [{ type: "text" as const, text: `Attestation already ${cached.status}\n\n${JSON.stringify({ id: cached.id, txHash: cleanHash, roundId: cached.roundId, status: cached.status, verifiedTxHash: cached.verifiedTxHash, cached: true }, null, 2)}` }],
    };
  }

  if (config.paymentVerifierAddress) {
    try {
      if (await fdc.isAlreadyVerified(cleanHash)) {
        const record = store.createAttestation(cleanHash);
        store.updateAttestation(record.id, { status: "verified" });
        return { content: [{ type: "text" as const, text: `Transaction already verified on-chain\n\n${JSON.stringify({ id: record.id, txHash: cleanHash, status: "verified" }, null, 2)}` }] };
      }
    } catch {}
  }

  const attestation = store.createAttestation(cleanHash);
  try {
    const proofOwner = fdc.getProofOwner();
    const abiEncoded = await fdc.prepareRequest(cleanHash, proofOwner);
    store.updateAttestation(attestation.id, { abiEncodedRequest: abiEncoded });
    const { roundId } = await fdc.submitRequest(abiEncoded);
    store.updateAttestation(attestation.id, { roundId, status: "pending" });

    pollForProof(attestation.id, roundId, abiEncoded).catch((err) => {
      console.error(`MCP poll failed for ${attestation.id}:`, err.message);
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        id: attestation.id, txHash: cleanHash, roundId, status: "pending",
        message: `Submitted to voting round ${roundId}. Use get_attestation_status in ~90 seconds to check.`,
      }, null, 2) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    store.updateAttestation(attestation.id, { status: "failed", error: message });
    return { isError: true, content: [{ type: "text" as const, text: `Submission failed: ${message}` }] };
  }
}

export async function handleGetAttestationStatus(args: Record<string, unknown>) {
  const id = args.id as string;
  const a = store.getAttestation(id);
  if (!a) return { isError: true, content: [{ type: "text" as const, text: `Attestation not found: ${id}` }] };
  return { content: [{ type: "text" as const, text: JSON.stringify(a, null, 2) }] };
}

export async function handleLookupByTx(args: Record<string, unknown>) {
  const txHash = (args.txHash as string).replace(/^0x/i, "").toUpperCase();
  const a = store.getByTxHash(txHash);
  if (!a) return { isError: true, content: [{ type: "text" as const, text: `No attestation found for txHash: ${txHash}` }] };
  return { content: [{ type: "text" as const, text: JSON.stringify(a, null, 2) }] };
}

export async function handleGetAttestationByRound(args: Record<string, unknown>) {
  const roundId = Number(args.roundId);
  const all = store.listAttestations().filter((a) => a.roundId === roundId);
  return { content: [{ type: "text" as const, text: all.length ? JSON.stringify(all, null, 2) : `No attestations found for round ${roundId}` }] };
}

export async function handleGetServerInfo() {
  const wl = whiteLabel.get();
  return {
    content: [{ type: "text" as const, text: JSON.stringify({
      brand: wl.brandName,
      network: config.network,
      sourceId: activeNetwork.sourceId,
      rpc: activeNetwork.rpc,
      paymentVerifier: config.paymentVerifierAddress || "not configured",
      chainId: activeNetwork.chainId,
      fdcHub: activeNetwork.fdcHub,
      companyUrl: wl.companyUrl,
      uptime: process.uptime(),
      attestationCount: store.listAttestations().length,
    }, null, 2) }],
  };
}

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
