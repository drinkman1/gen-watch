// Testy offline. Zero sieci - chodzi o to, zeby zlapac regresje w parsowaniu
// i w regulach alertu, zanim workflow zacznie sie dobijac do sklepow.
// Uruchomienie: npm run check

import fs from "node:fs";
import path from "node:path";
import {
  parsePrice, normToken, fromJsonLd, fromMicrodata, fromMeta, fromText,
  extractPrice, pageMatchesProduct,
} from "./extract.mjs";
import { parseAggregatorRows } from "./adapters/index.mjs";
import { evaluate, median, allTimeLow, windowPrices, effectiveCost, DAY } from "./alerts.mjs";
import { extractBlock, validate, marketAlerts } from "./ingest.mjs";

let pass = 0, fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e && e.message || e}`);
  }
}

function eq(got, want, msg) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) throw new Error(`${msg || ""} oczekiwano ${b}, jest ${a}`);
}

function truthy(v, msg) { if (!v) throw new Error(msg || "oczekiwano wartosci prawdziwej"); }

// --- parsowanie ceny --------------------------------------------------------

t("cena: format polski z groszami", () => eq(parsePrice("5 688,26 zł"), 5688.26));
t("cena: spacja twarda jako separator tysiecy", () => eq(parsePrice("6 289,00 zł"), 6289));
t("cena: spacja waska", () => eq(parsePrice("11 998 zł"), 11998));
t("cena: kropka jako separator tysiecy", () => eq(parsePrice("1.234,50"), 1234.5));
t("cena: format angielski", () => eq(parsePrice("9,859.00"), 9859));
t("cena: goly int", () => eq(parsePrice("4999"), 4999));
t("cena: liczba", () => eq(parsePrice(8999.5), 8999.5));
t("cena: tysiace kropka bez groszy", () => eq(parsePrice("11.999"), 11999));
t("cena: smiec", () => eq(parsePrice("zapytaj o cene"), null));
t("cena: null", () => eq(parsePrice(null), null));

t("token: rozne zapisy tego samego modelu", () => {
  eq(normToken("KS 8100iE ATSR"), "ks8100ieatsr");
  eq(normToken("ks-8100ie-atsr"), "ks8100ieatsr");
  eq(normToken("KS  8100iE  ATSR"), "ks8100ieatsr");
});

// --- JSON-LD ----------------------------------------------------------------

const JSONLD_SIMPLE = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Agregat KS 8100iEG",
 "gtin13":"4260405364817",
 "offers":{"@type":"Offer","price":"5688.26","priceCurrency":"PLN","availability":"https://schema.org/InStock"}}
</script></head><body>KS 8100iEG</body></html>`;

t("jsonld: prosty Product", () => {
  const r = fromJsonLd(JSONLD_SIMPLE, ["ks8100ieg"]);
  eq(r.price, 5688.26);
  eq(r.availability, "dostepny");
  eq(r.matchedExpected, true);
});

const JSONLD_GRAPH = `<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebSite","name":"Sklep"},
  {"@type":"Product","name":"Fogo F 12000 iSG","offers":[{"@type":"Offer","price":"11999,00","priceCurrency":"PLN"}]}
]}</script><body>Fogo F 12000 iSG</body>`;

t("jsonld: @graph i tablica offers", () => {
  const r = fromJsonLd(JSONLD_GRAPH, ["f12000isg"]);
  eq(r.price, 11999);
});

// Ten przypadek jest powodem, dla ktorego fromJsonLd w ogole dostaje expectTokens.
const JSONLD_TWO = `<script type="application/ld+json">
{"@type":"Product","name":"Olej silnikowy 4T","offers":{"@type":"Offer","price":"49,90"}}</script>
<script type="application/ld+json">
{"@type":"Product","name":"Agregat KS 9500iE S ATSR","offers":{"@type":"Offer","price":"9859,00"}}</script>`;

t("jsonld: wybiera wlasciwy produkt sposrod kilku", () => {
  const r = fromJsonLd(JSONLD_TWO, ["ks9500iesatsr"]);
  eq(r.price, 9859, "nie moze wziac ceny oleju");
});

t("jsonld: kilka produktow, zaden nie pasuje - odmawia zgadywania", () => {
  const r = fromJsonLd(JSONLD_TWO, ["f8001isg"]);
  eq(r, null);
});

