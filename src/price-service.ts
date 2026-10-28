/**
 * FLR-linked attestation pricing for x402 pay-per-use.
 *
 * price_usd = clamp(max(floor, fee_flr × FLR/USD × markup), floor, cap)
 * then rounded UP to X402_PRICE_STEP_USD.
 *
 * FLR/USD and XRP/USD come from Flare's on-chain FTSO (FtsoV2 via ContractRegistry).
 * Kraken's public ticker is the fallback. Prices refresh every 60s and are rejected
 * once older than 300s (fail closed — never quote a stale price).
 */

import { Contract, JsonRpcProvider, formatEther, formatUnits } from "ethers";
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

const FEE_CONFIG_ABI = [
  "function getRequestFee(bytes _data) external view returns (uint256)",
];

const FDC_HUB_FEE_ABI = [
  "function fdcRequestFeeConfigurations() external view returns (address)",
];

export type PriceSource = "ftso" | "kraken" | "mock";

export interface AttestationPrice {
  usd: number;
  xrpDrops: string;
  xrp: number;
  rlusd: string;
  flrCost: number;
  flrUsdRate: number;
  xrpUsdRate: number;
  floorApplied: boolean;
  capApplied: boolean;
  stepApplied: boolean;
  xrpBuffer: number;
  priceSource: PriceSource;
}

interface PriceCache {
  flrUsd: number;
  xrpUsd: number;
  timestamp: number;
  source: PriceSource;
}

interface FeeCache {
  feeFlr: number;
  timestamp: number;
  source: "chain" | "env";
}

let priceCache: PriceCache | null = null;
let feeCache: FeeCache | null = null;
let testOverride: { flrUsd: number; xrpUsd: number } | null = null;
let testForceFail = false;
let testKrakenOverride: { flrUsd: number; xrpUsd: number } | null = null;
let testForceKrakenFail = false;
let testOnChainFee: number | null = null;
let testForceOnChainFeeFail = false;

export function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function getFloorUsd(): number {
  return readNumber("X402_FLOOR_USD", 2.5);
}

export function getMarkup(): number {
  return readNumber("X402_MARKUP", 3);
}

export function getCapUsd(): number {
  return readNumber("X402_CAP_USD", 10);
}

export function getPriceStepUsd(): number {
  return readNumber("X402_PRICE_STEP_USD", 0.25);
}

export function getXrpBuffer(): number {
  return readNumber("X402_XRP_BUFFER", 0.01);
}

export function getFallbackAttestationFeeFlr(): number {
  return readNumber("ATTESTATION_FEE_FLR", Number(config.submitFeeFlr) || 20);
}

/** @deprecated use getFallbackAttestationFeeFlr; kept as the env-only value */
export function getAttestationFeeFlr(): number {
  return getFallbackAttestationFeeFlr();
}

export function getPriceRefreshMs(): number {
  return readNumber("X402_PRICE_REFRESH_MS", 60_000);
}

export function getPriceMaxAgeMs(): number {
  if (process.env.X402_PRICE_MAX_AGE_MS) {
    return readNumber("X402_PRICE_MAX_AGE_MS", 300_000);
  }
  // Backward compatible alias from the previous single-TTL setting
  return readNumber("X402_PRICE_CACHE_TTL_MS", 300_000);
}

export function getPriceCacheTtlMs(): number {
  return getPriceMaxAgeMs();
}

export function getKrakenTickerUrl(): string {
  return (
    process.env.X402_KRAKEN_TICKER_URL ||
    "https://api.kraken.com/0/public/Ticker?pair=FLRUSD,XRPUSD"
  );
}

function encodeBytes32Ascii(text: string): string {
  return Buffer.from(text).toString("hex").padEnd(64, "0");
}

/**
 * Pure pricing math.
 * clamp(max(floor, fee × flrUsd × markup), floor, cap), then round UP to step.
 * Never returns a USD price below the floor. Throws if feed values are unusable.
 */
