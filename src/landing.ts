import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const INDEX_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html");

function readUsd(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Format a USD amount for the public pricing card ($2.50, $10). */
export function formatLandingUsd(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

export function renderLandingPage(
  html: string,
  floorUsd: number = readUsd("X402_FLOOR_USD", 2.5),
  capUsd: number = readUsd("X402_CAP_USD", 10)
): string {
  return html
    .split("{{X402_FLOOR_USD}}").join(formatLandingUsd(floorUsd))
    .split("{{X402_CAP_USD}}").join(formatLandingUsd(capUsd));
}

export function loadLandingHtml(): string {
  return renderLandingPage(readFileSync(INDEX_PATH, "utf8"));
}
