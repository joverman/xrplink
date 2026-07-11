# XRPLink Demo Plan — All Three

## Prerequisites
- Server built and tested
- Wallet has ~97 test FLR remaining
- Bootstrap API key will be generated

---

## Demo A: Dashboard Walkthrough (5 min)

### Steps

1. **Start the combined server**
   ```bash
   npm start
   ```
   (Launches MCP + REST)

2. **Bootstrap API key** (write key file before server starts)
   ```bash
   node --input-type=module -e "
   import {v4 as uuid} from 'uuid';
   import {writeFileSync,mkdirSync} from 'fs';
   mkdirSync('data',{recursive:true});
   const k='sk_live_'+uuid().replace(/-/g,'')+uuid().replace(/-/g,'');
   writeFileSync('data/api-keys.json',JSON.stringify({[k]:{key:k,name:'demo',tier:'pro',active:true,usageCount:0,createdAt:new Date().toISOString()}},null,2));
   console.log(k);
   "
   ```

3. **Open dashboard** in browser: `http://localhost:3000/dashboard`
   - Shows 0 attestations, 0 verified, 1 API key, 0 requests

4. **Submit the existing verified tx** (cached hit):
   ```bash
   curl -s -X POST http://localhost:3000/api/v1/verify/xrp-payment \
     -H "Content-Type: application/json" \
     -H "X-API-Key: $KEY" \
     -d '{"txHash":"388076B7245A60A13D6A764C8D0B5919F8A77E04E720C32CA1E30E9B7A291F22"}'
   ```
   → Returns `verified` (on-chain cache hit)
   → Dashboard updates: 1 attestation, 1 verified, 1 key, 1 request

5. **Test enriched errors:**
   ```bash
   # Missing key
   curl -s -X POST http://localhost:3000/api/v1/verify/xrp-payment \
     -H "Content-Type: application/json" \
     -d '{"txHash":"388076B7245A60A13D6A764C8D0B5919F8A77E04E720C32CA1E30E9B7A291F22"}'
   # → MISSING_API_KEY with suggestedAction

   # Bad hash
   curl -s -X POST http://localhost:3000/api/v1/verify/xrp-payment \
     -H "Content-Type: application/json" \
     -H "X-API-Key: $KEY" \
     -d '{"txHash":"bad"}'
   # → INVALID_TX_HASH with suggestedAction
   ```

6. **Update white-label branding:**
   ```bash
   curl -s -X PUT http://localhost:3000/api/v1/admin/white-label \
     -H "Content-Type: application/json" \
     -H "X-API-Key: $KEY" \
     -d '{"brandName":"My Demo","primaryColor":"#8b5cf6"}'
   ```
   → Refresh dashboard → brand header changes to purple

7. **Show MCP resources over HTTP:**
   ```bash
   curl -s http://localhost:3000/mcp/resources | python3 -m json.tool
   curl -s http://localhost:3000/mcp/prompts | python3 -m json.tool
   ```
   → Shows 5 resources and 4 prompts as JSON

### Expected Output
- Dashboard shows real-time stats
- Enriched errors guide the user
- White-label branding is configurable
- MCP resources are discoverable

---

## Demo B: MCP Agent Demo (5 min)

### Setup
The MCP server is already running on stdio. We can interact with it directly.

### Steps

