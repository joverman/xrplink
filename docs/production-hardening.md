# XRPLink Production Hardening Guide

This document describes the production hardening measures implemented and the required configuration.

## Environment Variables

### Required in Production

These must be set before deploying to production. The app will refuse to start if they're missing or set to development defaults.

| Variable | Description | Example |
|----------|-------------|---------|
| `SESSION_SECRET` | Secret for JWT signing (min 32 chars) | `openssl rand -base64 32` |
| `VERIFIER_API_KEY` | Flare Data Connector API key | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `PRIVATE_KEY_FLARE` | Wallet private key for Flare mainnet | `0x...` (64 hex chars) |

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

### Recommended for Production

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | Postgres connection string (Neon) | JSON file storage |
| `WEBHOOK_SIGNING_SECRET` | Secret for signing outbound webhooks | (none - webhooks unsigned) |
| `RESEND_API_KEY` | Resend API key for emails | (emails disabled) |

### Application Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `FLARE_NETWORK` | Network: `coston2` or `flare` | `coston2` |
| `PORT` | HTTP port | `3000` |
| `NODE_ENV` | Environment | `development` |
| `DATA_DIR` | JSON storage directory | `data` |
| `DOMAIN` | Base URL for callbacks | `https://xrp-link.com` |

## Fly.io Configuration

The `fly.toml` has been updated with:

- **Always-on**: `min_machines_running = 1` keeps one machine running to preserve in-memory rate limits
- **Health checks**: HTTP health check on `/health` every 30 seconds
- **Auto-stop disabled**: `auto_stop_machines = 'off'` prevents cold starts

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
- **HTTPS-only**: HTTP webhooks blocked in production
- **SSRF protection**: Private IPs, metadata endpoints, and loopback addresses blocked
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

The GitHub Actions workflow now:

1. Runs `npm ci` to install dependencies
2. Runs `npx tsc --noEmit` to typecheck
3. Runs `npx hardhat compile` to compile contracts
4. Runs `npm test` to execute tests
5. Only deploys to Fly.io if all above pass

## Rollout Checklist

### Before Merging

1. Create a Neon Postgres database (optional but recommended)
2. Generate new secrets:
   ```bash
   # Generate SESSION_SECRET
   openssl rand -base64 32
   
   # Generate WEBHOOK_SIGNING_SECRET
   openssl rand -base64 32
   ```

### Setting Fly Secrets (BEFORE deploying)

```bash
# Required for startup
fly secrets set SESSION_SECRET="<your-32-char-secret>"
fly secrets set VERIFIER_API_KEY="<your-fdc-api-key>"
fly secrets set PRIVATE_KEY_FLARE="<your-wallet-private-key>"

# Recommended
fly secrets set DATABASE_URL="postgres://..."
fly secrets set WEBHOOK_SIGNING_SECRET="<your-webhook-secret>"

# For billing
fly secrets set STRIPE_SECRET_KEY="sk_live_..."
fly secrets set STRIPE_WEBHOOK_SECRET="whsec_..."

# For emails
fly secrets set RESEND_API_KEY="re_..."
```

### After Setting Secrets

1. Merge the PR to `main`
2. CI will run tests and deploy
3. Verify the health endpoint: `curl https://xrp-link.com/health`
4. If using Postgres, migrate existing data:
   ```bash
   fly ssh console
   cd /app
   tsx scripts/migrate-to-postgres.ts
   ```

### Enabling On-Chain Verification (Separate Step)

Once the PaymentVerifier contract is deployed on Flare mainnet:

```bash
fly secrets set PAYMENT_VERIFIER_ADDRESS_FLARE="<deployed-contract-address>"
```

Until this is set, attestations will be fetched from the FDC but not verified on-chain. The `/health` endpoint will show `paymentVerifier: "not configured"`.

### Rollback Plan

If issues occur:
1. Revert the commit on `main`
2. Previous deployment will be restored by Fly
3. JSON storage will continue working (no data loss)
