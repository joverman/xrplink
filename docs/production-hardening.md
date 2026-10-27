# XRPLink Production Hardening Guide

This document describes the production hardening measures implemented and the required configuration.

## Environment Variables

### Required in Production

These must be set before deploying to production. The app will refuse to start if they're missing or set to development defaults.

| Variable | Description | Example |
|----------|-------------|---------|
| `SESSION_SECRET` | Secret for JWT signing (min 32 chars) | `openssl rand -base64 32` |

The app starts without a funded Flare wallet or a dedicated verifier key (receipt lookup still works). New attestations need the Flare mainnet vars below.

### Flare mainnet attestation (`FLARE_NETWORK=flare`)

XRPLink does not take a verifier URL from env. With `FLARE_NETWORK=flare` it always calls:

- Verifier: `https://fdc-verifiers-mainnet.flare.network/verifier/xrp/XRPPayment/prepareRequest`
- Source ID: `XRP` (not `testXRP`)
- FdcHub: `0xc25c749DC27Efb1864Cb3DADa8845B7687eB2d44` (Flare mainnet)
- XRPL: mainnet (`s1.ripple.com` / `xrplcluster.com`)

Flare's `XRPPayment` type can only prove **native XRP Payments from the last 14 days** (`IXRPPayment` lutlimit `0x127500` = 1,209,600 seconds). Older hashes are still on XRPL; the hosted indexer returns `INVALID: TRANSACTION DOES NOT EXIST`. The API preflights XRPL and returns `TX_TOO_OLD` without calling FdcHub and without consuming monthly attestation quota.

| Variable | Required to attest? | Where to get it |
|----------|---------------------|-----------------|
| `FLARE_NETWORK` | Yes (`flare`) | Set to `flare`. Default in code is `coston2` (testnet verifier + `testXRP`). |
| `VERIFIER_API_KEY` | Recommended | Flare's public key `00000000-0000-0000-0000-000000000000` is documented on the [Network Overview](https://dev.flare.network/network/overview) and [FAQs](https://dev.flare.network/support/faqs). It is accepted on the hosted mainnet verifier. For higher DA Layer rate limits, open an API Key Request issue as linked from the FAQ. |
| `PRIVATE_KEY_FLARE` | Yes, for new attestations | Hex private key of a **Flare mainnet** (chain ID 14) wallet. Generate with `npm run wallet`. Fund it with enough FLR to pay FdcHub `requestAttestation` — default `SUBMIT_FEE_FLR` is `20` on flare. Without this, prepare may succeed and FdcHub submit will fail (`SUBMIT_FAILED`). Do not use a Coston2 faucet key here. |
| `SUBMIT_FEE_FLR` | No | Optional override of the FdcHub fee in FLR. Default `20` when `FLARE_NETWORK=flare`. |
| `PAYMENT_VERIFIER_ADDRESS_FLARE` | No | After you deploy `PaymentVerifierMainnet`, set the contract address (`0x` + 40 hex). Unset means proofs are fetched but not verified on-chain. Invalid format refuses boot. |
| `DATABASE_URL` | No | Postgres URL if you want durable storage. Unset uses JSON files under `DATA_DIR`. |
| `SESSION_SECRET` | Yes (boot) | `openssl rand -base64 32`. Unrelated to FDC; required for login cookies. |

Do **not** invent verifier URLs or API keys. `PAYMENT_VERIFIER_ADDRESS_FLARE` is not the FDC verifier — it is this app's optional on-chain contract.

### Optional (On-Chain Verification)

On-chain proof verification is disabled when this is not set. The app works without it (attestations are fetched and returned, but not verified on-chain). Deploy the PaymentVerifier contract and set this address to enable on-chain verification.

| Variable | Description | Example |
|----------|-------------|---------|
| `PAYMENT_VERIFIER_ADDRESS_FLARE` | Deployed PaymentVerifier contract | `0x...` (40 hex chars) |

**Note**: If set, the address must be a valid Ethereum address format (0x + 40 hex characters). An invalid format will cause a startup error.

