#!/usr/bin/env node
/**
 * Generate public/icon.png (256x256) and public/favicon.ico from the XL mark.
 * Run from repo root: node scripts/generate-icon.mjs
 */
import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BG = [15, 23, 42]; // #0f172a
const FG = [129, 140, 248]; // #818cf8
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0;
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function distSeg(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

/** Stylised XL monogram. u,v in 0..1; returns coverage 0..1. */
function sdfXL(u, v, size) {
  const px = u * size;
  const py = v * size;
  const stroke = size * 0.095;
  const half = stroke / 2;
  const left = size * 0.18;
  const rightX = size * 0.53;
  const top = size * 0.21;
  const bot = size * 0.79;
  const lX = size * 0.61;
  const lRight = size * 0.84;
  const d = Math.min(
    distSeg(px, py, left, top, rightX, bot),
    distSeg(px, py, rightX, top, left, bot),
    distSeg(px, py, lX, top, lX, bot),
    distSeg(px, py, lX, bot, lRight, bot)
  ) - half;
  return Math.max(0, Math.min(1, 0.5 - d));
}

function render(size) {
  const scale = 4;
  const hi = size * scale;
  const hiRgba = Buffer.alloc(hi * hi * 4);
  for (let y = 0; y < hi; y++) {
    for (let x = 0; x < hi; x++) {
      const cover = sdfXL((x + 0.5) / hi, (y + 0.5) / hi, size);
      const i = (y * hi + x) * 4;
      hiRgba[i] = Math.round(BG[0] + (FG[0] - BG[0]) * cover);
      hiRgba[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * cover);
      hiRgba[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * cover);
      hiRgba[i + 3] = 255;
    }
  }
  const rgba = Buffer.alloc(size * size * 4);
  const n = scale * scale;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let oy = 0; oy < scale; oy++) {
        for (let ox = 0; ox < scale; ox++) {
          const i = ((y * scale + oy) * hi + (x * scale + ox)) * 4;
          r += hiRgba[i];
          g += hiRgba[i + 1];
          b += hiRgba[i + 2];
        }
      }
      const o = (y * size + x) * 4;
      rgba[o] = Math.round(r / n);
      rgba[o + 1] = Math.round(g / n);
      rgba[o + 2] = Math.round(b / n);
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

function wrapIco(pngBuf, width) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = width === 256 ? 0 : width;
  entry[1] = width === 256 ? 0 : width;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuf]);
}

const png256 = encodePng(256, 256, render(256));
const png32 = encodePng(32, 32, render(32));
writeFileSync(join(PUBLIC, "icon.png"), png256);
writeFileSync(join(PUBLIC, "favicon.ico"), wrapIco(png32, 32));
console.log("wrote public/icon.png (256x256) and public/favicon.ico (32x32)");
