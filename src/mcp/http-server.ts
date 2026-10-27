/**
 * MCP HTTP Server - remote agents via Streamable HTTP.
 *
 * Auth rules (scanners such as Smithery and Glama treat HTTP 403 as a failure):
 * - initialize, tools/list, resources, prompts, and read-only tools work without a key
 * - /mcp never returns 403 for auth
 * - verify_xrp_payment without a key or payment returns a JSON-RPC tool error
 *   (HTTP 200) that includes x402 payment requirements when pay-per-use is configured
 * - crawler user agents are not blocked
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

import { store } from "../store.js";
import {
  tools,
  handleGetAttestationStatus,
  handleLookupByTx,
  handleGetServerInfo,
} from "./tools.js";
import { getResources, readResource } from "./resources.js";
import { getPromptDefs, getPromptContent } from "./prompts.js";
import { attestXrpPayment } from "../attest.js";
import { getMcpContext, runMcpContext, McpRequestContext } from "./context.js";
import { checkVerifyRateLimit, clientIp } from "../rate-limit.js";

const SERVER_NAME = "xrplink-mcp";
const SERVER_VERSION = "0.3.0";

function toolError(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

function toolOk(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

async function handleVerifyXrpPaymentWithAuth(args: Record<string, unknown>) {
  const requestContext = getMcpContext();
  if (requestContext.http) {
    const limited = checkVerifyRateLimit(requestContext.clientIp || "unknown", requestContext.apiKey);
    if (!limited.allowed) {
      return toolError(`Rate limit exceeded. Retry after ${limited.retryAfterSec}s.`);
    }
  }
  const result = await attestXrpPayment({
    txHash: args.txHash as string,
    apiKeyHeader: requestContext.apiKey,
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
        result.body.limit !== undefined ? `\nLimit: ${result.body.limit}` : "",
        result.body.used !== undefined ? `Used: ${result.body.used}` : "",
        result.body.resetDate ? `Reset: ${result.body.resetDate}` : "",
      ].join("\n")
    );
  }

  const rawMessage = String(result.body.message || result.body.error || "Request failed");
  const code = result.body.code || result.body.error;
  const message =
    code === "MISSING_API_KEY" || code === "INVALID_API_KEY"
      ? `API key required. ${rawMessage}`
      : rawMessage;
  const extras: string[] = [];
  if (code) extras.push(`Code: ${code}`);
  if (result.body.limit !== undefined) extras.push(`Limit: ${result.body.limit}`);
  if (result.body.used !== undefined) extras.push(`Used: ${result.body.used}`);
  if (result.body.resetDate) extras.push(`Reset: ${result.body.resetDate}`);
  return toolError(extras.length ? `${message}\n\n${extras.join("\n")}` : message);
}

const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<any>> = {
  verify_xrp_payment: handleVerifyXrpPaymentWithAuth,
  get_attestation_status: handleGetAttestationStatus,
  lookup_attestation_by_tx: handleLookupByTx,
  get_server_info: handleGetServerInfo,
};

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = toolHandlers[req.params.name];
    if (!handler) {
      return toolError(`Unknown tool: ${req.params.name}`);
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
  // Never 403. Invalid keys are treated as unauthenticated; tools decide what to do.
  const apiKeyHeader = req.headers["x-api-key"] as string | undefined;
  const paymentSignature = req.headers["payment-signature"] as string | undefined;

  const ctx: McpRequestContext = {
    http: true,
    apiKey: apiKeyHeader,
    paymentSignature,
    clientIp: clientIp(req),
  };
  if (apiKeyHeader) {
    const apiKeyRecord = await store.getApiKey(apiKeyHeader);
    if (apiKeyRecord && apiKeyRecord.active) {
      ctx.apiKeyRecord = apiKeyRecord;
      store.incrementApiKeyUsage(apiKeyHeader);
    }
  }

  await runMcpContext(ctx, async () => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (req.method === "POST" && !sessionId) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      const server = createMcpServer();
      await server.connect(transport);
    } else if (req.method === "DELETE" && sessionId) {
      const existingTransport = transports.get(sessionId);
      if (existingTransport) {
        await existingTransport.close();
        transports.delete(sessionId);
      }
      res.status(200).json({ status: "session closed" });
      return;
    } else if (req.method === "GET") {
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

    const newSessionId = transport.sessionId;
    if (newSessionId && !transports.has(newSessionId)) {
      transports.set(newSessionId, transport);
    }
  });
}

export function getMcpSessionCount(): number {
  return transports.size;
}