### Required for Billing (Stripe)

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret API key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_AUTOMATIC_TAX` | Enable Stripe Tax (optional) | `false` |

### x402 pay-per-use

`X402_PAY_TO_ADDRESS` is the only pay-to setting. Do not hardcode a wallet. The receiving wallet must already hold an RLUSD trust line to the issuer (mainnet default `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`).

| Variable | Default | Meaning |
|----------|---------|---------|
| `X402_PAY_TO_ADDRESS` | unset | XRPL classic address that receives RLUSD/XRP |
| `X402_RLUSD_ISSUER` | mainnet `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`; testnet `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` | RLUSD issuer (overridable) |
| `X402_FLOOR_USD` | `2.50` | Minimum USD quote |
| `X402_CAP_USD` | `10.00` | Maximum USD quote |
| `X402_PRICE_STEP_USD` | `0.25` | Round USD price up to this step |
| `X402_MARKUP` | `3` | Multiplier on FLR cost |
| `X402_XRP_BUFFER` | `0.01` | Extra 1% on the XRP amount |
| `ATTESTATION_FEE_FLR` | `20` | Fallback FDC fee if the chain cannot be read |
| `X402_PRICE_REFRESH_MS` | `60000` | FTSO/Kraken refresh interval |
| `X402_PRICE_MAX_AGE_MS` | `300000` | Fail closed if the price is older than this |
| `X402_QUOTE_TTL_MS` | `120000` | Stored quote lifetime |
| `ATTESTATION_LIMIT_PAID` | `20` | Paid-tier mainnet attestations per billing period |
| `ATTESTATION_LIMIT_PRO` | `100` | Pro-tier mainnet attestations per billing period |

## Stripe Go-Live Checklist

Before switching from Stripe test mode to live mode:

### 1. Create Live Mode Prices

The app automatically creates prices with lookup keys if they don't exist:
- `xrplink_paid` — $29/month (Paid plan)
- `xrplink_pro` — $99/month (Pro plan)

In live mode, the app will create these prices when it starts if they don't exist.

### 2. Configure Webhook Endpoint

In the Stripe Dashboard → Developers → Webhooks:

1. Add endpoint: `https://your-domain.com/webhooks/stripe`
2. Select events to send:
   - `checkout.session.completed` — Initial subscription signup
   - `customer.subscription.updated` — Plan changes, status updates
   - `customer.subscription.deleted` — Subscription cancellations
   - `invoice.payment_failed` — Failed payment attempts
   - `invoice.paid` — Successful payments (clears past_due status)

3. Copy the webhook signing secret to `STRIPE_WEBHOOK_SECRET`

### 3. Enable Customer Portal (Auto-Configured)

The app automatically creates a billing portal configuration if none exists:
- Cancel subscription at period end
- Update payment method
- View invoice history
- Switch between Paid and Pro plans

### 4. Set Environment Variables

```bash
# Live mode keys
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Optional: Enable automatic tax collection
STRIPE_AUTOMATIC_TAX=true
```

### 5. Test the Live Integration

1. Create a test subscription using a real card
2. Verify webhook events are received
3. Test cancellation via customer portal
4. Verify downgrade to free tier works

### Subscription Status Handling

| Stripe Event | App Action |
|-------------|------------|
| `checkout.session.completed` | Upgrade user from the Stripe price lookup key (`xrplink_paid` → paid, `xrplink_pro` → pro). Unknown prices and `metadata.tier` / `?upgraded=` are ignored. |
| `customer.subscription.updated` | Sync tier from price lookup_key, update status |
| `customer.subscription.deleted` | Downgrade to free tier, set status=canceled |
| `invoice.payment_failed` | Set status=past_due (grace period until Stripe retries end) |
| `invoice.paid` | Clear past_due status, set status=active |

Users in `past_due` status retain their tier during Stripe's automatic retry period. If all retries fail, Stripe cancels the subscription and the user is downgraded to free.

### Recommended for Production

