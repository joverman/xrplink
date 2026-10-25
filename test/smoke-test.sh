#!/bin/bash
# CI smoke test: verify the app boots in production mode and responds to /health
# This prevents crash-on-boot regressions like the Fly v29 incident.

set -e

# Production env with required secrets but NO verifier address (the crash scenario)
export NODE_ENV=production
export FLARE_NETWORK=flare
export SESSION_SECRET="ci-smoke-test-secret-32-chars!!"
export VERIFIER_API_KEY="ci-smoke-test-verifier-key-uuid"
export PRIVATE_KEY_FLARE="0x0000000000000000000000000000000000000000000000000000000000000001"
export START_API=true
# Deliberately NOT setting PAYMENT_VERIFIER_ADDRESS_FLARE to test the warning path

# Start the app in background
echo "Starting app with production config (no verifier address)..."
npx tsx src/index.ts &
APP_PID=$!

# Give it time to start (or crash)
sleep 5

# Check if process is still running
if ! kill -0 $APP_PID 2>/dev/null; then
    echo "❌ SMOKE TEST FAILED: App crashed on startup"
    wait $APP_PID
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
if echo "$HEALTH_RESPONSE" | grep -q '"status":"ok"'; then
    echo "✅ SMOKE TEST PASSED: App boots and /health responds"
else
    echo "❌ SMOKE TEST FAILED: /health response unexpected"
    kill $APP_PID 2>/dev/null || true
    exit 1
fi

# Cleanup
kill $APP_PID 2>/dev/null || true
wait $APP_PID 2>/dev/null || true

exit 0
