import "dotenv/config";
import { requireValidEnv, isProduction } from "./env-validation.js";
import { config } from "./config.js";
import { startMcpServer } from "./mcp/index.js";

// Validate environment before starting
requireValidEnv();

// Always start MCP server (stdio)
startMcpServer().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});

// Optionally start REST API (sidecar)
const startApi = process.argv.includes("--api") || process.env.START_API === "true";
if (startApi) {
  const { default: app } = await import("./app.js");
  const host = process.env.HOST || "0.0.0.0";
  app.listen(config.port, host, () => {
    console.log(`REST API running on ${host}:${config.port}`);
  });
  // Initialize Stripe products (fire and forget)
  import("./billing.js").then((m) => m.initProducts()).catch(() => {});
}

// Graceful shutdown
function shutdown() {
  console.log("\nShutting down...");
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