| Variable | Description | Default |
|----------|-------------|---------|
| `ADMIN_API_KEY` | Operator secret for `/api/v1/admin/*`, sent as `X-Admin-Key`. Customer API keys of any tier (including Pro) never grant admin. Unset disables admin routes (404). Generate with `openssl rand -hex 32`. | unset (admin disabled) |
| `DATABASE_URL` | Postgres connection string (Neon) | JSON file storage |
| `WEBHOOK_SIGNING_SECRET` | Secret for signing outbound webhooks | (none - webhooks unsigned) |
| `RESEND_API_KEY` | Resend API key for emails | (emails disabled) |

API keys are stored as SHA-256 hashes. List endpoints return only a masked prefix and last 4. A logged-in user can regenerate their own key from the dashboard (`POST /api/v1/keys/rotate`, session cookie + same-origin). The dashboard Verify box attests via `POST /api/v1/dashboard/verify` using the session, not a key pasted into the browser.

### Application Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `FLARE_NETWORK` | Network: `coston2` or `flare` | `coston2` |
| `PORT` | HTTP port | `3000` |
| `HOST` | Bind address | `0.0.0.0` |
| `NODE_ENV` | Environment | `development` |
| `DATA_DIR` | JSON storage directory (must be writable; users, API keys, attestations) | `data` |
| `DOMAIN` | Base URL for callbacks | `https://xrp-link.com` |
| `TRUST_PROXY` | Trust proxy headers (see below) | `loopback,linklocal,uniquelocal` |

### TRUST_PROXY Security

The `TRUST_PROXY` setting controls which proxy headers (X-Forwarded-For, CF-Connecting-IP) the app trusts for determining the real client IP address. This affects rate limiting and access logging.

**Default: `loopback,linklocal,uniquelocal`** — Only trust proxies on loopback (127.0.0.1), link-local (169.254.x.x), and private network ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x).

**Options:**
- `loopback,linklocal,uniquelocal` (default): Safe for most setups. Trusts proxies on private networks only.
- `true` or `1`: Trust ALL proxy headers. **Only use if cloudflared/nginx is on the same Docker network AND you trust all containers on that network.** Malicious containers could spoof client IPs.
- `false` or `0`: Don't trust any proxy headers. Use if exposing directly to the internet (not recommended).
- Specific IP/CIDR: e.g., `172.17.0.1` to trust only the Docker gateway.

**Cloudflare Tunnel recommendation**: The default (`loopback,linklocal,uniquelocal`) works because cloudflared typically runs on localhost or a private Docker network. The app prefers `CF-Connecting-IP` (set by Cloudflare) over `X-Forwarded-For`.

## Self-Hosting with Docker + Cloudflare Tunnel

XRPLink can be self-hosted on any server using Docker and Cloudflare Tunnel for HTTPS.

### Prerequisites

- Docker and Docker Compose
- A Cloudflare account with a domain
- Cloudflare Tunnel (cloudflared) installed

### Quick Start

1. **Clone and configure:**
   ```bash
   git clone https://github.com/joverman/xrplink.git
   cd xrplink
   
   # Create .env file with your secrets
   cat > .env << EOF
   SESSION_SECRET=$(openssl rand -base64 32)
   VERIFIER_API_KEY=your-fdc-api-key
   PRIVATE_KEY_FLARE=0x...your-wallet-private-key
   EOF
   ```

2. **Start the container:**
   ```bash
   docker compose up -d
   ```

3. **Configure Cloudflare Tunnel:**
   ```bash
   # Create tunnel (one-time)
   cloudflared tunnel create xrplink
   
   # Configure tunnel to point to XRPLink
   cat > ~/.cloudflared/config.yml << EOF
   tunnel: xrplink
   credentials-file: /root/.cloudflared/<tunnel-id>.json
   
   ingress:
     - hostname: xrp-link.com
       service: http://localhost:3000
     - hostname: www.xrp-link.com
       service: http://localhost:3000
     - service: http_status:404
   EOF
   
   # Route DNS
   cloudflared tunnel route dns xrplink xrp-link.com
   cloudflared tunnel route dns xrplink www.xrp-link.com
   
   # Run tunnel (or install as service)
   cloudflared tunnel run xrplink
   ```

