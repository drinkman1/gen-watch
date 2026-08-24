import fs from "node:fs";
import path from "node:path";
import { scrapeSource } from "./adapters/index.mjs";
import { closeBrowser } from "./fetch.mjs";
import { evaluate, effectiveCost, fmt } from "./alerts.mjs";
import { ensureDirs, readJson, writeJson, loadHistory, saveHistory, DATA_DIR } from "./store.mjs";

const argv = process.argv.slice(2);
const only = flag("--product");
const dumpHtml = argv.includes("--dump");
const dryRun = argv.includes("--dry-run");

function flag(name) {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}

const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "products.json"), "utf8"));
const rules = cfg.meta.alertRules;
const now = new Date();
const nowMs = now.getTime();
const stamp = now.toISOString();

const products = only ? cfg.products.filter((p) => p.id === only) : cfg.products;
if (!products.length) {
  console.error(`Nie znam produktu "${only}". Dostepne: ${cfg.products.map((p) => p.id).join(", ")}`);
  process.exit(2);
}

ensureDirs();
const state = readJson(path.join(DATA_DIR, "state.json"), {});
const snapshot = { generatedAt: stamp, products: [], alerts: [], run: {} };

let sourcesOk = 0, sourcesBad = 0;

for (const product of products) {
  const offers = [];
  const sourceReports = [];

  for (const source of product.sources) {
    const started = Date.now();
    let r;
    try {
      r = await scrapeSource(product, source);
    } catch (e) {
      r = { status: "error", offers: [], issues: ["wyjatek: " + String(e && e.message || e)] };
    }
    const ms = Date.now() - started;

    if (r.status === "ok") sourcesOk++; else sourcesBad++;
    // bestEffort znaczy "wiemy, ze to zrodlo bywa zablokowane" - jego awaria
    // nie jest wydarzeniem i nie powinna czerwienic raportu.
    sourceReports.push({
      shop: source.shop,
      kind: source.kind,
      url: source.url,
      status: r.status,
      bestEffort: !!source.bestEffort,
      found: r.offers.length,
      ms,
      issues: r.issues,
    });
    offers.push(...r.offers);

    if (dumpHtml && r.status !== "ok") {
      // Zrzut przydaje sie tylko wtedy, gdy cos nie wyszlo - wtedy chcemy
      // zobaczyc, czy to blokada, czy zmiana ukladu strony.
      console.log(`  [dump] ${source.shop}: ${r.status} - ${r.issues.join("; ")}`);
    }
  }

  const sellable = offers.filter((o) => o.availability !== "brak");
  const pool = sellable.length ? sellable : offers;
  const best = pool.length ? pool.reduce((a, b) => (b.price < a.price ? b : a)) : null;

  const history = loadHistory(product.id);
  const verdict = evaluate(product, best, history, rules, state, nowMs);

  const entry = {
    ts: stamp,
    best: best ? { shop: best.shop, price: best.price, url: best.url, availability: best.availability } : null,
    offerCount: offers.length,
  };
  const newHistory = dryRun ? history : saveHistory(product.id, [...history, entry]);

  const withCost = offers
    .map((o) => ({ ...o, ...effectiveCost(o) }))
    .sort((a, b) => a.price - b.price);

  snapshot.products.push({
    id: product.id,
    name: product.name,
    brand: product.brand,
    ean: product.ean,
    baseline: product.baseline,
    hardThreshold: product.hardThreshold,
    specSource: product.specSource,
    specNote: product.specNote,
    best: entry.best,
    offers: withCost,
    sources: sourceReports,
    stats: verdict.stats,
    alerted: !!verdict.fire,
    suppressed: !!verdict.suppressed,
    historyPoints: newHistory.length,
  });

  if (verdict.fire) {
    snapshot.alerts.push({
      productId: product.id,
      name: product.name,
      price: best.price,
      shop: best.shop,
      url: best.url,
      effective: effectiveCost(best),
      reasons: verdict.reasons,
      baseline: product.baseline,
    });
    if (!dryRun) state[verdict.key] = nowMs;
  }

  const line = best
    ? `${fmt(best.price)} @ ${best.shop}`
    : "brak ceny";
  const badge = verdict.fire ? "  <-- ALERT" : verdict.suppressed ? "  (alert wyciszony)" : "";
  console.log(`${product.name.padEnd(36)} ${line}${badge}`);
  for (const s of sourceReports.filter((s) => s.status !== "ok")) {
    console.log(`   ! ${s.shop}: ${s.status}${s.bestEffort ? " (best-effort)" : ""} - ${s.issues.join("; ")}`);
  }
}

await closeBrowser();

// Status calego przebiegu. "degraded" gdy padlo zrodlo, na ktorym polegamy;
// awaria zrodla best-effort do tego nie wystarcza.
const hardFailures = snapshot.products.flatMap((p) =>
  p.sources.filter((s) => s.status !== "ok" && !s.bestEffort)
);
const noPrice = snapshot.products.filter((p) => !p.best);
snapshot.run = {
  status: noPrice.length ? "error" : hardFailures.length ? "degraded" : "ok",
  startedAt: stamp,
  products: products.length,
  sourcesOk,
  sourcesBad,
  alerts: snapshot.alerts.length,
  productsWithoutPrice: noPrice.map((p) => p.id),
  runUrl: process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null,
};

if (!dryRun) {
  writeJson(path.join(DATA_DIR, "latest.json"), snapshot);
  writeJson(path.join(DATA_DIR, "state.json"), state);
  const runs = readJson(path.join(DATA_DIR, "runs.json"), []);
  runs.push({ ts: stamp, ...snapshot.run });
  writeJson(path.join(DATA_DIR, "runs.json"), runs.slice(-500));
}

console.log(`\nStatus: ${snapshot.run.status} · zrodla ok ${sourcesOk}/${sourcesOk + sourcesBad} · alerty ${snapshot.alerts.length}`);
if (snapshot.run.status === "error") process.exitCode = 1;
