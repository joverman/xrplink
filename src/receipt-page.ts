import { Attestation } from "./types.js";
import { Network, NetworkConfig } from "./config.js";

export function isEthAddress(value: string | undefined | null): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function flareExplorerBase(network: Network): string {
  return network === "flare"
    ? "https://flare-explorer.flare.network"
    : "https://coston2-explorer.flare.network";
}

export function flareExplorerAddressUrl(address: string, network: Network): string {
  return `${flareExplorerBase(network)}/address/${address}`;
}

export function flareExplorerTxUrl(txHash: string, network: Network): string {
  const hash = txHash.startsWith("0x") ? txHash : `0x${txHash}`;
  return `${flareExplorerBase(network)}/tx/${hash}`;
}

export function xrplExplorerTxUrl(txHash: string, network: Network): string {
  const host = network === "flare" ? "https://livenet.xrpl.org" : "https://testnet.xrpl.org";
  return `${host}/transactions/${txHash}`;
}

export function formatVotingRound(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString("en-US");
}

export function networkDisplayName(network: Network): string {
  return network === "flare" ? "Flare mainnet" : "Coston2";
}

export interface ReceiptContract {
  kind: "payment-verifier" | "fdc-verification";
  address: string;
  name: string;
  explorerUrl: string;
}

export function resolveReceiptContract(opts: {
  paymentVerifierAddress: string;
  network: Network;
  fdcVerification: string;
}): ReceiptContract | null {
  if (isEthAddress(opts.paymentVerifierAddress)) {
    const address = opts.paymentVerifierAddress.trim();
    return {
      kind: "payment-verifier",
      address,
      name: "PaymentVerifierMainnet",
      explorerUrl: flareExplorerAddressUrl(address, opts.network),
    };
  }
  if (isEthAddress(opts.fdcVerification)) {
    const address = opts.fdcVerification.trim();
    return {
      kind: "fdc-verification",
      address,
      name: "FdcVerification",
      explorerUrl: flareExplorerAddressUrl(address, opts.network),
    };
  }
  return null;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface ReceiptPageContext {
  txHash: string;
  shareUrl: string;
  print: boolean;
  navHtml: string;
  navCss: string;
  network: Network;
  activeNetwork: NetworkConfig;
  paymentVerifierAddress: string;
}

function pageShell(opts: {
  title: string;
  description: string;
  print: boolean;
  navHtml: string;
  navCss: string;
  extraCss?: string;
  body: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en"${opts.print ? ' class="print-mode"' : ""}>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escapeHtml(opts.title)}</title>
<meta name="description" content="${escapeHtml(opts.description)}">
<style>
${RECEIPT_STYLE}
${opts.navCss}
${opts.extraCss || ""}
</style></head>
<body class="${opts.print ? "print-mode" : "site-theme"}">
<div class="wrap">
${opts.print ? "" : opts.navHtml}
${opts.body}
</div>
${opts.print ? "" : `<script src="/receipt.js" defer></script>`}
</body></html>`;
}

const RECEIPT_STYLE = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{background:#0f172a}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e2e8f0;line-height:1.6;padding:2rem 1rem}
.wrap{max-width:800px;margin:0 auto}
.receipt,.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:2.5rem}
.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:2rem;gap:1rem}
.header .brand{font-weight:700;font-size:1.1rem;color:#f1f5f9}
.header .brand span{color:#818cf8}
.header .badge{background:#065f46;color:#6ee7b7;padding:0.3rem 0.75rem;border-radius:6px;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.03em}
.header .badge.warn{background:#92400e;color:#fde68a}
h1{font-size:1.25rem;margin-bottom:0.25rem;color:#f1f5f9}
.subtitle{color:#94a3b8;font-size:0.85rem;margin-bottom:1.5rem}
.row{display:flex;justify-content:space-between;padding:0.75rem 0;border-bottom:1px solid #334155;font-size:0.88rem}
.row:last-child{border:none}
.row .key{color:#94a3b8;flex-shrink:0}
.row .value{color:#e2e8f0;font-family:"SF Mono","Fira Code","JetBrains Mono",monospace;font-size:0.8rem;text-align:right;word-break:break-all;max-width:65%}
.row .value.green{color:#34d399}
.row a.value,.row a{color:#818cf8;text-decoration:none}
.row a:hover{text-decoration:underline}
.section-title{font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;margin:1.5rem 0 0.75rem;font-weight:600}
.actions{margin-top:2rem;display:flex;flex-wrap:wrap;gap:0.75rem;align-items:center}
.actions .btn,.actions a.btn,button.btn{padding:0.6rem 1.25rem;border-radius:8px;font-weight:600;font-size:0.85rem;text-decoration:none;display:inline-block;cursor:pointer;font-family:inherit;border:none}
.btn-primary{background:#818cf8;color:#0f172a}
.btn-primary:hover{background:#6366f1}
.btn-outline{background:transparent;color:#818cf8;border:1.5px solid #818cf8}
.btn-outline:hover{background:#1e293b}
.share-status{color:#6ee7b7;font-size:0.85rem;font-weight:600}
.share-status[hidden]{display:none !important}
.footer{text-align:center;margin-top:2rem;padding-top:1.5rem;border-top:1px solid #334155;font-size:0.8rem;color:#94a3b8}
.footer a{color:#818cf8;text-decoration:none}
.footer code{font-family:"SF Mono","Fira Code",monospace;font-size:0.78rem;color:#cbd5e1;word-break:break-all}
.tip{background:#1e3a5f;border:1px solid #334155;border-radius:8px;padding:1rem 1.25rem;margin-top:1.5rem;font-size:0.85rem;color:#93c5fd}
.tip code{display:block;background:#0f172a;color:#cbd5e1;padding:0.75rem;border-radius:6px;margin-top:0.5rem;line-height:1.5;font-size:0.8rem}
.not-found{text-align:center;padding:3rem 2rem}
.not-found .icon{font-size:3rem;margin-bottom:1rem}
html.print-mode,html.print-mode body,body.print-mode{background:#fff !important;color:#1e293b !important;padding:0 !important}
html.print-mode nav,html.print-mode .actions,html.print-mode .no-print,html.print-mode #authNav,
body.print-mode nav,body.print-mode .actions,body.print-mode .no-print{display:none !important}
html.print-mode .wrap,body.print-mode .wrap{max-width:680px;padding:1.5rem}
html.print-mode .receipt,html.print-mode .card,body.print-mode .receipt,body.print-mode .card{background:#fff;border:none;border-radius:0;padding:0;color:#1e293b}
html.print-mode h1,html.print-mode .header .brand,body.print-mode h1,body.print-mode .header .brand{color:#0f172a}
html.print-mode .subtitle,html.print-mode .row .key,html.print-mode .section-title,html.print-mode .footer,
body.print-mode .subtitle,body.print-mode .row .key,body.print-mode .section-title,body.print-mode .footer{color:#64748b}
html.print-mode .row,body.print-mode .row{border-bottom:1px solid #f1f5f9}
html.print-mode .row .value,html.print-mode .footer code,body.print-mode .row .value,body.print-mode .footer code{color:#1e293b}
html.print-mode .row .value.green,body.print-mode .row .value.green{color:#059669}
html.print-mode .row a,html.print-mode .footer a,body.print-mode .row a,body.print-mode .footer a{color:#4338ca}
html.print-mode .header .badge,body.print-mode .header .badge{background:#065f46;color:#d1fae5}
html.print-mode .footer,body.print-mode .footer{border-top:1px solid #f1f5f9}
@media print{
  html,body{background:#fff !important;color:#1e293b !important;padding:0 !important}
  nav,.actions,.no-print,#authNav{display:none !important}
  .wrap{max-width:680px;padding:1.5rem}
  .receipt,.card{background:#fff;border:none;border-radius:0;padding:0;color:#1e293b}
  h1,.header .brand{color:#0f172a}
  .subtitle,.row .key,.section-title,.footer{color:#64748b}
  .row{border-bottom:1px solid #f1f5f9}
  .row .value,.footer code{color:#1e293b}
  .row .value.green{color:#059669}
  .row a,.footer a{color:#4338ca}
  .header .badge{background:#065f46;color:#d1fae5}
  .footer{border-top:1px solid #f1f5f9}
}
@media(max-width:480px){.row{flex-direction:column;gap:0.25rem}.row .value{text-align:left;max-width:100%}}
`;

function contractFooter(contract: ReceiptContract | null, network: Network): string {
  const net = networkDisplayName(network);
  if (!contract) {
    return `<p>Generated by <a href="/">XRPLink</a>. This receipt is independently verifiable against Flare's Data Connector on ${escapeHtml(net)}.</p>`;
  }
  if (contract.kind === "payment-verifier") {
    return `<p>Generated by <a href="/">XRPLink</a>. This receipt is independently verifiable by calling <code>verifyXRPPayment()</code> on the <a href="${escapeHtml(contract.explorerUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(contract.name)}</a> contract at <code>${escapeHtml(contract.address)}</code> on ${escapeHtml(net)}.</p>`;
  }
  return `<p>Generated by <a href="/">XRPLink</a>. This receipt is independently verifiable by calling <code>verifyXRPPayment()</code> on the <a href="${escapeHtml(contract.explorerUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(contract.name)}</a> contract at <code>${escapeHtml(contract.address)}</code> on ${escapeHtml(net)}.</p>`;
}

export function renderVerifiedReceiptHtml(
  ctx: ReceiptPageContext,
  attestation: Attestation,
  opts: { formatXrpAmount: (drops: string) => string }
): string {
  const p = attestation.proof?.response;
  const rb = p?.responseBody;
  const contract = resolveReceiptContract({
    paymentVerifierAddress: ctx.paymentVerifierAddress,
    network: ctx.network,
    fdcVerification: ctx.activeNetwork.fdcVerification,
  });
  const xrplUrl = xrplExplorerTxUrl(ctx.txHash, ctx.network);
  const memoHex = rb?.firstMemoData || "";
  const memoStr = memoHex.startsWith("0x")
    ? Buffer.from(memoHex.slice(2), "hex").toString("utf8").replace(/\0+$/, "")
    : "";

  const fdcRound = formatVotingRound(attestation.roundId);
  const daRound = formatVotingRound(p?.votingRound);
  const contractLabel = contract?.kind === "payment-verifier" ? "Flare Contract" : "FdcVerification";

  const paymentRows = rb
    ? `<div class="row"><span class="key">Source Address</span><span class="value">${escapeHtml(rb.sourceAddress)}</span></div>
<div class="row"><span class="key">Amount</span><span class="value">${escapeHtml(opts.formatXrpAmount(rb.receivedAmount))}</span></div>
<div class="row"><span class="key">Status</span><span class="value green">${rb.status === "0" ? "Success" : "Failed (" + escapeHtml(rb.status) + ")"}</span></div>
${rb.hasMemoData && memoStr ? `<div class="row"><span class="key">Memo Data</span><span class="value">${escapeHtml(memoStr)}</span></div>` : ""}
${rb.hasDestinationTag && rb.destinationTag !== "0" ? `<div class="row"><span class="key">Destination Tag</span><span class="value">${escapeHtml(rb.destinationTag)}</span></div>` : ""}`
    : "";

  const viewContract = contract
    ? `<a href="${escapeHtml(contract.explorerUrl)}" class="btn btn-outline" target="_blank" rel="noopener noreferrer" id="viewContract">View Contract</a>`
    : "";

  const body = `<div class="receipt">
<div class="header">
  <div class="brand">XRPL<span>ink</span></div>
  <div class="badge">Verified on Flare</div>
</div>
<h1>Verified Payment Receipt</h1>
<p class="subtitle">This receipt is cryptographically verified by the Flare Data Connector (FDC). Anyone can independently verify it on-chain.</p>

<div class="section-title">Payment Details</div>
<div class="row"><span class="key">XRP Transaction</span><span class="value"><a class="value" href="${escapeHtml(xrplUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(ctx.txHash)}</a></span></div>
${paymentRows}

<div class="section-title">Verification Proof</div>
<div class="row"><span class="key">Attestation ID</span><span class="value">${escapeHtml(attestation.id)}</span></div>
${fdcRound ? `<div class="row"><span class="key">FDC Voting Round</span><span class="value">${escapeHtml(fdcRound)}</span></div>` : ""}
${daRound ? `<div class="row"><span class="key">DA Voting Round</span><span class="value">${escapeHtml(daRound)}</span></div>` : ""}
${attestation.verifiedTxHash ? `<div class="row"><span class="key">Verification TX</span><span class="value"><a class="value" href="${escapeHtml(flareExplorerTxUrl(attestation.verifiedTxHash, ctx.network))}" target="_blank" rel="noopener noreferrer">${escapeHtml(attestation.verifiedTxHash)}</a></span></div>` : ""}
${contract ? `<div class="row"><span class="key">${escapeHtml(contractLabel)}</span><span class="value"><a class="value" href="${escapeHtml(contract.explorerUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(contract.address)}</a></span></div>` : ""}
${attestation.proof?.proof ? `<div class="row"><span class="key">Merkle Proof</span><span class="value">${attestation.proof.proof.length} entries</span></div>` : ""}
${attestation.status === "pending" ? `<div class="row"><span class="key">Status</span><span class="value">Pending — check back in ~90s</span></div>` : ""}

<div class="actions no-print">
  <button type="button" class="btn btn-primary" id="shareReceipt" data-share-url="${escapeHtml(ctx.shareUrl)}">Share Receipt</button>
  <button type="button" class="btn btn-outline" id="downloadPdf">Download PDF</button>
  ${viewContract}
  <span class="share-status" id="shareStatus" hidden>Link copied</span>
</div>

<div class="footer">
  ${contractFooter(contract, ctx.network)}
</div>
</div>`;

  return pageShell({
    title: "Verified Receipt — XRPLink",
    description: `Cryptographically verified XRP payment receipt for transaction ${ctx.txHash}`,
    print: ctx.print,
    navHtml: ctx.navHtml,
    navCss: ctx.navCss,
    body,
  });
}

export function renderNotFoundReceiptHtml(ctx: ReceiptPageContext): string {
  const body = `<div class="card not-found">
<div class="icon">🔍</div>
<h1>Transaction Not Found</h1>
<p class="subtitle">No XRP transaction with the hash <code>${escapeHtml(ctx.txHash)}</code> was found on the XRP Ledger.</p>
<div class="actions no-print"><a href="/" class="btn btn-primary">Back to Home</a></div>
</div>`;
  return pageShell({
    title: "Receipt Not Found — XRPLink",
    description: `No XRP transaction found for ${ctx.txHash}`,
    print: ctx.print,
    navHtml: ctx.navHtml,
    navCss: ctx.navCss,
    body,
  });
}

export function renderUnattestedReceiptHtml(
  ctx: ReceiptPageContext,
  details: {
    account: string;
    destination: string;
    amountFormatted: string;
    txDate: string;
    memoStr: string;
    destinationTag?: string | number;
    host: string;
  }
): string {
  const xrplUrl = xrplExplorerTxUrl(ctx.txHash, ctx.network);
  const body = `<div class="receipt">
<div class="header">
  <div class="brand">XRPL<span>ink</span></div>
  <div class="badge warn">Not Yet Attested</div>
</div>
<h1>XRP Payment Found</h1>
<p class="subtitle">This transaction exists on the XRP Ledger but hasn't been attested yet. Generate a verified receipt below.</p>

<div class="section-title">Transaction Details</div>
<div class="row"><span class="key">Transaction Hash</span><span class="value"><a class="value" href="${escapeHtml(xrplUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(ctx.txHash)}</a></span></div>
<div class="row"><span class="key">Source Address</span><span class="value">${escapeHtml(details.account)}</span></div>
<div class="row"><span class="key">Destination</span><span class="value">${escapeHtml(details.destination || "")}</span></div>
<div class="row"><span class="key">Amount</span><span class="value">${escapeHtml(details.amountFormatted)}</span></div>
<div class="row"><span class="key">Timestamp</span><span class="value">${escapeHtml(details.txDate)}</span></div>
${details.memoStr ? `<div class="row"><span class="key">Memo</span><span class="value">${escapeHtml(details.memoStr)}</span></div>` : ""}
${details.destinationTag ? `<div class="row"><span class="key">Destination Tag</span><span class="value">${escapeHtml(String(details.destinationTag))}</span></div>` : ""}

<div class="tip">
  <strong>Want a verified receipt?</strong> Use our API to attest this payment. Receipts are cryptographically verified on the Flare Network and independently verifiable.
  <code>
    # Get an API key at /dashboard<br>
    curl -X POST https://${escapeHtml(details.host)}/api/v1/verify/xrp-payment \\<br>
    &nbsp;&nbsp;-H "Content-Type: application/json" \\<br>
    &nbsp;&nbsp;-H "X-API-Key: sk_live_..." \\<br>
    &nbsp;&nbsp;-d '{"txHash": "${escapeHtml(ctx.txHash)}"}'
  </code>
</div>

<div class="actions no-print">
  <a href="/dashboard" class="btn btn-primary">Get an API Key</a>
  <a href="${escapeHtml(xrplUrl)}" class="btn btn-outline" target="_blank" rel="noopener noreferrer">View on XRPL Explorer</a>
</div>

<div class="footer">
  <p><a href="/">XRPLink</a> — Cryptographically Verified XRP Payment Receipts</p>
</div>
</div>`;
  return pageShell({
    title: "Attest This Payment — XRPLink",
    description: `XRP transaction ${ctx.txHash} has not been attested yet`,
    print: ctx.print,
    navHtml: ctx.navHtml,
    navCss: ctx.navCss,
    body,
  });
}