t("jsonld: AggregateOffer lowPrice", () => {
  const html = `<script type="application/ld+json">
  {"@type":"Product","name":"KS 8100iE ATSR","offers":{"@type":"AggregateOffer","lowPrice":"4999","highPrice":"6289","priceCurrency":"PLN"}}</script>`;
  eq(fromJsonLd(html, ["ks8100ieatsr"]).price, 4999);
});

t("jsonld: zepsuty blok nie zabija pozostalych", () => {
  const html = `<script type="application/ld+json">{ to nie jest json }</script>` + JSONLD_SIMPLE;
  eq(fromJsonLd(html, ["ks8100ieg"]).price, 5688.26);
});

t("jsonld: koncowy przecinek jest ratowany", () => {
  const html = `<script type="application/ld+json">
  {"@type":"Product","name":"KS 8100iEG","offers":{"@type":"Offer","price":"5299",},}</script>`;
  eq(fromJsonLd(html, ["ks8100ieg"]).price, 5299);
});

t("jsonld: brak ceny zwraca null, nie zero", () => {
  const html = `<script type="application/ld+json">{"@type":"Product","name":"KS 8100iEG"}</script>`;
  eq(fromJsonLd(html, ["ks8100ieg"]), null);
});

// --- pozostale warstwy ------------------------------------------------------

t("microdata: itemprop price", () => {
  const html = `<span itemprop="price" content="8999.00">8 999,00 zł</span>`;
  eq(fromMicrodata(html).price, 8999);
});

t("meta: og:price:amount", () => {
  eq(fromMeta(`<meta property="og:price:amount" content="4211.00">`).price, 4211);
});

t("text: tylko z jawnym wzorcem", () => {
  eq(fromText("cena: 5 299,00 zł", null), null, "bez wzorca nie zgaduje");
  eq(fromText("cena: 5 299,00 zł", "cena:\\s*([\\d\\s.,]+)\\s*zł").price, 5299);
});

t("warstwy: jsonld wygrywa z meta", () => {
  const html = `<meta property="og:price:amount" content="1"/>` + JSONLD_SIMPLE;
  const r = extractPrice(html, { expectTokens: ["ks8100ieg"] });
  eq(r.price, 5688.26);
  eq(r.method, "jsonld");
});

t("warstwy: schodzi do meta gdy brak jsonld", () => {
  const r = extractPrice(`<meta property="og:price:amount" content="7777"/>`, {});
  eq(r.method, "meta");
});

t("warstwy: pusto gdy nic nie ma", () => {
  eq(extractPrice("<html><body>nic tu nie ma</body></html>", {}).price, null);
});

// --- dopasowanie strony do produktu ----------------------------------------

const P_ATSR = { id: "x", ean: "4260405364725", matchTokens: ["ks8100ieatsr"], rejectTokens: ["ks8100ieg"] };
const P_EG = { id: "y", ean: "4260405364817", matchTokens: ["ks8100ieg"], rejectTokens: ["ks8100ieatsr"] };

t("dopasowanie: po EAN", () => {
  truthy(pageMatchesProduct("<p>EAN: 4260405364725</p>", P_ATSR).ok);
});

t("dopasowanie: po nazwie mimo innego zapisu", () => {
  truthy(pageMatchesProduct("<h1>Agregat KS-8100iE-ATSR</h1>", P_ATSR).ok);
});

// To jest dokladnie ta pomylka, ktora Prem zglosil: sklepy pisza "KS 8100iE G"
// zamiast "KS 8100iEG". Po normalizacji obie formy sa tym samym tokenem.
t("dopasowanie: 'KS 8100iE G' to KS 8100iEG", () => {
  truthy(pageMatchesProduct("<h1>KS 8100iE G dual fuel</h1>", P_EG).ok);
});

t("dopasowanie: obca strona odpada", () => {
  eq(pageMatchesProduct("<h1>Kosiarka spalinowa</h1>", P_ATSR).ok, false);
});

// --- porownywarka -----------------------------------------------------------

t("agregator: pary sklep+cena z atrybutow", () => {
  const html = `<div data-shop="Morele.net" data-price="5688"></div>
                <div data-shop="Empik.com" data-price="5729"></div>`;
  const rows = parseAggregatorRows(html, "e-katalog");
  eq(rows.length, 2);
  eq(rows[0].price, 5688);
});

