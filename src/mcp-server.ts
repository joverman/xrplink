import "dotenv/config";
import { startMcpServer } from "./mcp/index.js";

startMcpServer().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
