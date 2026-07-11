# Phase 3.5 — Agent-Native Rebuild

## Goal
Flip the architecture so MCP is the primary interface. Implement MCP resources, prompts, enriched errors, SSE transport, and modular structure.

## Files to Create

### 1. `src/mcp/errors.ts` — Agent-friendly error enrichment
Shared error catalog with `suggestedAction` and `docsUrl` on every error. Used by both MCP and HTTP.

```typescript
export interface AgentError {
  error: string;
  message: string;
  suggestedAction?: string;
  docsUrl?: string;
  details?: string;
}

export function formatError(code: string, ctx?: Record<string, string>, fallbackMessage?: string): AgentError {
  // Returns error from catalog with context-based overrides
}

export function wrapError(err: unknown, code = "INTERNAL_ERROR", ctx?: Record<string, string>): AgentError {
  const message = err instanceof Error ? err.message : String(err);
  return formatError(code, ctx, message);
}
```

Error catalog codes: `INVALID_TX_HASH`, `MISSING_API_KEY`, `INVALID_API_KEY`, `RATE_LIMITED`, `SUBMIT_FAILED`, `NOT_FOUND`, `FORBIDDEN`, `MISSING_URL`, `INVALID_URL`, `INTERNAL_ERROR`, `MISSING_ATTESTATION_ID`, `VERIFIER_ERROR`, `DA_LAYER_ERROR`

### 2. `src/mcp/resources.ts` — MCP Resource handlers
Resources are URI-addressable markdown documents agents can read:

| URI | Content |
|-----|---------|
| `xrplink://docs/overview` | Project description, version, network |
| `xrplink://docs/config` | Env vars, their purposes, defaults |
| `xrplink://docs/network` | Contract addresses, RPC, chain info |
| `xrplink://docs/tools` | Tool usage guide with example workflows |
| `xrplink://network/status` | Live health: block number, balance, attestation count |

Exports:
- `getResources(): Resource[]`
- `getResourceContent(uri: string): Promise<string | null>`

### 3. `src/mcp/prompts.ts` — MCP Prompt templates
Pre-written prompt templates that guide agent behavior:

| Name | Description | Args |
|------|-------------|------|
| `welcome` | Introduction to XRPLink | none |
| `verify_flow` | Step-by-step verification walkthrough | txHash (optional) |
| `admin_setup` | API keys, webhooks, branding config | none |
| `troubleshoot` | Common issues and solutions | issue (optional) |

Exports:
- `getPrompts(): Prompt[]`
- `getPromptContent(name: string, args?: Record<string, string>): string | null`

### 4. `src/mcp/tools.ts` — MCP Tool definitions + handlers
Extracted from current `src/mcp-server.ts`. Same 4 tools with enriched descriptions and support for `examples` field:

- `verify_xrp_payment` — Handle attestation submission + caching + polling
- `get_attestation_status` — Lookup by UUID  
- `lookup_attestation_by_tx` — Lookup by txHash
- `get_server_info` — Network + branding info

Exports:
- `tools: Tool[]`
- `handleVerifyXrpPayment(args)`, `handleGetAttestationStatus(args)`, `handleLookupByTx(args)`, `handleGetServerInfo()`

### 5. `src/mcp/index.ts` — MCP Server setup
Creates the MCP `Server` instance, registers all handlers, supports both transports:

```typescript
export async function startMcpServer() {
  const server = new Server(
    { name: "xrplink-mcp", version: "0.3.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // Register tool handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => { /* dispatch to handlers */ });

  // Register resource handlers  
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: getResources() }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const content = await getResourceContent(req.params.uri);
    return { contents: [{ uri: req.params.uri, text: content }] };
  });

  // Register prompt handlers
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: getPrompts() }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const messages = getPromptContent(req.params.name, req.params.arguments);
    return { messages: [{ role: "assistant", content: { type: "text", text: messages } }] };
  });

  // Start stdio transport
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  console.error("MCP server running (stdio)");

  // Optionally start SSE transport  
  if (config.mcpSsePort) {
    // Start SSE listener on config.mcpSsePort
  }
}
```

## Files to Update

### 6. `src/mcp-server.ts` — Thin wrapper
```typescript
import { startMcpServer } from "./mcp/index.js";
startMcpServer();
```

### 7. `src/index.ts` — MCP-first launcher
```typescript
// Start MCP server by default
import { startMcpServer } from "./mcp/index.js";
startMcpServer();

// Optionally start REST API
if (process.argv.includes("--api") || process.env.START_API === "true") {
  const { default: app } = await import("./app.js");
  app.listen(config.port, () => { ... });
}
```

Start modes:
- `npm start` → MCP only
- `npm run start:api` → MCP + REST  
- `npm run start:rest` → REST only

### 8. `src/config.ts` — Add MCP config
```typescript
mcpSsePort: parseInt(process.env.MCP_SSE_PORT || "3001", 10),
```

### 9. `src/routes.ts` — Enriched errors + MCP SSE endpoints
- Import `formatError` from `./mcp/errors.js`
- Replace inline error responses with `formatError(code, ctx)`
- Add `GET /mcp` (SSE stream) and `POST /mcp` (client messages) endpoints

### 10. `src/middleware.ts` — Enriched auth errors
```typescript
import { formatError } from "./mcp/errors.js";
// Replace plain error responses:
return res.status(401).json(formatError("MISSING_API_KEY"));
return res.status(403).json(formatError("INVALID_API_KEY"));
```

### 11. `package.json` — Scripts
```json
{
  "scripts": {
    "start": "tsx src/index.ts",
    "start:api": "START_API=true tsx src/index.ts",
    "start:rest": "tsx src/app.ts",
    "mcp": "tsx src/mcp-server.ts"
  }
}
```

### 12. `.env.example` — Add MCP_SSE_PORT
```
MCP_SSE_PORT=3001
```

## Execution Order

1. Create `src/mcp/errors.ts`
2. Create `src/mcp/resources.ts`
3. Create `src/mcp/prompts.ts`
4. Create `src/mcp/tools.ts`
5. Create `src/mcp/index.ts`
6. Update `src/mcp-server.ts` (thin wrapper)
7. Update `src/index.ts` (MCP-first launcher)
8. Update `src/config.ts`
9. Update `src/middleware.ts`
10. Update `src/routes.ts` (add /mcp SSE endpoints + enriched errors)
11. Update `package.json`
12. Update `.env.example`
13. Test: `npm run start:api` → verify health, dashboard, MCP tools, SSE
14. Commit