4. **Verify:**
   ```bash
   curl https://xrp-link.com/health
   ```

### Docker Compose Reference

```yaml
services:
  xrplink:
    build: .
    container_name: xrplink
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"  # Only expose to localhost
    volumes:
      - xrplink_data:/app/data
    environment:
      - PORT=3000
      - NODE_ENV=production
      - FLARE_NETWORK=flare
      # TRUST_PROXY defaults to loopback,linklocal,uniquelocal (safe)
      # Set to "true" only if cloudflared is in a trusted Docker network
      - SESSION_SECRET=${SESSION_SECRET}
      - VERIFIER_API_KEY=${VERIFIER_API_KEY}
      - PRIVATE_KEY_FLARE=${PRIVATE_KEY_FLARE}

volumes:
  xrplink_data:
```

### Proxy Headers

The app automatically trusts proxy headers when `TRUST_PROXY=true`:

- **CF-Connecting-IP**: Real client IP from Cloudflare (preferred)
- **X-Forwarded-For**: Standard proxy header (fallback)
- **X-Forwarded-Proto**: Protocol (http/https)

Rate limiting and logging use the real client IP, not the tunnel's IP.

### Persistent Data

Data is stored in `/app/data` inside the container. Mount a volume to persist:

```yaml
volumes:
  - ./data:/app/data        # Bind mount
  # or
  - xrplink_data:/app/data  # Named volume
```

For production, consider using PostgreSQL instead (`DATABASE_URL`).

Login sessions are JWTs in an httpOnly `xrplink_session` cookie (30 days, rolling, SameSite=Lax). Each JWT carries a `sv` session version that must match `sessionVersion` on the user record in `users.json`. Logout, password reset, and API key rotation increment that version so outstanding cookies (and Bearer tokens) stop working. Pre-`sv` cookies remain valid until the first revocation bump (a one-time re-login is only required after those events, or if `SESSION_SECRET` changes). Password-reset links are opaque single-use secrets, stored as SHA-256, bound to password reset only, and expire in 1 hour. No new env var is required.

If the container root filesystem is read-only, keep `DATA_DIR=/app/data` mounted read-write. User accounts used to be written to a relative `data/` path that could miss that volume.

## Fly.io Configuration

The `fly.toml` is configured for scale-to-zero (currently self-hosting):

- **Scale-to-zero**: `min_machines_running = 0`, machines stop when idle
- **Auto-start**: `auto_start_machines = true`, starts on incoming requests
- **Health checks**: HTTP health check on `/health` (kept for easy return to Fly)

To switch to always-on when customers arrive:
```toml
auto_stop_machines = 'off'
min_machines_running = 1
```

### CI/CD and Fly Deployment

The GitHub Actions workflow runs tests on every push/PR but **does not auto-deploy**. Fly deployment is manual only (`workflow_dispatch`) while self-hosting.

To deploy to Fly manually:
1. Go to Actions → Fly Deploy → Run workflow
2. Or: `flyctl deploy` locally

To re-enable auto-deploy on push to main, edit `.github/workflows/fly-deploy.yml`:
```yaml
# Change this:
if: github.event_name == 'workflow_dispatch'
# To this:
if: github.ref == 'refs/heads/main' && github.event_name == 'push'
```

## Storage Options

### JSON File Storage (Default)

When `DATABASE_URL` is not set, data is stored in JSON files on the Fly volume at `/app/data/`. Writes are atomic (write to temp file, then rename) to prevent corruption.

### PostgreSQL (Recommended)

Set `DATABASE_URL` to use Postgres (Neon recommended):

```bash
# Example Neon connection string
fly secrets set DATABASE_URL="postgres://user:pass@host.neon.tech/dbname?sslmode=require"
```

### Migrating from JSON to Postgres

