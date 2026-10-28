import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { store } from "../store.js";
import { tools, handleVerifyXrpPayment, handleGetAttestationStatus, handleLookupByTx, handleGetServerInfo } from "./tools.js";
import { getResources, readResource } from "./resources.js";
import { getPromptDefs, getPromptContent } from "./prompts.js";
import { McpRequestContext, runMcpContext } from "./context.js";

const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<any>> = {
  verify_xrp_payment: handleVerifyXrpPayment,
  get_attestation_status: handleGetAttestationStatus,
  lookup_attestation_by_tx: handleLookupByTx,
  get_server_info: handleGetServerInfo,
};

const SERVER_NAME = "xrplink-mcp";
const SERVER_VERSION = "0.3.0";

async function stdioContext(): Promise<McpRequestContext> {
  const envKey = (process.env.MCP_API_KEY || "").trim();
  const ctx: McpRequestContext = { http: false };
  if (!envKey) return ctx;
  try {
    const rec = await store.getApiKey(envKey);
    if (rec?.active) {
      ctx.apiKey = envKey;
      ctx.apiKeyRecord = rec;
    }
  } catch {
    /* treat as unauthenticated; never log the key */
  }
  return ctx;
}

export async function startMcpServer() {
  const baseCtx = await stdioContext();
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = toolHandlers[req.params.name];
    if (!handler) {
      return { isError: true, content: [{ type: "text" as const, text: `Unknown tool: ${req.params.name}` }] };
    }
    return runMcpContext(baseCtx, () => handler(req.params.arguments || {}));
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () =>
    runMcpContext(baseCtx, () => ({ resources: getResources() }))
  );
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    return runMcpContext(baseCtx, async () => {
      const text = await readResource(req.params.uri);
      if (text === null) {
        throw new Error(`Resource not found: ${req.params.uri}`);
      }
      return { contents: [{ uri: req.params.uri, mimeType: "text/markdown" as const, text }] };
    });
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const defs = getPromptDefs({ includeAdmin: false });
    return {
      prompts: defs.map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.args.map((a) => ({ name: a.name, description: a.description, required: a.required })),
      })),
    };
  });
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (req.params.name === "admin_setup") {
      throw new Error("Prompt not found: admin_setup");
    }
    const content = getPromptContent(req.params.name, req.params.arguments);
    if (!content) {
      throw new Error(`Prompt not found: ${req.params.name}`);
    }
    return {
      messages: [{ role: "assistant", content: { type: "text" as const, text: content } }],
    };
  });

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  console.error("✓ MCP server running (stdio)");

  return server;
}
