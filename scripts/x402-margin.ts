/**
 * Print daily x402 margin (revenue USD vs FLR cost) from data/x402-ledger.json.
 *
 *   npx tsx scripts/x402-margin.ts
 *   npx tsx scripts/x402-margin.ts --date 2026-10-26
 *   npx tsx scripts/x402-margin.ts --from 2026-10-01 --to 2026-10-26
 */
import { getDailyMargin, getMarginSummaries } from "../src/x402-ledger.js";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || !process.argv[idx + 1]) return undefined;
  return process.argv[idx + 1];
}

const date = arg("--date");
const from = arg("--from");
const to = arg("--to");

if (from || to) {
  console.log(JSON.stringify(getMarginSummaries(from, to), null, 2));
} else {
  console.log(JSON.stringify(getDailyMargin(date), null, 2));
}
