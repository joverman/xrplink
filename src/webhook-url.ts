/**
 * Webhook URL SSRF checks: HTTPS only, no private/loopback/link-local/mapped/decimal
 * hosts, DNS resolved and re-checked at delivery, redirects not followed.
 */
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export class UnsafeWebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeWebhookUrlError";
  }
}

export type DnsLookupFn = (hostname: string) => Promise<string[]>;

let lookupOverride: DnsLookupFn | null = null;

export function setWebhookDnsLookupForTests(fn: DnsLookupFn | null): void {
  lookupOverride = fn;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata",
  "metadata.google",
  "metadata.aws",
  "instance-data",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

function stripTrailingDots(host: string): string {
  return host.replace(/\.+$/, "");
}

function isBlockedHostname(hostname: string): boolean {
  const host = stripTrailingDots(hostname.toLowerCase());
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true;
  for (const blocked of BLOCKED_HOSTNAMES) {
    if (host === blocked || host.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

function ipv4FromUint(n: number): string {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

/** Integer / hex hostnames like 2130706433 or 0x7f000001. */
function parseDecimalOrHexIPv4(host: string): string | null {
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return ipv4FromUint(n >>> 0);
  }
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = Number.parseInt(host, 16);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return ipv4FromUint(n >>> 0);
  }
  return null;
}

/**
 * Canonical dotted IPv4 only. Leading-zero octets (octal) and short forms are
 * rejected so we never disagree with the resolver.
 */
function parseCanonicalIPv4(host: string): string | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    if (p.length > 1 && p.startsWith("0")) return null;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums.join(".");
}

export function isPrivateIPv4(ip: string): boolean {
  const canonical = parseCanonicalIPv4(ip);
  if (!canonical) return true;
  const [a, b] = canonical.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function expandIpv4Mapped(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return null;
}

export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1" || lower === "::" || lower === "0:0:0:0:0:0:0:1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("ff")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  const mapped = expandIpv4Mapped(lower);
  if (mapped) return isPrivateIPv4(mapped);
  return false;
}

export function isBlockedIpAddress(address: string): boolean {
  const mapped = expandIpv4Mapped(address);
  if (mapped) return isPrivateIPv4(mapped);
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  const dotted = parseCanonicalIPv4(address);
  if (dotted) return isPrivateIPv4(dotted);
  return true;
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  if (lookupOverride) return lookupOverride(hostname);
  if (isIP(hostname)) return [hostname];
  const decimal = parseDecimalOrHexIPv4(hostname);
  if (decimal) return [decimal];
  const dotted = parseCanonicalIPv4(hostname);
  if (dotted) return [dotted];
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

function parseHttpsUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeWebhookUrlError("URL is not valid");
  }
  if (parsed.protocol !== "https:") {
    throw new UnsafeWebhookUrlError("Webhook URL must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeWebhookUrlError("Webhook URL must not include credentials");
  }
  const hostname = stripTrailingDots(parsed.hostname.toLowerCase());
  if (!hostname) {
    throw new UnsafeWebhookUrlError("Webhook URL host is empty");
  }
  if (isBlockedHostname(hostname)) {
    throw new UnsafeWebhookUrlError("Webhook URL host is blocked");
  }
  const asDecimal = parseDecimalOrHexIPv4(hostname);
  if (asDecimal) {
    throw new UnsafeWebhookUrlError("Webhook URL host is a blocked address form");
  }
  if (hostname.includes(":")) {
    // IPv6 hostname (URL parser strips brackets into hostname)
    if (isPrivateIPv6(hostname) || isBlockedIpAddress(hostname)) {
      throw new UnsafeWebhookUrlError("Webhook URL host is a private or mapped address");
    }
  }
  const dotted = parseCanonicalIPv4(hostname);
  if (dotted && isPrivateIPv4(dotted)) {
    throw new UnsafeWebhookUrlError("Webhook URL host is a private address");
  }
  if (isIP(hostname) && isBlockedIpAddress(hostname)) {
    throw new UnsafeWebhookUrlError("Webhook URL host is a private address");
  }
  // Ambiguous IPv4 forms (127.1, 0177.0.0.1)
  if (/^\d+\.\d+/.test(hostname) && !dotted && isIP(hostname) !== 6) {
    throw new UnsafeWebhookUrlError("Webhook URL host is a non-canonical address");
  }
  return parsed;
}

/** Resolve DNS and reject if any record is private. Call at register and again at delivery. */
export async function assertSafeWebhookUrl(url: string): Promise<void> {
  const parsed = parseHttpsUrl(url);
  const hostname = stripTrailingDots(parsed.hostname.toLowerCase());
  let addresses: string[];
  try {
    addresses = await resolveAddresses(hostname);
  } catch (err) {
    throw new UnsafeWebhookUrlError(
      `Webhook URL host could not be resolved (${err instanceof Error ? err.message : String(err)})`
    );
  }
  if (!addresses.length) {
    throw new UnsafeWebhookUrlError("Webhook URL host resolved to no addresses");
  }
  for (const addr of addresses) {
    if (isBlockedIpAddress(addr)) {
      throw new UnsafeWebhookUrlError("Webhook URL resolves to a private or reserved address");
    }
  }
}
