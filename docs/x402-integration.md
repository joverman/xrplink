# XRPLink x402 Integration Plan

## Overview

XRPLink will use Cloudflare's Monetization Gateway + the x402 protocol to enable **agent-native pay-per-attestation pricing**. AI agents pay for each XRP payment verification autonomously via stablecoin micropayments, with no API key, signup, or billing infrastructure required.

## Pricing Model

| Resource | Price | Method | Notes |
|----------|-------|--------|-------|
| `verify_xrp_payment` (MCP tool) | $0.01 | x402 | Covers FDC attestation fee + gas |
| `POST /api/v1/verify/xrp-payment` | $0.01 | x402 | Same via REST |
| `get_attestation_status` | Free | — | Status checks always free |
| `lookup_attestation_by_tx` | Free | — | Lookups always free |
| `get_server_info` | Free | — | Server info always free |
| `GET /health` | Free | — | Always free |

## Architecture

```
                    ┌─────────────────────────────────┐
                    │         Cloudflare               │
                    │    Monetization Gateway          │
                    │  (verifies x402 payments)        │
                    └──────────┬──────────────────────┘
                               │
                    ┌──────────▼──────────────────────┐
                    │     XRPLink Server                │
                    │                                  │
                    │  MCP Server (primary)             │
                    │  REST API (sidecar)               │
                    │  FDC Service                      │
                    └──────────────────────────────────┘
```

## Payment Flow (x402)

```
Agent                              XRPLink                      Cloudflare MG
  │                                   │                              │
  │── POST /api/v1/verify/xrp-payment ──▶                          │
  │    { txHash: "0x..." }                                         │
  │                                   │                              │
  │◀── 402 Payment Required ──────────│                              │
  │    { price: "0.01",                                             │
  │      asset: "USDC",                                             │
  │      address: "0x..." }                                        │
  │                                   │                              │
  │── POST (with x402 payment proof) ──▶                          │
  │                                   │                              │
  │                                   │── verify payment ──────────▶│
  │                                   │◀── verified ───────────────│
  │                                   │                              │
  │                                   │── submit attestation ──▶     │
  │                                   │    to FdcHub                 │
  │                                   │                              │
  │◀── 202 Accepted ──────────────────│                              │
  │    { id: "...", roundId: 1234 }                                 │
  │                                   │                              │
  │── GET /api/v1/status/:id ────────▶                              │
  │    (poll until verified)                                        │
  │◀── { status: "verified", proof } ──│                            │
```

## Implementation Steps

### 1. Join Monetization Gateway Waitlist
- URL: https://docs.google.com/forms/d/e/1FAIpQLSfq6yaIgp57FCGFg7riXlSWTeD8d8Adur2c8tWaKY4SuzweiQ/viewform
- Cloudflare account needed

### 2. Deploy XRPLink behind Cloudflare
- Point domain to Cloudflare
- Configure proxy (orange cloud)
- Set up WAF rules to protect API

### 3. Configure Payment Rules
Using the Monetization Gateway API, set rules like:

```
# Rule 1: Charge for MCP verify tool
match: request.path == "/api/v1/verify/xrp-payment"
action: require_payment(amount=0.01, asset="USDC")

# Rule 2: Charge for MCP tool call matching verify
match: request.method == "POST" && request.path == "/mcp" 
  && body.contains("verify_xrp_payment")
action: require_payment(amount=0.01, asset="USDC")

# Rule 3: Free for all other endpoints  
match: true
action: allow
```

### 4. Add x402 Response Headers to Server
When XRPLink receives a request without payment, return:

```
HTTP/1.1 402 Payment Required
X-402-Price: 0.01
X-402-Asset: USDC
X-402-Address: 0x...
Content-Type: application/json

{ "error": "PAYMENT_REQUIRED",
  "message": "Payment of $0.01 USDC required",
  "payment": { "price": 0.01, "asset": "USDC", "address": "..." } }
```

### 5. Future: MCP Tool-Level Pricing
Extend pricing to individual MCP tools:

```
# xrplink://pricing resource
Tool: verify_xrp_payment — $0.01
Tool: get_attestation_status — free
Tool: lookup_attestation_by_tx — free
Tool: get_server_info — free
```

## Benefits

| Stakeholder | Benefit |
|-------------|---------|
| **AI Agents** | Pay per call, no signup, no API key management |
| **Developers** | No billing code, Cloudflare handles payments |
| **XRPLink** | Revenue per attestation, scales with usage |
| **Flare** | More FDC usage, proven protocol value |

## Revenue Model

At $0.01 per attestation:
- 100 attestations/day = $1/day = ~$30/month
- 1,000 attestations/day = $10/day = ~$300/month
- 10,000 attestations/day = $100/day = ~$3,000/month

Break-even at ~100 attestations/day (covers FDC fees + server costs).
