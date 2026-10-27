# XRPLink x402 Pay-Per-Attestation

AI agents can attest an XRP payment without a subscription by paying once on the XRP Ledger using the [x402](https://docs.x402.org) protocol and the hosted XRPL facilitator at `https://xrpl-facilitator-mainnet.t54.ai` (RLUSD or XRP).

Each Flare mainnet attestation costs the operator **20 FLR** unless the on-chain FDC fee is higher. Pricing is FLR-linked, floored, capped, and rounded up to a price step.

## When payment is required

| Caller | Result |
|--------|--------|
| Subscription API key **inside** monthly quota | Attest as before. Never asked to pay. |
| No API key | HTTP **402** with x402 `PAYMENT-REQUIRED` (REST) or an MCP tool error containing the same quote |
| Invalid API key | Same 402 quote (REST). MCP still never returns HTTP 403. |
| Key **over quota** | 402 quote plus quota details and an upgrade prompt (Paid → Pro). Pay once for an extra attestation, upgrade, or wait for the billing-period reset. |
| Cached / already-on-chain attestation | Free. No quota, no x402. |

Status, lookup, health, `initialize`, and `tools/list` stay free. `/mcp` never returns HTTP 403 for auth (Smithery/Glama treat 403 as a dead server).

## Pricing

```
price_usd = clamp(max(floor, fee_flr × FLR/USD × markup), floor, cap)
price_usd = round_up(price_usd, step)
```

Defaults (all overridable via env):

| Variable | Default | Meaning |
|----------|---------|---------|
| `ATTESTATION_FEE_FLR` | `20` | Fallback FLR sent to FdcHub if the on-chain fee cannot be read |
| `X402_FLOOR_USD` | `2.50` | Never charge less than this |
| `X402_MARKUP` | `3` | Multiplier on FLR cost in USD |
| `X402_CAP_USD` | `10.00` | Never charge more than this |
| `X402_PRICE_STEP_USD` | `0.25` | Round the USD price **up** to this increment |
| `X402_XRP_BUFFER` | `0.01` | Extra 1% on the XRP amount to cover price movement |
| `X402_PRICE_REFRESH_MS` | `60000` | How often to refresh FTSO / Kraken |
| `X402_PRICE_MAX_AGE_MS` | `300000` | Quotes fail closed if the best price is older than this |
| `X402_QUOTE_TTL_MS` | `120000` | Stored quote lifetime (120s) |

The FDC attestation fee is read from `FdcRequestFeeConfigurations.getRequestFee` (type `XRPPayment` + current source id) when the chain is reachable. If that call fails, `ATTESTATION_FEE_FLR` is used.

FLR/USD and XRP/USD come from Flare's on-chain FTSO (`FtsoV2` via ContractRegistry). [Kraken's public FLRUSD/XRPUSD ticker](https://api.kraken.com/0/public/Ticker?pair=FLRUSD,XRPUSD) is the fallback. If both sources are stale or unavailable, pay-per-use **fails closed**: no quote, no attestation (`503 PRICE_UNAVAILABLE`). Subscription keys inside quota are unaffected.

**Example:** 20 FLR × $0.007 × 3 = $0.42 → floor **$2.50**. At XRP = $2 with a 1% buffer that is **1.2625 XRP** (1,262,500 drops). RLUSD amount is the USD price as an issued-currency decimal (`"2.5"`).

XRP amounts are integer drops (`ceil` after the buffer). RLUSD uses the XRPL issued-currency decimal string (not integer minor units).

## Payment assets

`accepts` always lists **RLUSD first**, then **XRP**.

| Network | Default RLUSD issuer | Source |
|---------|----------------------|--------|
| Mainnet (`xrpl:0`) | `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` | [Ripple token addresses](https://docs.ripple.com/products/stablecoin/overview/token-addresses) |
| Testnet (`xrpl:1`) | `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` | [RLUSD on the XRPL](https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl) |

Override with `X402_RLUSD_ISSUER`. Production previously omitted this env var, so live quotes listed XRP only. The default now includes RLUSD without setting the var.

**The `X402_PAY_TO_ADDRESS` wallet must already hold an RLUSD trust line to the issuer in use.** Without that trust line, RLUSD payments to the merchant fail on ledger. James's current mainnet wallet already has a trust line to `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`. Any new business hot wallet needs the same trust line before deploy.

## x402 flow (XRPL exact scheme, v2)

Facilitator: `XRPL_FACILITATOR_URL` (default `https://xrpl-facilitator-mainnet.t54.ai`), network `XRPL_NETWORK` (default `xrpl:0` mainnet).

1. Agent `POST /api/v1/verify/xrp-payment` with `{ "txHash": "..." }` and no payment.
2. Server returns **402** with header `PAYMENT-REQUIRED` (base64 JSON) and the same object in the body.
3. `accepts` lists `exact` requirements for **RLUSD** then native **XRP**. Each entry has `payTo` from `X402_PAY_TO_ADDRESS`, `extra.areFeesSponsored=false`, `extra.assetTransferMethod=sequence`, and a unique `extra.invoiceId` bound to that `txHash`.
4. Agent signs an XRPL `Payment` (payer pays the XRPL fee; invoice binding is `InvoiceID = SHA-256(invoiceId)`).
5. Agent retries with `PAYMENT-SIGNATURE` (base64 `PaymentPayload`).
6. Server looks up the stored quote, calls facilitator **`/verify` then `/settle`**, and only then submits to FDC.
7. Success: HTTP **202** plus `PAYMENT-RESPONSE`. One settled payment = one attestation.

MCP `verify_xrp_payment` uses the same quotes. Unpaid calls return a JSON-RPC **tool error** (HTTP 200) that embeds `paymentRequired`. Retry the tool call with `PAYMENT-SIGNATURE`. Discovery (`initialize`, `tools/list`) stays unauthenticated.

## Idempotency and failed FDC

- Reusing a payment after a successful FDC submit is rejected (`409 PAYMENT_REPLAY` on REST).
- A payment is bound to one `txHash`; it cannot buy a different attestation.
- **Settle happens before FDC.** If FDC submit fails after settlement, the invoice is marked `fdc_failed`. The agent should **retry the same request with the same `PAYMENT-SIGNATURE`**. The server resubmits to FDC and does **not** settle again. The 500 body includes `retryWithoutRepayment: true` and the invoice id.

Quotes expire after 120 seconds (`X402_QUOTE_TTL_MS`). Ask for a new 402 if the quote is gone.

## Logging and margin

Every issued quote and every settled payment is appended to `data/x402-ledger.json` (JSON file storage; `DATABASE_URL` is unset in production). Events are linkable by `invoiceId`. Logs include time, asset, amount, USD price, FLR/USD used, and fee FLR. No customer names.

Daily margin (revenue USD vs FLR cost) is available only with the server `ADMIN_API_KEY` sent as `X-Admin-Key`. Customer API keys of any tier, including Pro, are rejected.

```
GET /api/v1/admin/x402-margin
GET /api/v1/admin/x402-margin?date=2026-10-26
GET /api/v1/admin/x402-margin?from=2026-10-01&to=2026-10-26
```

Or run `npx tsx scripts/x402-margin.ts [--date YYYY-MM-DD]`.

## What the operator must configure

Never hardcode a receiving wallet. Set these in the environment:

```
X402_ENABLED=true
X402_PAY_TO_ADDRESS=r...          # business hot wallet (required for pay-per-use)
XRPL_FACILITATOR_URL=https://xrpl-facilitator-mainnet.t54.ai
XRPL_NETWORK=xrpl:0
# X402_RLUSD_ISSUER defaults by network; override only if needed
X402_FLOOR_USD=2.50
X402_MARKUP=3
X402_CAP_USD=10.00
X402_PRICE_STEP_USD=0.25
X402_XRP_BUFFER=0.01
ATTESTATION_FEE_FLR=20
X402_PRICE_REFRESH_MS=60000
X402_PRICE_MAX_AGE_MS=300000
X402_QUOTE_TTL_MS=120000
```

`X402_PAY_TO_ADDRESS` is the **only** pay-to setting. Set the new business hot wallet address before or at deploy. Confirm that wallet has an RLUSD trust line to the issuer above.

For facilitator testnet: `XRPL_FACILITATOR_URL=https://xrpl-facilitator-testnet.t54.ai` and `XRPL_NETWORK=xrpl:1`. Testnet RLUSD issuer defaults to `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`.

Subscription prices ($29 / $99) are unchanged. Allowances are Paid **20** and Pro **100** mainnet attestations per billing period (env overrides still work). Existing subscribers are not migrated or charged; they simply receive the higher default limits after deploy.

## References

- [x402 docs](https://docs.x402.org)
- [XRPL x402 facilitator](https://xrpl-x402.t54.ai/)
- [Ripple RLUSD token addresses](https://docs.ripple.com/products/stablecoin/overview/token-addresses)
- MCP Registry listing: `server.json` + `PUBLISHING.md`
