# XRPLink x402 Pay-Per-Attestation

AI agents can attest an XRP payment without a subscription by paying once on the XRP Ledger using the [x402](https://docs.x402.org) protocol and the hosted XRPL facilitator at `https://xrpl-facilitator-mainnet.t54.ai` (XRP or RLUSD).

The earlier Cloudflare Monetization Gateway plan at a flat **$0.01** is retired. Each Flare mainnet attestation costs the operator **20 FLR** (about **$0.14** in mid-October 2026). A one-cent price loses money. Pricing is now FLR-linked and floored.

## When payment is required

| Caller | Result |
|--------|--------|
| Subscription API key **inside** monthly quota | Attest as before. Never asked to pay. |
| No API key | HTTP **402** with x402 `PAYMENT-REQUIRED` (REST) or an MCP tool error containing the same quote |
| Invalid API key | Same 402 quote (REST). MCP still never returns HTTP 403. |
| Key **over quota** | 402 quote (plus quota details). Pay once or wait for the billing-period reset. |
| Cached / already-on-chain attestation | Free. No quota, no x402. |

Status, lookup, health, `initialize`, and `tools/list` stay free. `/mcp` never returns HTTP 403 for auth (Smithery/Glama treat 403 as a dead server).

## Pricing

```
price_usd = max(FLOOR_USD, ATTESTATION_FEE_FLR × FLR_USD × MARKUP)
```

Defaults (all overridable via env):

| Variable | Default | Meaning |
|----------|---------|---------|
| `ATTESTATION_FEE_FLR` | `20` | FLR sent to FdcHub per mainnet attestation |
| `X402_FLOOR_USD` | `0.50` | Never charge less than this |
| `X402_MARKUP` | `3` | Multiplier on FLR cost in USD |
| `X402_PRICE_CACHE_TTL_MS` | `300000` | FTSO cache (5 minutes) |

FLR/USD and XRP/USD come from Flare's on-chain FTSO (`FtsoV2` via ContractRegistry). A stale cache is the only fallback. If there is no cache and the feed fails, pay-per-use **fails closed**: no quote, no attestation (`503 PRICE_UNAVAILABLE`). Subscription keys inside quota are unaffected.

**Example (mid-Oct 2026):** 20 FLR ≈ $0.14, markup 3 → $0.42, floor $0.50. Quote is **$0.50**. At XRP = $2 that is **250,000 drops** (0.25 XRP). RLUSD amount is the USD price as an issued-currency decimal (`"0.5"`).

XRP amounts are integer drops (`ceil`). RLUSD uses the XRPL issued-currency decimal string (not integer minor units).

## x402 flow (XRPL exact scheme, v2)

Facilitator: `XRPL_FACILITATOR_URL` (default `https://xrpl-facilitator-mainnet.t54.ai`), network `XRPL_NETWORK` (default `xrpl:0` mainnet).

1. Agent `POST /api/v1/verify/xrp-payment` with `{ "txHash": "..." }` and no payment.
2. Server returns **402** with header `PAYMENT-REQUIRED` (base64 JSON) and the same object in the body.
3. `accepts` lists `exact` requirements for native **XRP** and, if `X402_RLUSD_ISSUER` is set, **RLUSD**. Each entry has `payTo` from `X402_PAY_TO_ADDRESS`, `extra.areFeesSponsored=false`, `extra.assetTransferMethod=sequence`, and a unique `extra.invoiceId` bound to that `txHash`.
4. Agent signs an XRPL `Payment` (payer pays the XRPL fee; invoice binding is `InvoiceID = SHA-256(invoiceId)`).
5. Agent retries with `PAYMENT-SIGNATURE` (base64 `PaymentPayload`).
6. Server looks up the stored quote, calls facilitator **`/verify` then `/settle`**, and only then submits to FDC.
7. Success: HTTP **202** plus `PAYMENT-RESPONSE`. One settled payment = one attestation.

MCP `verify_xrp_payment` uses the same quotes. Unpaid calls return a JSON-RPC **tool error** (HTTP 200) that embeds `paymentRequired`. Retry the tool call with `PAYMENT-SIGNATURE`. Discovery (`initialize`, `tools/list`) stays unauthenticated.

## Idempotency and failed FDC

- Reusing a payment after a successful FDC submit is rejected (`409 PAYMENT_REPLAY` on REST).
- A payment is bound to one `txHash`; it cannot buy a different attestation.
- **Settle happens before FDC.** If FDC submit fails after settlement, the invoice is marked `fdc_failed`. The agent should **retry the same request with the same `PAYMENT-SIGNATURE`**. The server resubmits to FDC and does **not** settle again. The 500 body includes `retryWithoutRepayment: true` and the invoice id.

Quotes expire after 10 minutes. Ask for a new 402 if the quote is gone.

## What the operator must configure

Never hardcode a receiving wallet. Set these in the environment:

```
X402_ENABLED=true
X402_PAY_TO_ADDRESS=r...          # your XRPL classic address (required for pay-per-use)
XRPL_FACILITATOR_URL=https://xrpl-facilitator-mainnet.t54.ai
XRPL_NETWORK=xrpl:0
X402_RLUSD_ISSUER=rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De   # optional; omit to accept XRP only
X402_FLOOR_USD=0.50
X402_MARKUP=3
ATTESTATION_FEE_FLR=20
```

For facilitator testnet: `XRPL_FACILITATOR_URL=https://xrpl-facilitator-testnet.t54.ai` and `XRPL_NETWORK=xrpl:1`.

Subscription prices ($29 / $99) are unchanged.

## References

- [x402 docs](https://docs.x402.org)
- [XRPL x402 facilitator](https://xrpl-x402.t54.ai/)
- MCP Registry listing (not published from this change): `server.json` + `PUBLISHING.md`
