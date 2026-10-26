/**
 * Testnet dry run of the x402 quote + facilitator verify/settle path.
 *
 *   XRPL_NETWORK=xrpl:1 npx tsx scripts/x402-testnet-dry-run.ts
 *
 * Funds two XRPL testnet wallets via the public faucet when possible, builds a
 * quote with this repo's pricing code, signs an XRP Payment, and calls the t54
 * testnet facilitator /verify then /settle. No production keys are used.
 */
import crypto from "crypto";
import { Client, Wallet } from "xrpl";
import { defaultRlusdIssuer, isXrplTestnet, generateInvoiceId } from "../src/x402-service.js";
import { getAttestationPrice } from "../src/price-service.js";

const FACILITATOR =
  process.env.XRPL_FACILITATOR_URL || "https://xrpl-facilitator-testnet.t54.ai";
const NETWORK = process.env.XRPL_NETWORK || "xrpl:1";
const XRPL_WS = process.env.XRPL_TESTNET_WS || "wss://s.altnet.rippletest.net:51233";

async function probe(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.slice(0, 1200) };
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function fundWallet(client: Client): Promise<Wallet> {
  const funded = await client.fundWallet();
  if (!funded.wallet) throw new Error("Testnet faucet did not return a wallet");
  return funded.wallet;
}

async function main() {
  const result: Record<string, unknown> = {
    facilitator: FACILITATOR,
    network: NETWORK,
    isTestnet: isXrplTestnet(NETWORK),
    defaultRlusdIssuer: defaultRlusdIssuer(NETWORK),
    reachedFacilitator: false,
    supported: null,
    priceQuote: null,
    faucet: null,
    verify: null,
    settle: null,
  };

  const supported = await probe(`${FACILITATOR.replace(/\/$/, "")}/supported`);
  result.reachedFacilitator = supported.status > 0;
  result.supported = { status: supported.status, ok: supported.ok, body: supported.body };

  let price;
  try {
    price = await getAttestationPrice();
    result.priceQuote = {
      usd: price.usd,
      rlusd: price.rlusd,
      xrpDrops: price.xrpDrops,
      flrUsd: price.flrUsdRate,
      xrpUsd: price.xrpUsdRate,
      feeFlr: price.flrCost,
      source: price.priceSource,
    };
  } catch (err) {
    result.priceQuote = { error: err instanceof Error ? err.message : String(err) };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 2;
    return;
  }

  const client = new Client(XRPL_WS);
  try {
    await client.connect();
    const payer = await fundWallet(client);
    const merchant = await fundWallet(client);
    result.faucet = {
      ok: true,
      payer: payer.address,
      payTo: merchant.address,
    };

    const invoiceId = generateInvoiceId("dryrun");
    const invoiceHash = crypto.createHash("sha256").update(invoiceId).digest("hex").toUpperCase();
    const memoData = Buffer.from(invoiceId, "utf8").toString("hex").toUpperCase();
    const sourceTag = 804681468;
    const requirements = {
      scheme: "exact",
      network: NETWORK,
      asset: "XRP",
      payTo: merchant.address,
      amount: price.xrpDrops,
      maxTimeoutSeconds: 120,
      extra: {
        areFeesSponsored: false,
        assetTransferMethod: "sequence",
        invoiceId,
        sourceTag,
        resource: "/api/v1/verify/xrp-payment",
      },
    };

    const prepared = await client.autofill({
      TransactionType: "Payment",
      Account: payer.address,
      Destination: merchant.address,
      Amount: price.xrpDrops,
      InvoiceID: invoiceHash,
      SourceTag: sourceTag,
      NetworkID: 1,
      Memos: [{ Memo: { MemoData: memoData } }],
    });
    const signed = payer.sign(prepared);

    const payload = {
      x402Version: 2,
      accepted: requirements,
      payload: { signedTxBlob: signed.tx_blob },
    };

    const verify = await probe(`${FACILITATOR.replace(/\/$/, "")}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
    });
    let verifyValid = false;
    try {
      verifyValid = JSON.parse(verify.body).isValid === true;
    } catch {
      verifyValid = false;
    }
    result.verify = { status: verify.status, ok: verify.ok, valid: verifyValid, body: verify.body };

    if (verifyValid) {
      const settle = await probe(`${FACILITATOR.replace(/\/$/, "")}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
      });
      result.settle = { status: settle.status, ok: settle.ok, body: settle.body };
    } else {
      result.settle = "skipped (verify did not succeed)";
    }
  } catch (err) {
    result.faucet = { ok: false, error: err instanceof Error ? err.message : String(err) };
    result.settle = "not attempted (faucet or signing failed)";
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
  }

  console.log(JSON.stringify(result, null, 2));
  if (!result.reachedFacilitator) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
