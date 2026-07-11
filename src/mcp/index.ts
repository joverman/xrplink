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

import { config } from "../config.js";
import { tools, handleVerifyXrpPayment, handleGetAttestationStatus, handleLookupByTx, handleGetAttestationByRound, handleGetServerInfo } from "./tools.js";
import { getResources, readResource } from "./resources.js";
import { getPromptDefs, getPromptContent } from "./prompts.js";

const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<any>> = {
  verify_xrp_payment: handleVerifyXrpPayment,
  get_attestation_status: handleGetAttestationStatus,
  lookup_attestation_by_tx: handleLookupByTx,
  get_attestation_by_round: handleGetAttestationByRound,
  get_server_info: handleGetServerInfo,
};

const SERVER_NAME = "xrplink-mcp";
const SERVER_VERSION = "0.3.0";

export async function startMcpServer() {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // Tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = toolHandlers[req.params.name];
    if (!handler) {
      return { isError: true, content: [{ type: "text" as const, text: `Unknown tool: ${req.params.name}` }] };
    }
    return handler(req.params.arguments || {});
  });

  // Resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: getResources() }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const text = await readResource(req.params.uri);
    if (text === null) {
      throw new Error(`Resource not found: ${req.params.uri}`);
    }
    return { contents: [{ uri: req.params.uri, mimeType: "text/markdown" as const, text }] };
  });

  // Prompts
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

  // Start stdio transport (always on)
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  console.error("✓ MCP server running (stdio)");

  return server;
}
