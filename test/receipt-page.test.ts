/**
 * Public receipt page: site theme, share/print, contract fallback, round formatting.
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32-chars-min!!";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.FLARE_NETWORK = process.env.FLARE_NETWORK || "flare";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "xrplink-receipt-"));
process.env.X402_ENABLED = "false";
delete process.env.X402_PAY_TO_ADDRESS;
delete process.env.DATABASE_URL;
delete process.env.PAYMENT_VERIFIER_ADDRESS;
delete process.env.PAYMENT_VERIFIER_ADDRESS_FLARE;
delete process.env.PAYMENT_VERIFIER_ADDRESS_COSTON2;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FDC_VERIFICATION_FLARE = "0x9394c7A36b3Da8de1b4F27cdD0a554dA4Fa7132d";
const TX_HASH = "288D7FA491A5AB3769A0627E3E49D822BFE3DEF427E21C2256827A35F855DC49";

const SAMPLE_PROOF = {
  response: {
    attestationType: "0x",
    sourceId: "0x",
    votingRound: "1496278",
    lowestUsedTimestamp: "0",
    requestBody: { transactionId: "0x00", proofOwner: "0x00" },
    responseBody: {
      blockNumber: "1",
      blockTimestamp: "1",
      sourceAddress: "rL7pkkJpNTJUTPcrYeWm9Sav9oJH8kXMRR",
      sourceAddressHash: "0x00",
      receivingAddressHash: "0x00",
      intendedReceivingAddressHash: "0x00",
      spentAmount: "2000000",
      intendedSpentAmount: "2000000",
      receivedAmount: "2000000",
      intendedReceivedAmount: "2000000",
      hasMemoData: false,
      firstMemoData: "",
      hasDestinationTag: false,
      destinationTag: "0",
      status: "0",
    },
  },
  proof: ["aa".repeat(32), "bb".repeat(32)],
};

function request(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://127.0.0.1:${port}`);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        agent: new http.Agent({ keepAlive: false }),
        headers: { Connection: "close", ...opts.headers },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let body: any;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode!, body, headers: res.headers, raw: data });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Receipt contract and formatting helpers", () => {
  it("formats FDC and DA voting rounds the same way", async () => {
    const { formatVotingRound } = await import("../src/receipt-page.js");
    assert.equal(formatVotingRound(1496278), "1,496,278");
    assert.equal(formatVotingRound("1496278"), "1,496,278");
    assert.equal(formatVotingRound("1,496,278"), "1,496,278");
  });

  it("builds Flare explorer address URLs, never an empty address", async () => {
    const { flareExplorerAddressUrl, isEthAddress, resolveReceiptContract } = await import(
      "../src/receipt-page.js"
    );
    assert.equal(
      flareExplorerAddressUrl(FDC_VERIFICATION_FLARE, "flare"),
      `https://flare-explorer.flare.network/address/${FDC_VERIFICATION_FLARE}`
    );
    assert.equal(isEthAddress(""), false);
    assert.equal(isEthAddress(undefined), false);
    assert.equal(resolveReceiptContract({
      paymentVerifierAddress: "",
      network: "flare",
      fdcVerification: FDC_VERIFICATION_FLARE,
    })?.address, FDC_VERIFICATION_FLARE);
    assert.equal(resolveReceiptContract({
      paymentVerifierAddress: "",
      network: "flare",
      fdcVerification: FDC_VERIFICATION_FLARE,
    })?.kind, "fdc-verification");
    const deployed = resolveReceiptContract({
      paymentVerifierAddress: "0x1234567890AbcdEF1234567890abcdef12345678",
      network: "flare",
      fdcVerification: FDC_VERIFICATION_FLARE,
    });
    assert.equal(deployed?.kind, "payment-verifier");
    assert.equal(deployed?.address, "0x1234567890AbcdEF1234567890abcdef12345678");
    assert.match(deployed!.explorerUrl, /flare-explorer\.flare\.network\/address\/0x1234567890AbcdEF1234567890abcdef12345678/);
  });

  it("links XRP hashes to the XRPL explorer", async () => {
    const { xrplExplorerTxUrl } = await import("../src/receipt-page.js");
    assert.equal(
      xrplExplorerTxUrl(TX_HASH, "flare"),
      `https://livenet.xrpl.org/transactions/${TX_HASH}`
    );
    assert.match(xrplExplorerTxUrl(TX_HASH, "coston2"), /testnet\.xrpl\.org/);
  });

  it("renders a themed receipt with FdcVerification when PAYMENT_VERIFIER is unset", async () => {
    const { renderVerifiedReceiptHtml } = await import("../src/receipt-page.js");
    const { networkConfigs } = await import("../src/config.js");
    const html = renderVerifiedReceiptHtml(
      {
        txHash: TX_HASH,
        shareUrl: `https://xrp-link.com/receipt/${TX_HASH}`,
        print: false,
        navHtml: "<nav>site-nav</nav>",
        navCss: "",
        network: "flare",
        activeNetwork: networkConfigs.flare,
        paymentVerifierAddress: "",
      },
      {
        id: "60929799-c401-42d9-8f4c-1991fac5acf0",
        txHash: TX_HASH,
        status: "verified",
        roundId: 1496278,
        abiEncodedRequest: null,
        proof: SAMPLE_PROOF as any,
        verifiedTxHash: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { formatXrpAmount: () => "2 XRP" }
    );
    assert.match(html, /background:#0f172a/);
    assert.match(html, /site-nav/);
    assert.match(html, /id="shareReceipt"/);
    assert.match(html, /data-share-url="https:\/\/xrp-link.com\/receipt\//);
    assert.match(html, /id="downloadPdf"/);
    assert.match(html, /src="\/receipt\.js"/);
    assert.doesNotMatch(html, /onclick=/);
    assert.match(html, new RegExp(`livenet\\.xrpl\\.org/transactions/${TX_HASH}`));
    assert.match(html, /FDC Voting Round[\s\S]*1,496,278/);
    assert.match(html, /DA Voting Round[\s\S]*1,496,278/);
    assert.match(html, new RegExp(`flare-explorer\\.flare\\.network/address/${FDC_VERIFICATION_FLARE}`));
    assert.match(html, /FdcVerification/);
    assert.match(html, new RegExp(FDC_VERIFICATION_FLARE));
    assert.doesNotMatch(html, /flare-explorer\.flare\.network\/address\/["<]/);
    assert.doesNotMatch(html, /contract at <code><\/code>/);
    assert.doesNotMatch(html, />—</);
    assert.doesNotMatch(html, /PaymentVerifierMainnet/);
    assert.match(html, /class="btn btn-primary" id="shareReceipt"/);
  });

  it("print variant drops nav and buttons and uses a white page", async () => {
    const { renderVerifiedReceiptHtml } = await import("../src/receipt-page.js");
    const { networkConfigs } = await import("../src/config.js");
    const html = renderVerifiedReceiptHtml(
      {
        txHash: TX_HASH,
        shareUrl: `https://xrp-link.com/receipt/${TX_HASH}`,
        print: true,
        navHtml: "<nav>site-nav</nav>",
        navCss: "",
        network: "flare",
        activeNetwork: networkConfigs.flare,
        paymentVerifierAddress: "",
      },
      {
        id: "id-print",
        txHash: TX_HASH,
        status: "verified",
        roundId: 1496278,
        abiEncodedRequest: null,
        proof: SAMPLE_PROOF as any,
        verifiedTxHash: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { formatXrpAmount: () => "2 XRP" }
    );
    assert.match(html, /class="print-mode"/);
    assert.doesNotMatch(html, /site-nav/);
    assert.doesNotMatch(html, /src="\/receipt\.js"/);
    assert.match(html, /html\.print-mode/);
  });
});

describe("Receipt HTTP routes", () => {
  let server: http.Server | null = null;
  let port = 0;
  let store: typeof import("../src/store.js").store;

  before(async () => {
    const { default: app } = await import("../src/app.js");
    store = (await import("../src/store.js")).store;
    const created = await store.createAttestation(TX_HASH, "owner");
    await store.updateAttestation(created.id, {
      status: "verified",
      roundId: 1496278,
      proof: SAMPLE_PROOF as any,
    });

    server = await new Promise<http.Server>((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1");
      s.once("error", reject);
      s.once("listening", () => resolve(s));
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("test server did not bind");
    port = addr.port;
  });

  after(async () => {
    if (!server) return;
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("serves the themed receipt with nav, share handler, and a real contract link", async () => {
    const res = await request(port, "GET", `/receipt/${TX_HASH}`);
    assert.equal(res.status, 200);
    const html = res.raw;
    assert.match(html, /Verified Payment Receipt/);
    assert.match(html, /background:#0f172a/);
    assert.match(html, /href="\/docs"/);
    assert.match(html, /session-nav\.js/);
    assert.match(html, /id="shareReceipt"/);
    assert.match(html, /id="downloadPdf"/);
    assert.match(html, /src="\/receipt\.js"/);
    assert.match(html, new RegExp(FDC_VERIFICATION_FLARE));
    assert.match(html, /View Contract/);
    assert.doesNotMatch(html, />—</);
    assert.match(html, /1,496,278/);
    assert.doesNotMatch(html, /<span class="value">1496278<\/span>/);
    assert.equal(res.headers["content-security-policy"], (await import("../src/security-headers.js")).CONTENT_SECURITY_POLICY);
  });

  it("print query and /print path are white export views of the same receipt", async () => {
    const q = await request(port, "GET", `/receipt/${TX_HASH}?print=1`);
    const p = await request(port, "GET", `/receipt/${TX_HASH}/print`);
    assert.equal(q.status, 200);
    assert.equal(p.status, 200);
    for (const html of [q.raw, p.raw]) {
      assert.match(html, /print-mode/);
      assert.match(html, /Verified Payment Receipt/);
      assert.doesNotMatch(html, /session-nav\.js/);
      assert.match(html, new RegExp(FDC_VERIFICATION_FLARE));
    }
  });

  it("keeps JSON receipts working and does not invent a PaymentVerifier address", async () => {
    const res = await request(port, "GET", `/receipt/${TX_HASH}?format=json`);
    assert.equal(res.status, 200);
    assert.equal(res.body.txHash, TX_HASH);
    assert.equal(res.body.contract, null);
    assert.equal(res.body.fdcVerification, FDC_VERIFICATION_FLARE);
    assert.ok(res.body.shareUrl.includes("/receipt/"));
  });

  it("serves same-origin receipt.js with share and print helpers", async () => {
    const res = await request(port, "GET", "/receipt.js");
    assert.equal(res.status, 200);
    assert.match(res.raw, /navigator\.share/);
    assert.match(res.raw, /clipboard/);
    assert.match(res.raw, /window\.print/);
    assert.match(res.raw, /Link copied/);
  });

  it("receipt.js has no outside-domain fetches (CSP 'self')", () => {
    const src = readFileSync(join(ROOT, "public", "receipt.js"), "utf8");
    assert.doesNotMatch(src, /https?:\/\//);
    assert.doesNotMatch(src, /addEventListener\(["']load/);
  });
});