1. SSH into the Fly machine: `fly ssh console`
2. Run the migration: `tsx scripts/migrate-to-postgres.ts`

The migration is idempotent and can be run multiple times safely.

## Webhook Security

Outbound webhooks now include:

- **HMAC signatures**: `X-Webhook-Signature: sha256=...` header
- **Timestamps**: `X-Webhook-Timestamp` for replay protection
- **HTTPS-only**: HTTP webhooks rejected
- **Per-key, per-attestation**: the caller must own `attestationId`; global (`null`) hooks are disabled; max 10 active hooks per key
- **SSRF protection**: DNS is resolved at register and delivery; private, loopback, link-local, IPv4-mapped, and decimal hosts are blocked; redirects are not followed
- **Retries**: 3 attempts with exponential backoff (1s, 2s, 4s)

### Verifying Webhook Signatures

```javascript
const crypto = require('crypto');

function verifySignature(payload, signature, timestamp, secret) {
  const signedPayload = `${timestamp}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// In your webhook handler:
const signature = req.headers['x-webhook-signature'].replace('sha256=', '');
const timestamp = parseInt(req.headers['x-webhook-timestamp']);
const body = JSON.stringify(req.body);

if (!verifySignature(body, signature, timestamp, process.env.WEBHOOK_SECRET)) {
  return res.status(401).send('Invalid signature');
}

// Reject old signatures (>5 minutes)
if (Math.abs(Date.now() / 1000 - timestamp) > 300) {
  return res.status(401).send('Timestamp too old');
}
```

## XRPL Endpoints

The app now uses multiple XRPL endpoints with automatic failover:

1. `https://s1.ripple.com:51234` (primary)
2. `https://s2.ripple.com:51234` (secondary)
3. `https://xrplcluster.com` (fallback)

## CI/CD

The GitHub Actions workflow:

1. **On every push/PR**: Runs typecheck, compiles contracts, runs tests
2. **On manual dispatch only**: Deploys to Fly.io (merging does NOT auto-deploy)

This allows safe development while self-hosting via Docker.

## Rollout Checklist (Self-Hosting)

### Docker Deployment

1. **Set up secrets** in `.env`:
   ```bash
   SESSION_SECRET=$(openssl rand -base64 32)
   VERIFIER_API_KEY=your-fdc-api-key
   PRIVATE_KEY_FLARE=0x...
   ```

2. **Start container**:
   ```bash
   docker compose up -d
   ```

3. **Configure Cloudflare Tunnel** to point to `http://localhost:3000`

4. **Verify**:
   ```bash
   curl https://xrp-link.com/health
   ```

### Returning to Fly.io

When customers arrive and you want to return to Fly:

1. **Set Fly secrets**:
   ```bash
   fly secrets set SESSION_SECRET="..."
   fly secrets set VERIFIER_API_KEY="..."
   fly secrets set PRIVATE_KEY_FLARE="..."
   ```

2. **Update fly.toml** for always-on:
   ```toml
   auto_stop_machines = 'off'
   min_machines_running = 1
   ```

3. **Re-enable auto-deploy** in `.github/workflows/fly-deploy.yml`:
   ```yaml
   if: github.ref == 'refs/heads/main' && github.event_name == 'push'
   ```

4. **Deploy manually** (first time):
   ```bash
   flyctl deploy
   ```

5. **Update DNS** from Cloudflare Tunnel to Fly.io

### Enabling On-Chain Verification

Once the PaymentVerifier contract is deployed on Flare mainnet:

```bash
# Docker
echo "PAYMENT_VERIFIER_ADDRESS_FLARE=0x..." >> .env
docker compose up -d

# Or Fly
fly secrets set PAYMENT_VERIFIER_ADDRESS_FLARE="0x..."
```

Until set, attestations are fetched but not verified on-chain. Public `/health` is liveness-only (`{"status":"ok"}`).

### Rollback Plan

**Docker**: Stop container, fix issue, restart
```bash
docker compose down
# fix
docker compose up -d
```

**Fly**: Revert commit on `main`, Fly restores previous deployment
