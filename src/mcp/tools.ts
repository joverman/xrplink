import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { config, activeNetwork } from "../config.js";
import { store } from "../store.js";
import { whiteLabel } from "../white-label.js";
import { attestXrpPayment } from "../attest.js";
import { FDC_XRP_PAYMENT_LUT_LIMIT_DAYS } from "../xrpl-tx.js";
import { attestationViewForMcp } from "../attestation-view.js";
import { getMcpContext } from "./context.js";
import { checkVerifyRateLimit } from "../rate-limit.js";

export const tools: Tool[] = [
  {
    name: "verify_xrp_payment",
    description: "Submit a native XRP Payment hash for FDC attestation on Flare. Only Payments from the last 14 days can be proven. Subscription API keys inside quota are not charged extra (Paid: 20 mainnet attestations per billing period; Pro: 100). Failed prepares do not consume quota. Without a key, or over quota, the tool returns an x402 payment challenge (RLUSD first, then XRP via the XRPL facilitator). Over-quota subscribers can upgrade or buy a single extra attestation. A valid PAYMENT-SIGNATURE pays for exactly one attestation. Status checks are free. Proof takes ~90-180 seconds; use get_attestation_status.",
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
    description: "Get the current status of an attestation by its UUID. Unauthenticated callers receive the public receipt subset. The owning API key receives the full proof.",
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
    description: "Look up an attestation by its original XRP transaction hash. Unauthenticated callers receive the public receipt subset. The owning API key receives the full proof.",
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
];

function toolError(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

function toolOk(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Quota/x402-aware verify. Requires an API key in MCP context (HTTP header or
 * stdio MCP_API_KEY). Unauthenticated stdio no longer spends the Flare wallet.
 */
export async function handleVerifyXrpPayment(args: Record<string, unknown>) {
  const requestContext = getMcpContext();
  const apiKey = requestContext.apiKey || (typeof args.apiKey === "string" ? args.apiKey : undefined);
  if (requestContext.http || requestContext.clientIp) {
    const limited = checkVerifyRateLimit(requestContext.clientIp || "unknown", apiKey);
    if (!limited.allowed) {
      return toolError(`Rate limit exceeded. Retry after ${limited.retryAfterSec}s.`);
    }
  }
  const result = await attestXrpPayment({
    txHash: args.txHash as string,
    apiKeyHeader: apiKey,
    apiKeyRecord: requestContext.apiKeyRecord,
    paymentSignature: requestContext.paymentSignature,
  });

  if (result.kind === "ok") {
    const extra =
      result.body.status === "pending"
        ? { message: `Submitted to voting round ${result.body.roundId}. Use get_attestation_status in ~90 seconds to check.` }
        : {};
    return toolOk({ ...result.body, ...extra });
  }

  if (result.kind === "payment_required") {
    return toolError(
      [
        result.body.message,
        "",
        "This is an x402 Payment Required challenge. Sign an XRPL Payment for one of the accepts entries and retry with a PAYMENT-SIGNATURE header.",
        "",
        JSON.stringify(
          {
            code: result.body.code,
            paymentRequired: result.body.paymentRequired,
            priceUsd: result.body.priceUsd,
            priceXrp: result.body.priceXrp,
            priceRlusd: result.body.priceRlusd,
            limit: result.body.limit,
            used: result.body.used,
            resetDate: result.body.resetDate,
            upgradeUrl: result.body.upgradeUrl,
          },
          null,
          2
        ),
      ].join("\n")
    );
  }

  const rawMessage = String(result.body.message || result.body.error || "Request failed");
  const code = result.body.code || result.body.error;
  const message =
    code === "MISSING_API_KEY" || code === "INVALID_API_KEY"
      ? `API key required. ${rawMessage}`
      : rawMessage;
  return toolError(code ? `${message}\n\nCode: ${code}` : message);
}

export async function handleGetAttestationStatus(args: Record<string, unknown>) {
  const id = args.id as string;
  const a = await store.getAttestation(id);
  if (!a) return { isError: true, content: [{ type: "text" as const, text: `Attestation not found: ${id}` }] };
  return { content: [{ type: "text" as const, text: JSON.stringify(attestationViewForMcp(a), null, 2) }] };
}

export async function handleLookupByTx(args: Record<string, unknown>) {
  const txHash = (args.txHash as string).replace(/^0x/i, "").toUpperCase();
  const a = await store.getByTxHash(txHash);
  if (!a) return { isError: true, content: [{ type: "text" as const, text: `No attestation found for txHash: ${txHash}` }] };
  return { content: [{ type: "text" as const, text: JSON.stringify(attestationViewForMcp(a), null, 2) }] };
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
      verifierBaseUrl: activeNetwork.verifierBaseUrl,
      xrpPaymentLookbackDays: FDC_XRP_PAYMENT_LUT_LIMIT_DAYS,
      companyUrl: wl.companyUrl,
      uptime: process.uptime(),
    }, null, 2) }],
  };
}
