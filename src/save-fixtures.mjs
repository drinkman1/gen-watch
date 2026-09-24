// Zapis prawdziwego HTML ze sklepow do test/fixtures - material dla testow
// parserow (selftest, sekcja "fixture'y").
//
//   node src/save-fixtures.mjs --track a    # sources (tor A), z Chromium
//   node src/save-fixtures.mjs --track b    # localSources (tor B), bez przegladarki
//   node src/save-fixtures.mjs --track b --only amazon
//
// Tor A zapisuje GitHub Actions (tam sklepy odpowiadaja, a Chromium jest pod
// reka), tor B - laptop z domowego lacza, bo Ceneo, Amazon i Komputronik
// odrzucaja adresy centrow danych.
//
// Na kazde zrodlo dwa pliki: <produkt>__<sklep>.html.gz (pelny HTML, bez
// przycinania - test ma widziec to, co widzi parser) i <produkt>__<sklep>.json
// z metadanymi i oczekiwanym wynikiem. Osobne pliki per zrodlo, zeby zapis z
// Actions i z laptopa nigdy nie mial konfliktu.
//
// `expect` to wynik parsera na zapisanej stronie W CHWILI ZAPISU. To propozycja,
// nie prawda objawiona: przed commitem porownaj ceny z dashboardem z tego dnia.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_DIR = path.join(REPO, "test", "fixtures");

export const fixtureName = (productId, shop) => `${productId}__${shop}`;

// Fetcher udajacy smartFetch, ale oddajacy zapisany plik. Wspolny dla zapisu
// (wyliczenie `expect`) i dla testu - obie strony licza dokladnie tak samo.
export function fixtureFetcher(meta, html) {
  return async () => {
    const ok = meta.httpStatus >= 200 && meta.httpStatus < 300;
    return { ok, status: meta.httpStatus, html, finalUrl: meta.finalUrl || meta.url, via: "fixture" };
  };
}

export function loadFixture(name, dir = FIXTURE_DIR) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, name + ".json"), "utf8"));
  const html = zlib.gunzipSync(fs.readFileSync(path.join(dir, name + ".html.gz"))).toString("utf8");
  return { meta, html };
}

// Wynik adaptera sprowadzony do tego, co test porownuje.
export function summarize(r) {
  const best = r.offers && r.offers.length ? r.offers.reduce((a, b) => (b.price < a.price ? b : a)) : null;
  return {
    status: r.status,
    price: best ? best.price : null,
    method: best ? best.method : null,
    offers: r.offers ? r.offers.length : 0,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
  const track = arg("--track");
  const only = arg("--only");
  if (track !== "a" && track !== "b") {
    console.error("Podaj --track a (sklepy toru A) albo --track b (Ceneo/Amazon/Komputronik z laptopa).");
    process.exit(2);
  }
  // Tor B zapisuje dokladnie tak, jak skanuje: bez przegladarki.
  if (track === "b") process.env.GEN_WATCH_NO_BROWSER = "1";

  const { smartFetch, closeBrowser } = await import("./fetch.mjs");
  const { scrapeSource } = await import("./adapters/index.mjs");
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "config", "products.json"), "utf8"));
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  let saved = 0;
  for (const product of cfg.products) {
    for (const source of (track === "a" ? product.sources : product.localSources) || []) {
      if (only && source.shop !== only) continue;
      const name = fixtureName(product.id, source.shop);
      const res = await smartFetch(source.url, { needsBrowser: !!source.needsBrowser, waitFor: source.waitFor || null });
      // Odmowa HTTP (403, 5xx) nie testuje parsera - nie nadpisujemy nia
      // dobrego fixture'a. Strona posrednia z kodem 200 (Amazon) zostaje zapisana:
      // to na niej sprawdzamy, ze konczy sie jako "blocked".
      if (!res.ok || !res.html) {
        console.log(`  --  ${name}: HTTP ${res.status || "-"} ${res.error || ""} - nie zapisuje, sprobuj pozniej`);
        continue;
      }
      const meta = {
        productId: product.id,
        shop: source.shop,
        track,
        url: source.url,
        finalUrl: res.finalUrl || source.url,
        httpStatus: res.status,
        via: res.via,
        capturedAt: new Date().toISOString(),
        bytes: Buffer.byteLength(res.html),
      };
      const r = await scrapeSource(product, source, { fetcher: fixtureFetcher(meta, res.html) });
      meta.expect = summarize(r);
      meta.issuesAtCapture = (r.issues || []).slice(0, 3).map((x) => String(x).slice(0, 200));
      fs.writeFileSync(path.join(FIXTURE_DIR, name + ".html.gz"), zlib.gzipSync(res.html, { level: 9 }));
      fs.writeFileSync(path.join(FIXTURE_DIR, name + ".json"), JSON.stringify(meta, null, 2) + "\n");
      saved++;
      const e = meta.expect;
      console.log(`  OK  ${name}: ${e.status}${e.price != null ? ` ${e.price} zl (${e.method})` : ""} · ${Math.round(meta.bytes / 1024)} kB via ${meta.via}`);
    }
  }
  await closeBrowser();
  console.log(`\nZapisano ${saved} stron w ${path.relative(REPO, FIXTURE_DIR)}. Sprawdz ceny z dashboardem, zanim zrobisz commit.`);
}
