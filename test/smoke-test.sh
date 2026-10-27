#!/bin/bash
# CI smoke test: verify the app boots in production mode and responds to /health
# This prevents crash-on-boot regressions like the Fly v29 incident.

set -e

# Minimal production config to catch regressions:
# - All-zeros VERIFIER_API_KEY is Flare's public key (valid for prod)
# - No PRIVATE_KEY_FLARE (receipt lookup works without it)
# - No PAYMENT_VERIFIER_ADDRESS_FLARE (on-chain verification is optional)
export NODE_ENV=production
export FLARE_NETWORK=flare
export SESSION_SECRET="ci-smoke-test-secret-32-chars!!"
export VERIFIER_API_KEY="00000000-0000-0000-0000-000000000000"
export START_API=true

# Create a FIFO to keep stdin open for MCP stdio server
FIFO=$(mktemp -u)
mkfifo "$FIFO"

# Start the app with stdin from FIFO (keeps MCP server alive)
echo "Starting app with production config (no verifier address)..."
npx tsx src/index.ts < "$FIFO" &
APP_PID=$!

# Keep FIFO open by opening it for writing in background
exec 3>"$FIFO"

cleanup() {
    exec 3>&-  # Close the FIFO write end
    rm -f "$FIFO"
    kill $APP_PID 2>/dev/null || true
    wait $APP_PID 2>/dev/null || true
}
trap cleanup EXIT

# Give it time to start (or crash)
sleep 5

# Check if process is still running
if ! kill -0 $APP_PID 2>/dev/null; then
    echo "❌ SMOKE TEST FAILED: App crashed on startup"
    exit 1
fi

# Hit the health endpoint
echo "Checking /health endpoint..."
HEALTH_RESPONSE=$(curl -sf http://localhost:3000/health || true)

if [ -z "$HEALTH_RESPONSE" ]; then
    echo "❌ SMOKE TEST FAILED: /health endpoint not responding"
    kill $APP_PID 2>/dev/null || true
    exit 1
fi

echo "Health response: $HEALTH_RESPONSE"

# Verify the response contains expected fields
if echo "$HEALTH_RESPONSE" | grep -q '"status":"online"'; then
    echo "✅ SMOKE TEST PASSED: App boots and /health responds"
    exit 0
else
    echo "❌ SMOKE TEST FAILED: /health response unexpected"
    exit 1
fi
