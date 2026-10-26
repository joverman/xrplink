/**
 * MCP HTTP Server - Remote agent endpoint using Streamable HTTP transport.
 * 
 * This module provides a remote MCP endpoint that:
 * - Uses the Streamable HTTP transport (POST/GET to /mcp)
 * - Requires X-API-Key for tools that trigger attestations (verify_xrp_payment)
 * - Applies the same quota limits as the REST API
 * - Allows read-only tools (status, lookup, server info) without a key
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { Request, Response } from "express";

import { config } from "../config.js";
import { store } from "../store.js";
import { userStore } from "../user-store.js";
import {
  tools,
  handleGetAttestationStatus,
  handleLookupByTx,
  handleGetAttestationByRound,
  handleGetServerInfo,
} from "./tools.js";
import { getResources, readResource } from "./resources.js";
import { getPromptDefs, getPromptContent } from "./prompts.js";
import { formatError } from "./errors.js";
import * as fdc from "../fdc-service.js";
import {
  checkQuota,
  buildQuotaExceededError,
  BillingPeriod,
  getFallbackBillingPeriod,
  getBillingPeriodKey,
} from "../attestation-quota.js";

const SERVER_NAME = "xrplink-mcp";
const SERVER_VERSION = "0.3.0";

const READ_ONLY_TOOLS = new Set([
  "get_attestation_status",
  "lookup_attestation_by_tx",
  "get_attestation_by_round",
  "get_server_info",
]);

interface McpRequestContext {
  apiKey?: string;
  apiKeyRecord?: Awaited<ReturnType<typeof store.getApiKey>>;
}

let requestContext: McpRequestContext = {};

async function handleVerifyXrpPaymentWithAuth(args: Record<string, unknown>) {
  const txHash = args.txHash as string;
  const cleanHash = txHash.replace(/^0x/i, "").toUpperCase();

  if (!/^[0-9A-F]{64}$/.test(cleanHash)) {
    const err = formatError("INVALID_TX_HASH");
    return { isError: true, content: [{ type: "text" as const, text: `${err.message}\n\n${err.suggestedAction}` }] };
  }

  const apiKey = requestContext.apiKeyRecord;
  if (!apiKey) {
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: "API key required. Provide X-API-Key header to create attestations.\n\nRead-only tools (get_attestation_status, lookup_attestation_by_tx, get_server_info) don't require a key.",
      }],
    };
  }

  const cached = await store.getByTxHash(cleanHash);
  if (cached) {
    return {
      content: [{ type: "text" as const, text: `Attestation already ${cached.status}\n\n${JSON.stringify({ id: cached.id, txHash: cleanHash, roundId: cached.roundId, status: cached.status, verifiedTxHash: cached.verifiedTxHash, cached: true }, null, 2)}` }],
    };
  }

  if (config.paymentVerifierAddress) {
    try {
      if (await fdc.isAlreadyVerified(cleanHash)) {
        const record = await store.createAttestation(cleanHash);
        await store.updateAttestation(record.id, { status: "verified" });
        return { content: [{ type: "text" as const, text: `Transaction already verified on-chain\n\n${JSON.stringify({ id: record.id, txHash: cleanHash, status: "verified" }, null, 2)}` }] };
      }
    } catch {}
  }

  const isMainnet = config.network === "flare";
  let billingPeriod: BillingPeriod | null = null;

  if (isMainnet) {
    const apiKeyOwner = userStore.findByApiKey(apiKey.key);

    if (apiKeyOwner && apiKeyOwner.billingPeriodStart && apiKeyOwner.billingPeriodEnd) {
      billingPeriod = {
        start: apiKeyOwner.billingPeriodStart,
        end: apiKeyOwner.billingPeriodEnd,
      };
    } else if (apiKeyOwner) {
      billingPeriod = getFallbackBillingPeriod(apiKeyOwner.createdAt);
    } else {
      billingPeriod = getFallbackBillingPeriod(apiKey.createdAt);
    }

    const periodKey = getBillingPeriodKey(billingPeriod);
    const currentUsage = await store.getAttestationUsage(apiKey.key, periodKey);
    const quotaCheck = checkQuota(apiKey.tier, currentUsage, billingPeriod);

    if (!quotaCheck.allowed) {
      const error = buildQuotaExceededError(quotaCheck);
      return {
        isError: true,
        content: [{ type: "text" as const, text: `${error.message}\n\nCode: ${error.code}\nLimit: ${error.limit}\nUsed: ${error.used}\nReset: ${error.resetDate}` }],
      };
    }
  }

  const attestation = await store.createAttestation(cleanHash);

  try {
    const proofOwner = fdc.getProofOwner();
    const abiEncoded = await fdc.prepareRequest(cleanHash, proofOwner);
    await store.updateAttestation(attestation.id, { abiEncodedRequest: abiEncoded });

    const { roundId } = await fdc.submitRequest(abiEncoded);
    await store.updateAttestation(attestation.id, { roundId, status: "pending" });

    if (isMainnet && billingPeriod) {
      const periodKey = getBillingPeriodKey(billingPeriod);
      await store.incrementAttestationUsage(apiKey.key, periodKey);
    }

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
    await store.updateAttestation(attestation.id, { status: "failed", error: message });
    return { isError: true, content: [{ type: "text" as const, text: `Submission failed: ${message}` }] };
  }
}

async function pollForProof(id: string, roundId: number, abiEncoded: string, attempt = 1) {
  await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  try {
    const proofData = await fdc.fetchProof(roundId, abiEncoded);
    if (!proofData) {
      if (attempt < config.maxPollAttempts) return pollForProof(id, roundId, abiEncoded, attempt + 1);
      await store.updateAttestation(id, { status: "not_found", error: "Proof not found after max poll attempts" });
      return;
    }
    await store.updateAttestation(id, { proof: proofData, status: "ready" });
    if (config.paymentVerifierAddress) {
      const verifiedTxHash = await fdc.verifyProofOnChain(proofData, config.paymentVerifierAddress);
      await store.updateAttestation(id, { verifiedTxHash, status: "verified" });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempt < config.maxPollAttempts) return pollForProof(id, roundId, abiEncoded, attempt + 1);
    await store.updateAttestation(id, { status: "failed", error: message });
  }
}

const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<any>> = {
  verify_xrp_payment: handleVerifyXrpPaymentWithAuth,
  get_attestation_status: handleGetAttestationStatus,
  lookup_attestation_by_tx: handleLookupByTx,
  get_attestation_by_round: handleGetAttestationByRound,
  get_server_info: handleGetServerInfo,
};

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;

    if (!READ_ONLY_TOOLS.has(toolName) && !requestContext.apiKeyRecord) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: `API key required for ${toolName}. Include X-API-Key header.\n\nTools that don't require a key: ${Array.from(READ_ONLY_TOOLS).join(", ")}`,
        }],
      };
    }

    const handler = toolHandlers[toolName];
    if (!handler) {
      return { isError: true, content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }] };
    }

    return handler(req.params.arguments || {});
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: getResources() }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const text = await readResource(req.params.uri);
    if (text === null) {
      throw new Error(`Resource not found: ${req.params.uri}`);
    }
    return { contents: [{ uri: req.params.uri, mimeType: "text/markdown" as const, text }] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const defs = getPromptDefs();
    return {
      prompts: defs.map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.args.map((a) => ({ name: a.name, description: a.description, required: a.required })),
      })),
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const content = getPromptContent(req.params.name, req.params.arguments);
    if (!content) {
      throw new Error(`Prompt not found: ${req.params.name}`);
    }
    return {
      messages: [{ role: "assistant", content: { type: "text" as const, text: content } }],
    };
  });

  return server;
}

const transports = new Map<string, StreamableHTTPServerTransport>();

export async function handleMcpRequest(req: Request, res: Response) {
  const apiKeyHeader = req.headers["x-api-key"] as string | undefined;

  requestContext = { apiKey: apiKeyHeader };
  if (apiKeyHeader) {
    const apiKeyRecord = await store.getApiKey(apiKeyHeader);
    if (apiKeyRecord && apiKeyRecord.active) {
      requestContext.apiKeyRecord = apiKeyRecord;
      store.incrementApiKeyUsage(apiKeyHeader);
    }
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports.has(sessionId)) {
    // Reuse existing session
    transport = transports.get(sessionId)!;
  } else if (req.method === "POST" && !sessionId) {
    // New session - create transport with session ID generator
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    const server = createMcpServer();
    await server.connect(transport);
  } else if (req.method === "DELETE" && sessionId) {
    // Session termination
    const existingTransport = transports.get(sessionId);
    if (existingTransport) {
      await existingTransport.close();
      transports.delete(sessionId);
    }
    res.status(200).json({ status: "session closed" });
    return;
  } else if (req.method === "GET") {
    // Stateless GET for SSE notifications
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = createMcpServer();
    await server.connect(transport);
  } else {
    res.status(400).json({ error: "Bad Request", message: "Missing or invalid session ID" });
    return;
  }

  const nodeReq = req as unknown as IncomingMessage & { auth?: any };
  const nodeRes = res as unknown as ServerResponse;
  await transport.handleRequest(nodeReq, nodeRes, req.body);
  
  // After handleRequest, check if this created a new session and store it
  const newSessionId = transport.sessionId;
  if (newSessionId && !transports.has(newSessionId)) {
    transports.set(newSessionId, transport);
  }
}

export function getMcpSessionCount(): number {
  return transports.size;
}
