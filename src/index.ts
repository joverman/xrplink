import { config } from "./config.js";
import app from "./app.js";

if (!config.privateKey) {
  console.error("PRIVATE_KEY not set in .env");
  process.exit(1);
}

const server = app.listen(config.port, () => {
  console.log(`XRPLink API server running on port ${config.port}`);
  console.log(`  Network: Coston2`);
  console.log(`  PaymentVerifier: ${config.paymentVerifierAddress || "not configured"}`);
});

function shutdown() {
  console.log("\nShutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("Forced shutdown");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
