import "dotenv/config";
import { config } from "./config.js";
import { startMcpServer } from "./mcp/index.js";

if (!config.privateKey) {
  console.error("PRIVATE_KEY not set in .env");
  process.exit(1);
}

// Always start MCP server (stdio)
startMcpServer().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});

// Optionally start REST API (sidecar)
const startApi = process.argv.includes("--api") || process.env.START_API === "true";
if (startApi) {
  const { default: app } = await import("./app.js");
  app.listen(config.port, () => {
    console.log(`REST API running on port ${config.port}`);
  });
}

// Graceful shutdown
function shutdown() {
  console.log("\nShutting down...");
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