t("agregator: odrzuca absurdalny rozrzut", () => {
  const html = `<div data-shop="Sklep A" data-price="5688"></div>
                <div data-shop="Sklep B" data-price="49"></div>`;
  eq(parseAggregatorRows(html, "e-katalog").length, 0, "49 zl to akcesorium, nie agregat");
});

// Ceneo trzyma w data-shop numeryczne ID sklepu. Bez tej reguly w historii
// ladowaly oferty "sklepu" o nazwie 55521.
t("agregator: numeryczne id sklepu nie staje sie nazwa", () => {
  const html = `<div data-shop="35585" data-price="6819"></div>
                <div data-shop="55521" data-price="6900"></div>`;
  const rows = parseAggregatorRows(html, "ceneo");
  eq(rows.length, 2);
  eq(rows[0].shop, "ceneo/nieznany");
  eq(rows[1].shop, "ceneo/nieznany");
});

t("agregator: nie liczy samego siebie jako sklepu", () => {
  const html = `<div data-shop="e-katalog" data-price="5688"></div>
                <div data-shop="Morele.net" data-price="5700"></div>`;
  const rows = parseAggregatorRows(html, "e-katalog");
  eq(rows.length, 1);
  eq(rows[0].shop, "Morele.net");
});

// --- koszt koncowy ----------------------------------------------------------

t("koszt: rabat i dostawa", () => {
  eq(effectiveCost({ price: 100, discountPct: 4, shipping: 0 }), { cost: 96, shippingKnown: true });
  eq(effectiveCost({ price: 100, discountPct: 0, shipping: 150 }), { cost: 250, shippingKnown: true });
  eq(effectiveCost({ price: 100, discountPct: 0, shipping: null }), { cost: 100, shippingKnown: false });
});

// --- statystyki i alerty ----------------------------------------------------

t("mediana: nieparzysta i parzysta", () => {
  eq(median([3, 1, 2]), 2);
  eq(median([4, 1, 2, 3]), 2.5);
  eq(median([]), null);
});

const RULES = { medianWindowDays: 30, medianDropPct: 7, minSamplesForMedian: 8, realertAfterHours: 24 };
const NOW = Date.parse("2026-09-01T12:00:00Z");

function hist(prices, { spacingDays = 1, shop = "morele" } = {}) {
  return prices.map((p, i) => ({
    ts: new Date(NOW - (prices.length - i) * spacingDays * DAY).toISOString(),
    best: { shop, price: p, url: "u" },
  }));
}

t("okno: odcina wpisy starsze niz N dni", () => {
  const h = hist([1, 2, 3], { spacingDays: 20 });
  eq(windowPrices(h, NOW, 30).length, 1);
});

t("minimum historyczne", () => eq(allTimeLow(hist([5000, 4800, 5200])), 4800));

const PROD = { id: "p", hardThreshold: 4800, baseline: 4999 };

t("alert: prog sztywny", () => {
  const r = evaluate(PROD, { shop: "morele", price: 4750 }, hist([5000, 5000]), RULES, {}, NOW);
  truthy(r.fire);
  truthy(r.reasons.some((x) => x.code === "hard"));
});

t("alert: cena rowna progowi NIE odpala", () => {
  const r = evaluate(PROD, { shop: "morele", price: 4800 }, hist([5000, 5000]), RULES, {}, NOW);
  eq(r.reasons.some((x) => x.code === "hard"), false);
});

t("alert: spadek wzgledem mediany", () => {
  const h = hist([6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000]);
  const r = evaluate({ id: "p", hardThreshold: 1 }, { shop: "morele", price: 5500 }, h, RULES, {}, NOW);
  truthy(r.fire);
  truthy(r.reasons.some((x) => x.code === "median"));
});

t("alert: mediana milczy przy zbyt malej probce", () => {
  const h = hist([6000, 6000, 6000]);
  const r = evaluate({ id: "p", hardThreshold: 1 }, { shop: "morele", price: 4000 }, h, RULES, {}, NOW);
  eq(r.reasons.some((x) => x.code === "median"), false);
});

