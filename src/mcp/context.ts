import { AsyncLocalStorage } from "node:async_hooks";
import { ApiKey } from "../types.js";

/** Per-request MCP auth. HTTP handlers set `http: true`; stdio leaves the store unset. */
export interface McpRequestContext {
  http?: boolean;
  apiKey?: string;
  apiKeyRecord?: ApiKey;
  paymentSignature?: string;
}

export const mcpAls = new AsyncLocalStorage<McpRequestContext>();

export function getMcpContext(): McpRequestContext {
  return mcpAls.getStore() || {};
}

export function runMcpContext<T>(ctx: McpRequestContext, fn: () => T): T {
  return mcpAls.run(ctx, fn);
}