1. **List tools**
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \
     npx tsx src/mcp-server.ts 2>/dev/null | python3 -m json.tool
   ```
   → Shows 5 tools with descriptions

2. **Discover resources**
   ```bash
   echo '{"jsonrpc":"2.0","id":2,"method":"resources/list","params":{}}' | \
     npx tsx src/mcp-server.ts 2>/dev/null | python3 -m json.tool
   ```
   → Shows 5 resources agent can read

3. **Read config documentation**
   ```bash
   echo '{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"xrplink://docs/config"}}' | \
     npx tsx src/mcp-server.ts 2>/dev/null
   ```
   → Returns markdown with config schema

4. **Get prompt guidance**
   ```bash
   echo '{"jsonrpc":"2.0","id":4,"method":"prompts/get","params":{"name":"verify_flow"}}' | \
     npx tsx src/mcp-server.ts 2>/dev/null | python3 -m json.tool
   ```
   → Returns step-by-step verification guide

5. **Verify a payment (cached)**
   ```bash
   echo '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"verify_xrp_payment","arguments":{"txHash":"388076B7245A60A13D6A764C8D0B5919F8A77E04E720C32CA1E30E9B7A291F22"}}}' | \
     npx tsx src/mcp-server.ts 2>/dev/null
   ```
   → Returns "already verified" with details

6. **Get server info**
   ```bash
   echo '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_server_info","arguments":{}}}' | \
     npx tsx src/mcp-server.ts 2>/dev/null | python3 -m json.tool
   ```
   → Shows brand, network, contracts, uptime

### Expected Output
- Agent can discover all capabilities
- Tools return structured data
- Resources provide self-documentation
- Prompts guide the agent through workflows

---

## Demo C: Full Pipeline Demo (15 min — requires 90s wait)

### Prerequisites
- Wallet has test FLR (currently ~97 FLR, 1 FLR per attestation)
- XRP testnet is accessible
- Need to prepare + submit a new attestation

### Steps

1. **Check wallet balance**
   ```bash
   npx tsx scripts/check-balance.ts
   ```
   → Should show ~97 test FLR

2. **Send a new XRP testnet transaction** (creates a fresh tx to attest)
   ```bash
   npx tsx scripts/send-xrp-test.ts
   ```
   → Generates new wallets, sends 1 XRP with memo, saves txHash to .env
   → Outputs: "Transaction hash: XXXXX..."

3. **Prepare attestation request** (via verifier API)
   ```bash
   npx tsx scripts/prepare-request.ts
   ```
   → Should return VALID
   → Saves ABI_ENCODED_REQUEST to .env

4. **Submit via API** (NOT the script — use the API to show polling)
   ```bash
   TX_HASH=$(grep XRP_TX_HASH .env | cut -d= -f2)
   curl -s -X POST http://localhost:3000/api/v1/verify/xrp-payment \
     -H "Content-Type: application/json" \
     -H "X-API-Key: $KEY" \
     -d "{\"txHash\":\"$TX_HASH\"}"
   ```
   → Returns 202 with `id` and `roundId`
   → Dashboard shows status: "pending"

5. **Watch dashboard** — refresh every 30s
   - Pending → polls DA Layer
   - After ~90-120s → Ready → Verified
   - Dashboard shows: status changes, round ID, verified tx hash

6. **Check status via API**
   ```bash
   ATT_ID=<id from step 4>
   curl -s http://localhost:3000/api/v1/status/$ATT_ID \
     -H "X-API-Key: $KEY"
   ```
   → Shows full attestation with proof and verification tx hash

7. **Verify MCP tool works with new attestation**
   ```bash
   echo "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"lookup_attestation_by_tx\",\"arguments\":{\"txHash\":\"$TX_HASH\"}}}" | \
     npx tsx src/mcp-server.ts 2>/dev/null
   ```
   → Finds the attestation, shows full record

### Expected Output
- Fresh XRP tx attested through the full FDC pipeline
- Status transitions visible in dashboard
- Proof retrieved from DA Layer
- On-chain verification via PaymentVerifier
- MCP tool can look up the result

---

## Timing Summary

| Demo | Time | Key thing to watch |
|------|------|-------------------|
| A: Dashboard walkthrough | 5 min | Stats updating, enriched errors, white-label |
| B: MCP agent demo | 5 min | Tool discovery, resource reading, server info |
| C: Full pipeline | 15 min | Status transitions: pending → ready → verified |
| **Total** | **~25 min** | |

---

## What to Prepare Before Starting

1. Confirm test FLR balance (`npm run check-balance`)
2. Have a browser ready at `http://localhost:3000/dashboard`
3. Have a terminal split into panes for server + API calls
4. The `xrpl` npm package is already installed (for `send-xrp-test.ts`)