t("alert: nowe minimum", () => {
  const r = evaluate({ id: "p", hardThreshold: 1 }, { shop: "morele", price: 4700 }, hist([5000, 4800]), RULES, {}, NOW);
  truthy(r.reasons.some((x) => x.code === "low"));
});

// Bez tego kazdy pierwszy start bota wysylal piec alertow "nowe minimum".
t("alert: pierwszy przebieg nigdy nie alarmuje", () => {
  const r = evaluate({ id: "p", hardThreshold: 99999 }, { shop: "morele", price: 4000 }, [], RULES, {}, NOW);
  eq(r.fire, false);
});

t("alert: powtorka w oknie ciszy jest wyciszana", () => {
  const state = { "p|morele|4750": NOW - 3600 * 1000 };
  const r = evaluate(PROD, { shop: "morele", price: 4750 }, hist([5000, 5000]), RULES, state, NOW);
  eq(r.fire, false);
  truthy(r.suppressed);
});

t("alert: po oknie ciszy odpala ponownie", () => {
  const state = { "p|morele|4750": NOW - 30 * 3600 * 1000 };
  const r = evaluate(PROD, { shop: "morele", price: 4750 }, hist([5000, 5000]), RULES, state, NOW);
  truthy(r.fire);
});

t("alert: brak ceny nie wybucha", () => {
  const r = evaluate(PROD, null, hist([5000]), RULES, {}, NOW);
  eq(r.fire, false);
});

// --- skrzynka podawcza (tor B) ---------------------------------------------

const IDS = new Set(["ks-8100ieg", "fogo-f8001isg"]);
const body = (o) => "Skan przez przegladarke\n\n```json\n" + JSON.stringify(o) + "\n```\n";

t("ingest: wyciaga blok json", () => {
  const r = extractBlock(body({ scan: "2026-09-01T05:00:00Z", offers: [] }));
  truthy(r.ok);
  eq(r.data.scan, "2026-09-01T05:00:00Z");
});

t("ingest: brak bloku to blad, nie wyjatek", () => {
  eq(extractBlock("zwykly tekst bez niczego").ok, false);
  eq(extractBlock("").ok, false);
  eq(extractBlock(null).ok, false);
});

t("ingest: zepsuty json to blad, nie wyjatek", () => {
  eq(extractBlock("```json\n{niepoprawny}\n```").ok, false);
});

t("ingest: poprawna oferta przechodzi", () => {
  const v = validate({ scan: "2026-09-01T05:00:00Z", offers: [
    { productId: "ks-8100ieg", site: "olx", price: 4200, condition: "used",
      url: "https://olx.pl/x", location: "Zyrardow", distanceKm: 25, note: "350 mth" },
  ]}, IDS);
  truthy(v.ok);
  eq(v.offers.length, 1);
  eq(v.offers[0].price, 4200);
});

t("ingest: nieznane productId odpada, reszta przechodzi", () => {
  const v = validate({ scan: "2026-09-01T05:00:00Z", offers: [
    { productId: "nie-ma-takiego", site: "olx", price: 4200 },
    { productId: "ks-8100ieg", site: "olx", price: 4300 },
  ]}, IDS);
  eq(v.offers.length, 1);
  truthy(v.errors.some((e) => e.includes("nieznane productId")));
});

t("ingest: cena poza zakresem odpada", () => {
  const v = validate({ scan: "2026-09-01T05:00:00Z", offers: [
    { productId: "ks-8100ieg", site: "olx", price: 5 },
    { productId: "ks-8100ieg", site: "olx", price: 999999 },
    { productId: "ks-8100ieg", site: "olx", price: "nie liczba" },
  ]}, IDS);
  eq(v.offers.length, 0);
});

t("ingest: oferta oznaczona jako uszkodzona jest pomijana", () => {
  const v = validate({ scan: "2026-09-01T05:00:00Z", offers: [
    { productId: "ks-8100ieg", site: "olx", price: 2000, condition: "damaged" },
  ]}, IDS);
  eq(v.offers.length, 0);
});