export function calculateAttestationPrice(input: {
  flrUsd: number;
  xrpUsd: number;
  feeFlr: number;
  markup: number;
  floorUsd: number;
  capUsd?: number;
  stepUsd?: number;
  xrpBuffer?: number;
  priceSource?: PriceSource;
}): AttestationPrice {
  const {
    flrUsd,
    xrpUsd,
    feeFlr,
    markup,
    floorUsd,
    capUsd = getCapUsd(),
    stepUsd = getPriceStepUsd(),
    xrpBuffer = getXrpBuffer(),
    priceSource = "ftso",
  } = input;

  if (
    !(flrUsd > 0) ||
    !(xrpUsd > 0) ||
    !(feeFlr > 0) ||
    !(markup > 0) ||
    !(floorUsd > 0) ||
    !(capUsd > 0) ||
    !(stepUsd > 0) ||
    xrpBuffer < 0
  ) {
    throw new Error("Price feed returned non-positive values");
  }
  if (capUsd < floorUsd) {
    throw new Error("X402_CAP_USD must be greater than or equal to X402_FLOOR_USD");
  }

  const markedUp = feeFlr * flrUsd * markup;
  const clamped = Math.min(capUsd, Math.max(floorUsd, markedUp));
  const stepped = roundUpToStep(clamped, stepUsd);
  const priceUsd = Math.min(capUsd, Math.max(floorUsd, stepped));

  const floorApplied = markedUp <= floorUsd + 1e-12;
  const capApplied = markedUp >= capUsd - 1e-12 || stepped > capUsd + 1e-12;
  const stepApplied = Math.abs(stepped - clamped) > 1e-9;

  const xrp = (priceUsd / xrpUsd) * (1 + xrpBuffer);
  const xrpDrops = String(Math.ceil(xrp * 1_000_000 - 1e-9));
  const rlusd = trimDecimal(priceUsd.toFixed(6));

  return {
    usd: Number(priceUsd.toFixed(2)),
    xrpDrops,
    xrp,
    rlusd,
    flrCost: feeFlr,
    flrUsdRate: flrUsd,
    xrpUsdRate: xrpUsd,
    floorApplied,
    capApplied,
    stepApplied,
    xrpBuffer,
    priceSource,
  };
}

export function roundUpToStep(value: number, step: number): number {
  if (!(step > 0)) return value;
  const units = value / step;
  if (Math.abs(units - Math.round(units)) < 1e-9) {
    return Math.round(units) * step;
  }
  return Math.ceil(units - 1e-12) * step;
}

function trimDecimal(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "") || "0";
}

function decodeFtsoValue(value: bigint | string | number, decimals: bigint | number): number {
  const dec = Math.abs(Number(decimals));
  return parseFloat(formatUnits(value, dec));
}

function cacheIsFresh(timestamp: number, now: number): boolean {
  return now - timestamp < getPriceRefreshMs();
}

function cacheIsUsable(timestamp: number, now: number): boolean {
  return now - timestamp <= getPriceMaxAgeMs();
}

async function fetchPricesFromFtso(): Promise<{ flrUsd: number; xrpUsd: number }> {
  if (testForceFail) {
    throw new Error("Price feed unavailable (test)");
  }
  if (testOverride) {
    return testOverride;
  }

  const provider = new JsonRpcProvider(activeNetwork.rpc);
  const registry = new Contract(CONTRACT_REGISTRY, REGISTRY_ABI, provider);
  const ftsoAddr: string = await registry.getContractAddressByName("FtsoV2");
  const ftso = new Contract(ftsoAddr, FTSO_V2_ABI, provider);

  const [flrRaw, xrpRaw] = await Promise.all([
    ftso.getFeedById(FEED_ID_FLR_USD),
    ftso.getFeedById(FEED_ID_XRP_USD),
  ]);

  const flrUsd = decodeFtsoValue(flrRaw[0], flrRaw[1]);
  const xrpUsd = decodeFtsoValue(xrpRaw[0], xrpRaw[1]);

  if (!(flrUsd > 0) || !(xrpUsd > 0)) {
    throw new Error(`FTSO returned non-positive prices FLR=${flrUsd} XRP=${xrpUsd}`);
  }
  return { flrUsd, xrpUsd };
}

function pickKrakenLast(result: Record<string, any>, hints: string[]): number {
  for (const hint of hints) {
    const row = result[hint];
    const last = Number(row?.c?.[0]);
    if (last > 0) return last;
  }
  for (const [key, row] of Object.entries(result)) {
    const upper = key.toUpperCase();
    if (hints.some((h) => upper.includes(h))) {
      const last = Number((row as any)?.c?.[0]);
      if (last > 0) return last;
    }
  }
  throw new Error(`Kraken ticker missing pairs ${hints.join(",")}`);
}

