/**
 * Persistent x402 quote/settlement ledger (JSON file, same pattern as the app store).
 * Used for operational logs and the daily margin summary. No customer names.
 */

import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { atomicWriteJson, createMutex } from "./file-lock.js";

export interface X402LedgerAsset {
  asset: string;
  amount: string;
}

export interface X402QuoteEvent {
  type: "quote";
  invoiceId: string;
  time: string;
  usd: number;
  flrUsd: number;
  feeFlr: number;
  flrCostUsd: number;
  xrpUsd: number;
  assets: X402LedgerAsset[];
}

export interface X402SettledEvent {
  type: "settled";
  invoiceId: string;
  time: string;
  asset: string;
  amount: string;
  usd: number;
  flrUsd: number;
  feeFlr: number;
  flrCostUsd: number;
  settlementTx?: string;
}

export type X402LedgerEvent = X402QuoteEvent | X402SettledEvent;

export interface DailyMarginSummary {
  date: string;
  quotes: number;
  settlements: number;
  revenueUsd: number;
  flrCostUsd: number;
  marginUsd: number;
}

interface LedgerFile {
  events: X402LedgerEvent[];
}

const ledgerLock = createMutex();

function ledgerPath(): string {
  const dir = process.env.DATA_DIR || "data";
  return join(dir, "x402-ledger.json");
}

function load(): LedgerFile {
  const path = ledgerPath();
  if (!existsSync(path)) return { events: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { events: Array.isArray(parsed?.events) ? parsed.events : [] };
  } catch {
    return { events: [] };
  }
}

function save(file: LedgerFile): void {
  atomicWriteJson(ledgerPath(), file);
}

export async function recordX402Quote(event: Omit<X402QuoteEvent, "type">): Promise<X402QuoteEvent> {
  const full: X402QuoteEvent = { type: "quote", ...event };
  await ledgerLock(() => {
    const file = load();
    file.events.push(full);
    save(file);
  });
  const assets = full.assets.map((a) => `${a.asset}:${a.amount}`).join(",");
  console.log(
    `x402 quote invoiceId=${full.invoiceId} time=${full.time} usd=${full.usd} flrUsd=${full.flrUsd} feeFlr=${full.feeFlr} assets=${assets}`
  );
  return full;
}

export async function recordX402Settlement(event: Omit<X402SettledEvent, "type">): Promise<X402SettledEvent> {
  const full: X402SettledEvent = { type: "settled", ...event };
  await ledgerLock(() => {
    const file = load();
    file.events.push(full);
    save(file);
  });
  console.log(
    `x402 settled invoiceId=${full.invoiceId} time=${full.time} asset=${full.asset} amount=${full.amount} usd=${full.usd} flrUsd=${full.flrUsd} feeFlr=${full.feeFlr}`
  );
  return full;
}

export function listX402LedgerEvents(): X402LedgerEvent[] {
  return load().events.slice();
}

function utcDateKey(iso: string): string {
  return iso.slice(0, 10);
}

function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}

export function getDailyMargin(date?: string): DailyMarginSummary {
  const day = date || new Date().toISOString().slice(0, 10);
  const events = load().events.filter((e) => utcDateKey(e.time) === day);
  let quotes = 0;
  let settlements = 0;
  let revenueUsd = 0;
  let flrCostUsd = 0;
  for (const e of events) {
    if (e.type === "quote") quotes += 1;
    if (e.type === "settled") {
      settlements += 1;
      revenueUsd += e.usd;
      flrCostUsd += e.flrCostUsd;
    }
  }
  return {
    date: day,
    quotes,
    settlements,
    revenueUsd: roundUsd(revenueUsd),
    flrCostUsd: roundUsd(flrCostUsd),
    marginUsd: roundUsd(revenueUsd - flrCostUsd),
  };
}

export function getMarginSummaries(fromDate?: string, toDate?: string): DailyMarginSummary[] {
  const events = load().events;
  const days = new Set<string>();
  for (const e of events) {
    const day = utcDateKey(e.time);
    if (fromDate && day < fromDate) continue;
    if (toDate && day > toDate) continue;
    days.add(day);
  }
  return [...days].sort().map((d) => getDailyMargin(d));
}

export function resetX402LedgerForTests(): void {
  const path = ledgerPath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}
