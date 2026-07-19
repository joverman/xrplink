import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import routes from "./routes.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Serve static files (landing page, assets)
app.use(express.static(path.join(__dirname, "..", "public")));

// Stripe webhook needs raw body (before JSON parser)
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const { handleWebhook } = await import("./billing.js");
  const sig = (req.headers["stripe-signature"] || "") as string;
  const result = await handleWebhook(req.body, sig);
  res.status(result.status).json(result.body);
});

app.use(express.json());

app.use(routes);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    code: "INTERNAL_ERROR",
    details: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

export default app;
