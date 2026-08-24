import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.join(process.cwd(), "docs", "data");
export const HIST_DIR = path.join(DATA_DIR, "history");

export function ensureDirs() {
  fs.mkdirSync(HIST_DIR, { recursive: true });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function historyFile(productId) {
  return path.join(HIST_DIR, `${productId}.json`);
}

export function loadHistory(productId) {
  const d = readJson(historyFile(productId), null);
  if (!d || !Array.isArray(d.entries)) return [];
  return d.entries;
}

// Historia rosnie o jeden wpis na przebieg. Przy skanie co 3h to ~2900 wpisow
// rocznie na produkt - ok. 300 kB. Przycinamy do 400 dni, zeby plik nie puchl
// w nieskonczonosc, ale zeby porownanie rok do roku nadal bylo mozliwe.
const MAX_AGE_DAYS = 400;

export function saveHistory(productId, entries) {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000;
  const kept = entries.filter((e) => {
    const t = Date.parse(e.ts);
    return !Number.isFinite(t) || t >= cutoff;
  });
  writeJson(historyFile(productId), { productId, entries: kept });
  return kept;
}