// Tresc Issue idzie prosto do HTML dashboardu, wiec musi byc oczyszczona
// juz na wejsciu, a nie dopiero przy renderowaniu.
t("ingest: url musi byc https i rozsadnej dlugosci", () => {
  const v = validate({ scan: "2026-09-01T05:00:00Z", offers: [
    { productId: "ks-8100ieg", site: "olx", price: 4200, url: "javascript:alert(1)" },
    { productId: "fogo-f8001isg", site: "olx", price: 4300, url: "http://olx.pl/x" },
  ]}, IDS);
  eq(v.offers.length, 2);
  eq(v.offers[0].url, null, "javascript: musi zostac odrzucone");
  eq(v.offers[1].url, null, "http bez s tez");
});

t("ingest: nieznany serwis ladue jako 'inne'", () => {
  const v = validate({ scan: "2026-09-01T05:00:00Z", offers: [
    { productId: "ks-8100ieg", site: "gumtree", price: 4200 },
  ]}, IDS);
  eq(v.offers[0].site, "inne");
});

t("ingest: absurdalnie duze zgloszenie odrzucone w calosci", () => {
  const offers = Array.from({ length: 201 }, () => ({ productId: "ks-8100ieg", site: "olx", price: 4200 }));
  eq(validate({ scan: "2026-09-01T05:00:00Z", offers }, IDS).ok, false);
});

t("ingest: alert tylko ponizej progu", () => {
  const prods = [{ id: "ks-8100ieg", name: "KS 8100iEG", hardThreshold: 5400 }];
  const offers = [
    { productId: "ks-8100ieg", site: "olx", price: 5300, condition: "used" },
    { productId: "ks-8100ieg", site: "olx", price: 5600, condition: "used" },
  ];
  const a = marketAlerts(offers, prods, {}, NOW, 24);
  eq(a.length, 1);
  eq(a[0].price, 5300);
});

t("ingest: ta sama oferta nie alarmuje dwa razy w oknie ciszy", () => {
  const prods = [{ id: "ks-8100ieg", name: "KS 8100iEG", hardThreshold: 5400 }];
  const offers = [{ productId: "ks-8100ieg", site: "olx", price: 5300 }];
  const state = {};
  eq(marketAlerts(offers, prods, state, NOW, 24).length, 1);
  eq(marketAlerts(offers, prods, state, NOW + 3600000, 24).length, 0);
  eq(marketAlerts(offers, prods, state, NOW + 30 * 3600000, 24).length, 1);
});

// --- konfiguracja -----------------------------------------------------------

t("config: parsuje sie i ma komplet pol", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "products.json"), "utf8"));
  truthy(cfg.products.length >= 5, "spodziewamy sie 5 modeli");
  const ids = new Set();
  for (const p of cfg.products) {
    truthy(p.id && !ids.has(p.id), `id musi byc unikalne: ${p.id}`);
    ids.add(p.id);
    truthy(p.name && p.baseline > 0 && p.hardThreshold > 0, `${p.id}: brak nazwy/bazy/progu`);
    truthy(p.hardThreshold < p.baseline, `${p.id}: prog musi byc nizszy niz cena bazowa`);
    truthy(Array.isArray(p.matchTokens) && p.matchTokens.length, `${p.id}: brak tokenow dopasowania`);
    truthy(Array.isArray(p.sources) && p.sources.length, `${p.id}: brak zrodel`);
    for (const s of p.sources) {
      truthy(s.shop && s.url && /^https:\/\//.test(s.url), `${p.id}/${s.shop}: zly URL`);
      truthy(s.kind === "shop" || s.kind === "aggregator", `${p.id}/${s.shop}: zly kind`);
    }
    // Kazdy produkt musi miec przynajmniej jedno zrodlo, ktore NIE jest best-effort.
    truthy(p.sources.some((s) => !s.bestEffort), `${p.id}: same zrodla best-effort`);
  }
});

t("config: reguly alertu sa sensowne", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "products.json"), "utf8"));
  const r = cfg.meta.alertRules;
  truthy(r.medianDropPct > 0 && r.medianDropPct < 30, "prog procentowy poza rozsadkiem");
  truthy(r.minSamplesForMedian >= 5, "za mala probka na mediane");
  truthy(r.realertAfterHours >= 6, "za krotkie okno ciszy przy skanie co 3h");
});

// --- podsumowanie -----------------------------------------------------------

console.log(`\n${pass} zdanych, ${fail} oblanych`);
for (const f of failures) console.log("  X " + f);
if (fail) process.exit(1);