async function fetchPricesFromKraken(): Promise<{ flrUsd: number; xrpUsd: number }> {
  if (testForceKrakenFail) {
    throw new Error("Kraken ticker unavailable (test)");
  }
  if (testKrakenOverride) {
    return testKrakenOverride;
  }
  if (testForceFail) {
    throw new Error("Kraken not mocked while FTSO is in test-fail mode");
  }

  const response = await fetch(getKrakenTickerUrl(), {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Kraken ticker HTTP ${response.status}`);
  }
  const json: any = await response.json();
  if (Array.isArray(json.error) && json.error.length > 0) {
    throw new Error(`Kraken ticker error: ${json.error.join(",")}`);
  }
  const result = json.result || {};
  const flrUsd = pickKrakenLast(result, ["FLRUSD", "FLR"]);
  const xrpUsd = pickKrakenLast(result, ["XRPUSD", "XXRPZUSD", "XRP"]);
  if (!(flrUsd > 0) || !(xrpUsd > 0)) {
    throw new Error(`Kraken returned non-positive prices FLR=${flrUsd} XRP=${xrpUsd}`);
  }
  return { flrUsd, xrpUsd };
}

async function refreshPrices(now: number): Promise<PriceCache> {
  try {
    const fresh = await fetchPricesFromFtso();
    const source: PriceSource = testOverride ? "mock" : "ftso";
    priceCache = { ...fresh, timestamp: now, source };
    console.log(`FTSO prices: FLR=$${fresh.flrUsd.toFixed(6)} XRP=$${fresh.xrpUsd.toFixed(4)}`);
    return priceCache;
  } catch (ftsoErr) {
    const ftsoMessage = ftsoErr instanceof Error ? ftsoErr.message : String(ftsoErr);
    try {
      const fresh = await fetchPricesFromKraken();
      priceCache = { ...fresh, timestamp: now, source: "kraken" };
      console.warn(`FTSO fetch failed (${ftsoMessage}); using Kraken FLR=$${fresh.flrUsd.toFixed(6)} XRP=$${fresh.xrpUsd.toFixed(4)}`);
      return priceCache;
    } catch (krakenErr) {
      const krakenMessage = krakenErr instanceof Error ? krakenErr.message : String(krakenErr);
      if (priceCache && cacheIsUsable(priceCache.timestamp, now)) {
        console.warn(
          `FTSO and Kraken fetch failed (${ftsoMessage}; ${krakenMessage}); using cache age ${now - priceCache.timestamp}ms`
        );
        return priceCache;
      }
      throw new Error(
        `Price feed unavailable: FTSO (${ftsoMessage}); Kraken (${krakenMessage})`
      );
    }
  }
}

async function fetchLivePrices(): Promise<PriceCache> {
  const now = Date.now();
  if (priceCache && cacheIsFresh(priceCache.timestamp, now)) {
    if (!cacheIsUsable(priceCache.timestamp, now)) {
      throw new Error("Price feed stale (max age exceeded)");
    }
    return priceCache;
  }

  const updated = await refreshPrices(now);
  if (!cacheIsUsable(updated.timestamp, Date.now())) {
    throw new Error("Price feed stale (max age exceeded)");
  }
  return updated;
}

async function fetchOnChainFeeFlr(): Promise<number> {
  if (testForceOnChainFeeFail) {
    throw new Error("On-chain FDC fee unavailable (test)");
  }
  if (testOnChainFee !== null) {
    return testOnChainFee;
  }
  if (testOverride || testForceFail) {
    throw new Error("On-chain FDC fee skipped during price-service tests");
  }

  const provider = new JsonRpcProvider(activeNetwork.rpc);
  const registry = new Contract(CONTRACT_REGISTRY, REGISTRY_ABI, provider);

  let feeCfgAddr: string;
  try {
    feeCfgAddr = await registry.getContractAddressByName("FdcRequestFeeConfigurations");
  } catch {
    const fdcHub = new Contract(activeNetwork.fdcHub, FDC_HUB_FEE_ABI, provider);
    feeCfgAddr = await fdcHub.fdcRequestFeeConfigurations();
  }

  const feeCfg = new Contract(feeCfgAddr, FEE_CONFIG_ABI, provider);
  const data = "0x" + encodeBytes32Ascii("XRPPayment") + encodeBytes32Ascii(activeNetwork.sourceId);
  const feeWei: bigint = await feeCfg.getRequestFee(data);
  const flr = parseFloat(formatEther(feeWei));
  // Dust (e.g. 1 wei) means the type/source is unconfigured; do not quote from it.
  if (!(flr >= 0.01)) {
    throw new Error(`On-chain FDC fee implausible (${flr} FLR / ${feeWei.toString()} wei)`);
  }
  return flr;
}

async function resolveAttestationFeeFlr(): Promise<number> {
  const now = Date.now();
  if (feeCache && cacheIsFresh(feeCache.timestamp, now) && cacheIsUsable(feeCache.timestamp, now)) {
    return feeCache.feeFlr;
  }

  try {
    const feeFlr = await fetchOnChainFeeFlr();
    feeCache = { feeFlr, timestamp: now, source: "chain" };
    console.log(`FDC attestation fee (chain): ${feeFlr} FLR`);
    return feeFlr;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fallback = getFallbackAttestationFeeFlr();
    if (feeCache && cacheIsUsable(feeCache.timestamp, now)) {
      console.warn(`On-chain FDC fee failed (${message}); using cached ${feeCache.feeFlr} FLR`);
      return feeCache.feeFlr;
    }
    console.warn(`On-chain FDC fee failed (${message}); using ATTESTATION_FEE_FLR=${fallback}`);
    feeCache = { feeFlr: fallback, timestamp: now, source: "env" };
    return fallback;
  }
}

export async function getAttestationPrice(): Promise<AttestationPrice> {
  const [prices, feeFlr] = await Promise.all([fetchLivePrices(), resolveAttestationFeeFlr()]);
  return calculateAttestationPrice({
    flrUsd: prices.flrUsd,
    xrpUsd: prices.xrpUsd,
    feeFlr,
    markup: getMarkup(),
    floorUsd: getFloorUsd(),
    capUsd: getCapUsd(),
    stepUsd: getPriceStepUsd(),
    xrpBuffer: getXrpBuffer(),
    priceSource: prices.source,
  });
}

export async function isPriceFeedAvailable(): Promise<boolean> {
  try {
    await fetchLivePrices();
    return true;
  } catch {
    return false;
  }
}

export function getPricingConfig() {
  return {
    floorUsd: getFloorUsd(),
    capUsd: getCapUsd(),
    stepUsd: getPriceStepUsd(),
    markup: getMarkup(),
    attestationFeeFLR: getFallbackAttestationFeeFlr(),
    xrpBuffer: getXrpBuffer(),
    refreshMs: getPriceRefreshMs(),
    maxAgeMs: getPriceMaxAgeMs(),
    cacheTtlMs: getPriceMaxAgeMs(),
    network: config.network,
  };
}

export function clearPriceCache(): void {
  priceCache = null;
  feeCache = null;
}

export function setMockPrices(flrUsd: number, xrpUsd: number): void {
  testOverride = { flrUsd, xrpUsd };
  priceCache = { flrUsd, xrpUsd, timestamp: Date.now(), source: "mock" };
  testForceFail = false;
}

export function setPriceFeedFailureForTests(fail: boolean): void {
  testForceFail = fail;
  if (fail) testOverride = null;
}

export function setKrakenMockForTests(flrUsd: number, xrpUsd: number): void {
  testKrakenOverride = { flrUsd, xrpUsd };
  testForceKrakenFail = false;
}

export function setKrakenFailureForTests(fail: boolean): void {
  testForceKrakenFail = fail;
  if (fail) testKrakenOverride = null;
}

export function setMockOnChainFeeFlr(feeFlr: number | null): void {
  testOnChainFee = feeFlr;
  testForceOnChainFeeFail = false;
  feeCache = null;
}

export function setOnChainFeeFailureForTests(fail: boolean): void {
  testForceOnChainFeeFail = fail;
  if (fail) testOnChainFee = null;
}

export function setStalePriceCacheForTests(flrUsd: number, xrpUsd: number, ageMs: number): void {
  priceCache = {
    flrUsd,
    xrpUsd,
    timestamp: Date.now() - ageMs,
    source: "ftso",
  };
  testOverride = null;
  testForceFail = true;
}

export function resetPriceServiceForTests(): void {
  priceCache = null;
  feeCache = null;
  testOverride = null;
  testForceFail = false;
  testKrakenOverride = null;
  testForceKrakenFail = false;
  testOnChainFee = null;
  testForceOnChainFeeFail = false;
}
