/**
 * FLR-linked attestation pricing for x402 pay-per-use.
 *
 * Formula: price_usd = max(FLOOR_USD, FLR_cost_usd × MARKUP)
 *
 * FLR/USD and XRP/USD come from Flare's on-chain FTSO (FtsoV2 via ContractRegistry).
 * Quotes are cached briefly. A stale cache is the only fallback; if there is no
 * cache and the feed fails, pricing fails closed (no quote, no attestation).
 */

import { ethers } from "ethers";
import { activeNetwork, config } from "./config.js";

const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

// bytes21 feed ids: category 0x01 (crypto) + ASCII name, zero-padded
const FEED_ID_FLR_USD = "0x01464c522f55534400000000000000000000000000";
const FEED_ID_XRP_USD = "0x015852502f55534400000000000000000000000000";

const REGISTRY_ABI = [
  "function getContractAddressByName(string calldata _name) external view returns (address)",
];

const FTSO_V2_ABI = [
  "function getFeedById(bytes21 _feedId) external view returns (uint256, int8, uint64)",
];

export interface AttestationPrice {
  usd: number;
  xrpDrops: string;
  xrp: number;
  rlusd: string;
  flrCost: number;
  flrUsdRate: number;
  xrpUsdRate: number;
  floorApplied: boolean;
}

interface PriceCache {
  flrUsd: number;
  xrpUsd: number;
  timestamp: number;
}

let priceCache: PriceCache | null = null;
let testOverride: { flrUsd: number; xrpUsd: number } | null = null;
let testForceFail = false;

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function getFloorUsd(): number {
  return readNumber("X402_FLOOR_USD", 0.5);
}

export function getMarkup(): number {
  return readNumber("X402_MARKUP", 3);
}

export function getAttestationFeeFlr(): number {
  return readNumber("ATTESTATION_FEE_FLR", Number(config.submitFeeFlr) || 20);
}

export function getPriceCacheTtlMs(): number {
  return readNumber("X402_PRICE_CACHE_TTL_MS", 300_000);
}

/**
 * Pure pricing math. Never returns a USD price below the floor.
 * Throws if feed values are unusable (fail closed).
 */
export function calculateAttestationPrice(input: {
  flrUsd: number;
  xrpUsd: number;
  feeFlr: number;
  markup: number;
  floorUsd: number;
}): AttestationPrice {
  const { flrUsd, xrpUsd, feeFlr, markup, floorUsd } = input;

  if (!(flrUsd > 0) || !(xrpUsd > 0) || !(feeFlr > 0) || !(markup > 0) || !(floorUsd > 0)) {
    throw new Error("Price feed returned non-positive values");
  }

  const flrCostUsd = feeFlr * flrUsd;
  const markedUp = flrCostUsd * markup;
  const priceUsd = Math.max(floorUsd, markedUp);
  const floorApplied = markedUp < floorUsd;

  const xrp = priceUsd / xrpUsd;
  const xrpDrops = String(Math.ceil(xrp * 1_000_000));
  // XRPL issued-currency amount is a decimal string, not integer minor units
  const rlusd = trimDecimal(priceUsd.toFixed(6));

  return {
    usd: priceUsd,
    xrpDrops,
    xrp,
    rlusd,
    flrCost: feeFlr,
    flrUsdRate: flrUsd,
    xrpUsdRate: xrpUsd,
    floorApplied,
  };
}

function trimDecimal(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "") || "0";
}

function decodeFtsoValue(value: ethers.BigNumber, decimals: number): number {
  const dec = Math.abs(decimals);
  return parseFloat(ethers.utils.formatUnits(value, dec));
}

async function fetchPricesFromFtso(): Promise<{ flrUsd: number; xrpUsd: number }> {
  if (testForceFail) {
    throw new Error("Price feed unavailable (test)");
  }
  if (testOverride) {
    return testOverride;
  }

  const now = Date.now();
  const ttl = getPriceCacheTtlMs();
  if (priceCache && now - priceCache.timestamp < ttl) {
    return { flrUsd: priceCache.flrUsd, xrpUsd: priceCache.xrpUsd };
  }

  const provider = new ethers.providers.JsonRpcProvider(activeNetwork.rpc);
  const registry = new ethers.Contract(CONTRACT_REGISTRY, REGISTRY_ABI, provider);

  try {
    const ftsoAddr: string = await registry.getContractAddressByName("FtsoV2");
    const ftso = new ethers.Contract(ftsoAddr, FTSO_V2_ABI, provider);

    const [flrRaw, xrpRaw] = await Promise.all([
      ftso.getFeedById(FEED_ID_FLR_USD),
      ftso.getFeedById(FEED_ID_XRP_USD),
    ]);

    const flrUsd = decodeFtsoValue(flrRaw[0], flrRaw[1]);
    const xrpUsd = decodeFtsoValue(xrpRaw[0], xrpRaw[1]);

    if (!(flrUsd > 0) || !(xrpUsd > 0)) {
      throw new Error(`FTSO returned non-positive prices FLR=${flrUsd} XRP=${xrpUsd}`);
    }

    priceCache = { flrUsd, xrpUsd, timestamp: now };
    console.log(`FTSO prices: FLR=$${flrUsd.toFixed(6)} XRP=$${xrpUsd.toFixed(4)}`);
    return { flrUsd, xrpUsd };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (priceCache) {
      console.warn(`FTSO fetch failed (${message}); using stale cache`);
      return { flrUsd: priceCache.flrUsd, xrpUsd: priceCache.xrpUsd };
    }
    throw new Error(`Price feed unavailable: ${message}`);
  }
}

export async function getAttestationPrice(): Promise<AttestationPrice> {
  const { flrUsd, xrpUsd } = await fetchPricesFromFtso();
  return calculateAttestationPrice({
    flrUsd,
    xrpUsd,
    feeFlr: getAttestationFeeFlr(),
    markup: getMarkup(),
    floorUsd: getFloorUsd(),
  });
}

export async function isPriceFeedAvailable(): Promise<boolean> {
  try {
    await fetchPricesFromFtso();
    return true;
  } catch {
    return false;
  }
}

export function getPricingConfig() {
  return {
    floorUsd: getFloorUsd(),
    markup: getMarkup(),
    attestationFeeFLR: getAttestationFeeFlr(),
    cacheTtlMs: getPriceCacheTtlMs(),
    network: config.network,
  };
}

export function clearPriceCache(): void {
  priceCache = null;
}

export function setMockPrices(flrUsd: number, xrpUsd: number): void {
  testOverride = { flrUsd, xrpUsd };
  priceCache = { flrUsd, xrpUsd, timestamp: Date.now() };
  testForceFail = false;
}

export function setPriceFeedFailureForTests(fail: boolean): void {
  testForceFail = fail;
  if (fail) testOverride = null;
}

export function resetPriceServiceForTests(): void {
  priceCache = null;
  testOverride = null;
  testForceFail = false;
}
