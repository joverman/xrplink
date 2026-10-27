import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { loadLandingHtml, loadPricingHtml } from "./landing.js";
import { securityHeaders } from "./security-headers.js";
import routes from "./routes.js";

const app = express();
app.disable("x-powered-by");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Trust proxy headers (Cloudflare Tunnel, Fly.io, nginx, etc.)
// This makes req.ip and req.protocol reflect the real client values
// TRUST_PROXY can be: 'true', '1', 'loopback', 'linklocal', 'uniquelocal', or a specific IP/CIDR
const trustProxy = process.env.TRUST_PROXY || "loopback,linklocal,uniquelocal";
if (trustProxy === "true" || trustProxy === "1") {
  app.set("trust proxy", true);
} else if (trustProxy === "false" || trustProxy === "0") {
  app.set("trust proxy", false);
} else {
  app.set("trust proxy", trustProxy);
}

app.use(securityHeaders);

// Get real client IP, preferring Cloudflare's CF-Connecting-IP header
function getClientIp(req: express.Request): string {
  const cfIp = req.headers["cf-connecting-ip"];
  if (cfIp) return Array.isArray(cfIp) ? cfIp[0] : cfIp;
  return req.ip || "unknown";
}

app.use((req, _res, next) => {
  const clientIp = getClientIp(req);
  console.log(`${new Date().toISOString()} ${req.method} ${req.path} [${clientIp}]`);
  next();
});

// Public landing and pricing pages interpolate X402_FLOOR_USD / X402_CAP_USD into the Pay as you go card.
app.get(["/", "/index.html"], (_req, res) => {
  res.type("html").send(loadLandingHtml());
});

app.get(["/pricing", "/pricing.html"], (_req, res) => {
  res.type("html").send(loadPricingHtml());
});

// Serve static files (landing page, assets)
app.use(express.static(path.join(__dirname, "..", "public"), { index: false }));

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
