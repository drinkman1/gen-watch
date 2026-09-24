// Testy offline. Zero sieci - chodzi o to, zeby zlapac regresje w parsowaniu
// i w regulach alertu, zanim workflow zacznie sie dobijac do sklepow.
// Uruchomienie: npm run check

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parsePrice, normToken, fromJsonLd, fromMicrodata, fromMeta, fromText,
  extractPrice, pageMatchesProduct, fromPriceAttrs, priceBounds, guessBounds,
} from "./extract.mjs";
import { parseAggregatorRows, scrapeSource, detectInterstitial } from "./adapters/index.mjs";
import { FIXTURE_DIR, fixtureName, fixtureFetcher, loadFixture, summarize } from "./save-fixtures.mjs";
import { evaluate, median, allTimeLow, windowPrices, effectiveCost, fmt, DAY } from "./alerts.mjs";
import { extractBlock, validate, marketAlerts } from "./ingest.mjs";
import {
  escapeHtml, formatAlerts, formatDegraded, degradedKey,
  shouldSendDegraded, buildSendRequest, sendTelegram, planMessages,
  formatLocalStale,
} from "./telegram.mjs";
import {
  buildLocalStatus, localHealth, describeHealth, pendingAlert, mergePending, localAlertsForSnapshot, mailedKey,
} from "./localstatus.mjs";
import { mergeMarketDoc, mergeState, newerStatus, syncDataDirs } from "./datasync.mjs";
import { assessNode, assessBranch, assessSync, assessPulse, assessTasks } from "./doctor.mjs";
import {
  planPriceChanges, dailyReportDue, warsawParts, priceDayAgo, formatDailyReport, formatTestMessage, bestKey, FLAP_HOURS,
} from "./digest.mjs";

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

async function ta(name, fn) {
  try {
    await fn();
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
t("cena: angielski zapis bez separatora tysiecy", () => eq(parsePrice("1234.50"), 1234.5));
t("cena: undefined jak null", () => eq(parsePrice(undefined), null));
t("cena: liczba nieskonczona odpada", () => eq(parsePrice(Infinity), null));

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

// --- warstwa atrybutow i widelki --------------------------------------------

// Ta warstwa powstala, bo Tooles i Lewor oddaja poprawna strone produktu bez
// JSON-LD, microdata i og:price. Jest z zalozenia zgadywaniem, wiec jej
// jedynym zabezpieczeniem sa widelki - stad tyle testow wokol nich.

t("widelki: liczone z ceny bazowej", () => {
  eq(priceBounds(5688), { min: 2560, max: 11376 });
  eq(priceBounds(0), { min: null, max: null });
  eq(priceBounds(null), { min: null, max: null });
});

t("widelki: warstwa zgadujaca ma wezsze niz strukturalna", () => {
  const b = priceBounds(8999), g = guessBounds(8999);
  truthy(g.min > b.min && g.max < b.max, "zgadywanie musi miec ciasniejszy zakres");
});

// Prawdziwy blad z przebiegu 24.08.2026: Lewor oddal 18 559,66 zl przy Fogo
// F 8001 iSG (baza 8 999). Stara gorna granica 2,5x to przepuscila.
t("widelki: 18559 przy bazie 8999 odpada z warstwy atrybutowej", () => {
  const g = guessBounds(8999);
  const html = `<span class="price">18 559,66 zł</span>`;
  eq(fromPriceAttrs(html, g.min, g.max).price, null);
  const b = priceBounds(8999);
  const r = extractPrice(html, { min: b.min, max: b.max, guessMin: g.min, guessMax: g.max });
  eq(r.price, null);
  truthy(r.reason.includes("18559.66"), "raport ma nazwac odrzucona wartosc: " + r.reason);
});

// ...ale prawdziwa cena Toolesa (6 499 przy bazie 5 688) ma przejsc.
t("widelki: 6499 przy bazie 5688 przechodzi", () => {
  const g = guessBounds(5688), b = priceBounds(5688);
  const html = `<span class="price">6 499,00 zł</span>`;
  const r = extractPrice(html, { min: b.min, max: b.max, guessMin: g.min, guessMax: g.max });
  eq(r.price, 6499);
  eq(r.method, "priceattr");
});

t("priceattr: cena z klasy price", () => {
  const html = `<span class="product-price">5 299,00 zł</span>`;
  eq(fromPriceAttrs(html, 2560, 11376).price, 5299);
});

t("priceattr: cena z data-price obok klasy price", () => {
  const html = `<div class="price-box" data-price="5299.00"></div>`;
  eq(fromPriceAttrs(html, 2560, 11376).price, 5299);
});

t("priceattr: bez widelek nie zgaduje w ogole", () => {
  eq(fromPriceAttrs(`<span class="price">5299</span>`, null, null).price, null);
});

// Bez tego rata leasingu ("od 149 zl/mies.") wygladalaby jak okazja stulecia.
t("priceattr: rata i koszt dostawy odpadaja na widelkach", () => {
  const html = `<span class="price-installment">149,00 zł</span>
                <span class="price">5 299,00 zł</span>`;
  eq(fromPriceAttrs(html, 2560, 11376).price, 5299, "musi przeskoczyc rate");
});

t("warstwy: priceattr dopiero po meta", () => {
  const html = `<meta property="og:price:amount" content="5100"/><span class="price">5 299 zł</span>`;
  eq(extractPrice(html, { min: 2560, max: 11376 }).method, "meta");
});

t("warstwy: widelki odrzucaja bzdurna cene i mowia o tym wprost", () => {
  const html = `<meta property="og:price:amount" content="49"/>`;
  const r = extractPrice(html, { min: 2560, max: 11376 });
  eq(r.price, null);
  truthy(r.reason.includes("poza widelkami"), "powod musi nazywac widelki: " + r.reason);
});

t("warstwy: bez widelek zachowanie jak dawniej", () => {
  eq(extractPrice(`<meta property="og:price:amount" content="49"/>`, {}).price, 49);
});

// Zgadywanie jest opt-in: bez guessMin/guessMax warstwa atrybutowa milczy,
// nawet gdy na stronie jest liczba w rozsadnym zakresie.
t("warstwy: bez zgody na zgadywanie warstwa atrybutowa nie dziala", () => {
  const html = `<span class="price">5 299,00 zł</span>`;
  eq(extractPrice(html, { min: 2560, max: 11376, guessMin: Infinity, guessMax: -Infinity }).price, null);
  eq(extractPrice(html, { min: 2560, max: 11376, guessMin: 3128, guessMax: 8532 }).price, 5299);
});

// Amazon: pelna strona, wlasciwy tytul, a cena wylacznie w <span
// class="a-offscreen">. Zadna warstwa strukturalna jej nie widzi, wiec zrodlo
// dostaje jawny wzorzec z konfiguracji - to nie jest zgadywanie, tylko
// sprawdzony ksztalt konkretnego sklepu.
// Prawdziwy blad z 26.08.2026: wzorzec bez zakotwiczenia zlapal 3 899 zl
// z karuzeli "podobne produkty" i wywolal falszywy alert. Stad karuzela
// STOI W FIXTURZE PRZED cena wlasciwa - test przechodzi tylko wtedy, gdy
// wzorzec faktycznie kotwiczy sie w bloku corePrice.
t("amazon: cena z bloku corePrice, nie z karuzeli", () => {
  const html = `<div class="p13n-carousel"><span class="a-price"><span class="a-offscreen">3 899,00 zł</span></span></div>`
    + `<div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">6 499,00 zł</span>`
    + `<span aria-hidden="true">6 499,00 zł</span></span></div>`;
  const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "products.json"), "utf8"));
  const amazon = cfg.products
    .flatMap((p) => p.localSources || [])
    .find((s) => s.shop === "amazon");
  truthy(amazon && amazon.textPattern, "amazon musi miec textPattern w konfiguracji");
  eq(!!amazon.allowGuess, false, "amazon ma isc po jawnym wzorcu, nie po zgadywaniu");
  // Tak jak w skanie lokalnym: zgadywanie wylaczone, zostaje warstwa tekstowa.
  const r = extractPrice(html, {
    textPattern: amazon.textPattern,
    min: 2560, max: 11376, guessMin: Infinity, guessMax: -Infinity,
  });
  eq(r.price, 6499);
  eq(r.method, "text");
});

// e-katalog odpadl 26.08.2026 takze z lacza uzytkownika (403). Gdyby ktos
// kiedys dopisal go z powrotem do skanu lokalnego, ten test o tym przypomni.
t("skan lokalny: e-katalog nie wraca do localSources bez ponownego testu", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "products.json"), "utf8"));
  const hit = cfg.products.flatMap((p) => p.localSources || []).filter((s) => s.shop === "e-katalog");
  eq(hit.length, 0, "e-katalog oddaje 403 takze z domowego adresu");
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

// --- powiadomienia Telegram ----------------------------------------------

t("telegram: escapeHtml nie rusza zwyklego tekstu", () => {
  eq(escapeHtml("Fogo F 8001 iSG za 8 499 zl"), "Fogo F 8001 iSG za 8 499 zl");
});

t("telegram: escapeHtml zamienia < > &", () => {
  eq(escapeHtml("a & b <x>"), "a &amp; b &lt;x&gt;");
});

const A_HARD = {
  name: "Fogo F 8001 iSG",
  price: 8499,
  shop: "studionarzedzi",
  url: "https://studionarzedzi.pl/x?a=1&b=2",
  reasons: [
    { code: "hard", text: "ponizej progu 8 500 zl (jest 8 499 zl)" },
    { code: "low", text: "nowe minimum - poprzednie 8 599 zl" },
  ],
  effective: { cost: 8499, shippingKnown: false },
  baseline: 8999,
};

t("telegram: formatAlerts pusta lista to null", () => {
  eq(formatAlerts([]), null);
});

t("telegram: formatAlerts ma nazwe, cene, sklep i powod", () => {
  const s = formatAlerts([A_HARD]);
  truthy(s.includes("Fogo F 8001 iSG"), "brak nazwy w: " + s);
  truthy(s.includes(fmt(8499)), "brak ceny w: " + s);
  truthy(s.includes("studionarzedzi"), "brak sklepu w: " + s);
  truthy(s.includes("nowe minimum"), "brak powodu w: " + s);
});

t("telegram: formatAlerts liczy pozycje w naglowku", () => {
  truthy(formatAlerts([A_HARD, A_HARD]).includes("2"), "naglowek bez liczby alertow");
});

t("telegram: formatAlerts bez reasons pokazuje prog", () => {
  const s = formatAlerts([{ name: "KS 8100iEG", price: 5300, shop: "olx", url: null, threshold: 5400 }]);
  truthy(s.includes(fmt(5400)), "prog nie trafil do tekstu: " + s);
});

t("telegram: formatAlerts escapuje nazwe sklepu", () => {
  const s = formatAlerts([{ name: "X", price: 100, shop: "A & B", url: null, threshold: 90 }]);
  truthy(s.includes("A &amp; B"), "sklep nie zescapowany: " + s);
});

const BROKEN = [
  { name: "KS 9500iE S ATSR", shop: "konner-sohnen", status: "error" },
  { name: "Fogo F 8001 iSG", shop: "lewor", status: "noprice" },
];

t("telegram: degradedKey nie zalezy od kolejnosci", () => {
  eq(degradedKey(BROKEN), degradedKey([...BROKEN].reverse()));
});

t("telegram: degradedKey rozni sie przy innym zestawie", () => {
  truthy(degradedKey(BROKEN) !== degradedKey([BROKEN[0]]), "ten sam klucz mimo innej listy");
});

t("telegram: formatDegraded przy status ok to null", () => {
  eq(formatDegraded({ status: "ok", sourcesOk: 17, sourcesBad: 0 }, []), null);
});

t("telegram: formatDegraded wylicza zepsute zrodla", () => {
  const s = formatDegraded({ status: "degraded", sourcesOk: 15, sourcesBad: 2 }, BROKEN);
  truthy(s.includes("konner-sohnen"), "brak pierwszego zrodla: " + s);
  truthy(s.includes("lewor"), "brak drugiego zrodla: " + s);
  truthy(s.includes("15"), "brak licznika zrodel: " + s);
});

t("telegram: shouldSendDegraded tlumi powtorke w oknie ciszy", () => {
  const state = {};
  eq(shouldSendDegraded(state, BROKEN, NOW, 24), true);
  eq(shouldSendDegraded(state, BROKEN, NOW + 3600 * 1000, 24), false);
  eq(shouldSendDegraded(state, BROKEN, NOW + 30 * 3600 * 1000, 24), true);
});

t("telegram: shouldSendDegraded przepuszcza od razu przy zmianie zestawu", () => {
  const state = {};
  eq(shouldSendDegraded(state, BROKEN, NOW, 24), true);
  eq(shouldSendDegraded(state, [BROKEN[0]], NOW + 1000, 24), true);
});

t("telegram: buildSendRequest sklada url z tokenem i body HTML", () => {
  const r = buildSendRequest("czesc", { token: "T123", chatId: "999" });
  eq(r.url, "https://api.telegram.org/botT123/sendMessage");
  eq(r.method, "POST");
  const b = JSON.parse(r.body);
  eq(b.chat_id, "999");
  eq(b.text, "czesc");
  eq(b.parse_mode, "HTML");
  eq(b.disable_web_page_preview, true);
});

t("telegram: buildSendRequest bez tokenu albo chatId rzuca", () => {
  let a = false, b = false;
  try { buildSendRequest("x", { chatId: "9" }); } catch { a = true; }
  try { buildSendRequest("x", { token: "T" }); } catch { b = true; }
  truthy(a && b, "brak wyjatku przy niekompletnej konfiguracji");
});

const SNAP_OK_BASE = () => JSON.parse(JSON.stringify(SNAP_OK));
const SNAP_OK = {
  products: [
    { name: "KS 8100iE ATSR", sources: [{ shop: "morele", status: "ok", bestEffort: false }], best: { price: 4999 } },
    { name: "Fogo F 8001 iSG", sources: [{ shop: "lewor", status: "noprice", bestEffort: true }], best: { price: 8599 } },
  ],
  alerts: [],
  run: { status: "ok", sourcesOk: 2, sourcesBad: 0 },
};

t("telegram: planMessages nic nie zwraca przy czystym skanie bez alertow", () => {
  eq(planMessages(SNAP_OK, {}, NOW, 24), []);
});

t("telegram: planMessages przepuszcza alert cenowy", () => {
  const snap = { ...SNAP_OK, alerts: [{ name: "Fogo F 8001 iSG", price: 8499, shop: "studionarzedzi", url: null, threshold: 8500 }] };
  const msgs = planMessages(snap, {}, NOW, 24);
  eq(msgs.length, 1);
  truthy(msgs[0].includes("Fogo F 8001 iSG"), msgs[0]);
});

t("telegram: planMessages pomija zrodla best-effort przy degraded", () => {
  const snap = {
    products: [
      { name: "KS 9500iE S ATSR", sources: [{ shop: "konner-sohnen", status: "error", bestEffort: false }], best: null },
      { name: "Fogo F 8001 iSG", sources: [{ shop: "lewor", status: "noprice", bestEffort: true }], best: { price: 8599 } },
    ],
    alerts: [],
    run: { status: "degraded", sourcesOk: 1, sourcesBad: 1 },
  };
  const msgs = planMessages(snap, {}, NOW, 24);
  eq(msgs.length, 1);
  truthy(msgs[0].includes("konner-sohnen"), msgs[0]);
  truthy(!msgs[0].includes("lewor"), "best-effort nie moze trafic do wiadomosci: " + msgs[0]);
});

t("telegram: planMessages tlumi powtorke sygnalu degraded", () => {
  const snap = {
    products: [{ name: "KS 9500iE S ATSR", sources: [{ shop: "konner-sohnen", status: "error", bestEffort: false }], best: null }],
    alerts: [],
    run: { status: "degraded", sourcesOk: 0, sourcesBad: 1 },
  };
  const state = {};
  eq(planMessages(snap, state, NOW, 24).length, 1);
  eq(planMessages(snap, state, NOW + 3600 * 1000, 24).length, 0);
});

// --- puls toru B ------------------------------------------------------------

// Tor B milczal od 26.08.2026 i nikt tego nie zauwazyl. Te testy pilnuja, ze
// cisza jest widoczna: brak pliku, stary plik i plik z zerem ofert.

const RES_OK = [
  { productId: "ks-8100ieg", shop: "amazon", status: "ok", price: 6499 },
  { productId: "ks-8100ieg", shop: "ceneo", status: "blocked", price: null, issue: "HTTP 403" },
];
const RES_NONE = [
  { productId: "ks-8100ieg", shop: "amazon", status: "noprice", price: null, issue: "zadna warstwa" },
];

t("puls: udany przebieg ustawia lastOkAt na swoj czas", () => {
  const s = buildLocalStatus({ ts: "2026-09-01T05:00:00.000Z", code: "abc", results: RES_OK });
  eq(s.lastOkAt, "2026-09-01T05:00:00.000Z");
  eq([s.ok, s.bad], [1, 1]);
  eq(s.sources[1].issue, "HTTP 403");
});

t("puls: przebieg bez ceny przenosi lastOkAt z poprzedniego", () => {
  const prev = { ts: "2026-09-01T05:00:00.000Z", lastOkAt: "2026-09-01T05:00:00.000Z" };
  const s = buildLocalStatus({ ts: "2026-09-01T16:00:00.000Z", results: RES_NONE, prev });
  eq(s.lastOkAt, "2026-09-01T05:00:00.000Z");
  eq(s.ok, 0);
});

t("puls: brak pliku to cisza", () => {
  const h = localHealth(null, NOW, 36);
  eq(h.stale, true);
  truthy(describeHealth(h).includes("nigdy"), describeHealth(h));
});

t("puls: swiezy udany skan nie jest cisza", () => {
  const s = buildLocalStatus({ ts: new Date(NOW - 10 * 3600000).toISOString(), results: RES_OK });
  const h = localHealth(s, NOW, 36);
  eq(h.stale, false);
  eq(h.ageHours, 10);
});

t("puls: udany skan sprzed 40 h to cisza", () => {
  const s = buildLocalStatus({ ts: new Date(NOW - 40 * 3600000).toISOString(), results: RES_OK });
  eq(localHealth(s, NOW, 36).stale, true);
});

// Laptop chodzi, ale ochrona antybotowa odrzuca wszystko - plik jest swiezy,
// a mimo to cisza, bo liczy sie ostatni UDANY skan.
t("puls: swiezy przebieg z zerem ofert i bez wczesniejszego sukcesu to cisza", () => {
  const s = buildLocalStatus({ ts: new Date(NOW - 3600000).toISOString(), results: RES_NONE });
  const h = localHealth(s, NOW, 36);
  eq(h.stale, true);
  truthy(describeHealth(h).includes("bez ani jednej ceny"), describeHealth(h));
});

t("telegram: cisza toru B idzie raz na okno i wraca po nowym sukcesie", () => {
  const stale = localHealth(null, NOW, 36);
  const snap = { ...SNAP_OK_BASE(), local: stale };
  const state = {};
  const first = planMessages(snap, state, NOW, 24);
  eq(first.length, 1);
  truthy(first[0].includes("tor B milczy"), first[0]);
  eq(planMessages(snap, state, NOW + 3600000, 24).length, 0);
  eq(planMessages(snap, state, NOW + 25 * 3600000, 24).length, 1);
  const fresh = localHealth(buildLocalStatus({ ts: new Date(NOW - 3600000).toISOString(), results: RES_OK }), NOW, 36);
  eq(planMessages({ ...SNAP_OK_BASE(), local: fresh }, state, NOW, 24).length, 0);
  eq(formatLocalStale(fresh), null);
});

// --- scalanie z galezia data przed force-pushem -----------------------------

const scan = (ts, price) => ({ ts, offers: [{ productId: "p", price }] });

t("scalanie: unia skanow po ts, posortowana", () => {
  const local = { productId: "p", scans: [scan("2026-09-01T05:00:00Z", 1), scan("2026-09-01T16:00:00Z", 2)] };
  const remote = { productId: "p", scans: [scan("2026-09-01T05:00:00Z", 1), scan("2026-09-01T10:00:00Z", 3)] };
  const m = mergeMarketDoc(local, remote);
  eq(m.scans.map((s) => s.offers[0].price), [1, 3, 2]);
});

t("scalanie: przy tym samym ts wygrywa kopia lokalna", () => {
  const m = mergeMarketDoc({ scans: [scan("2026-09-01T05:00:00Z", 1)] }, { productId: "p", scans: [scan("2026-09-01T05:00:00Z", 9)] });
  eq(m.scans.length, 1);
  eq(m.scans[0].offers[0].price, 1);
  eq(m.productId, "p");
});

t("scalanie: przycina do keepScans najnowszych", () => {
  const many = Array.from({ length: 15 }, (_, i) => scan(new Date(NOW + i * 3600000).toISOString(), i));
  const m = mergeMarketDoc({ scans: many.slice(0, 10) }, { scans: many.slice(5) }, 12);
  eq(m.scans.length, 12);
  eq(m.scans[0].offers[0].price, 3);
});

t("scalanie: state bierze pozniejszy znacznik per klucz", () => {
  eq(mergeState({ a: 5, b: 1 }, { a: 3, c: 7 }), { a: 5, c: 7, b: 1 });
});

t("scalanie: status toru B - wygrywa nowszy", () => {
  const a = { ts: "2026-09-01T05:00:00Z" }, b = { ts: "2026-09-01T16:00:00Z" };
  eq(newerStatus(a, b), b);
  eq(newerStatus(b, a), b);
  eq(newerStatus(null, a), a);
  eq(newerStatus(a, null), a);
});

// Caly scenariusz wyscigu na plikach: tor A pobral data, w trakcie jego
// przebiegu tor B dopisal skan i puls. Przed force-pushem ma to wrocic.
t("scalanie: skan toru B w trakcie przebiegu toru A nie ginie", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gw-sync-"));
  const L = path.join(root, "local"), R = path.join(root, "remote");
  const w = (dir, rel, data) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
  };
  const r = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
  const old = scan("2026-08-26T08:05:00Z", 6590);
  const fromB = scan("2026-09-01T05:00:00Z", 6400);
  w(L, "market/ks-8100ie-atsr.json", { productId: "ks-8100ie-atsr", scans: [old] });
  w(L, "state.json", { "p|morele|5688": 100 });
  w(L, "history/ks-8100ie-atsr.json", { productId: "ks-8100ie-atsr", entries: [{ ts: "x" }] });
  w(R, "market/ks-8100ie-atsr.json", { productId: "ks-8100ie-atsr", scans: [old, fromB] });
  w(R, "state.json", { "market|ks-8100ie-atsr|inne|6400": 200 });
  w(R, "local-status.json", { ts: "2026-09-01T05:00:00Z", lastOkAt: "2026-09-01T05:00:00Z", ok: 1, bad: 0 });
  w(R, "history/ks-8100ie-atsr.json", { productId: "ks-8100ie-atsr", entries: [] });
  try {
    const changed = syncDataDirs(L, R);
    eq(r(L, "market/ks-8100ie-atsr.json").scans.length, 2);
    eq(r(L, "state.json"), { "market|ks-8100ie-atsr|inne|6400": 200, "p|morele|5688": 100 });
    eq(r(L, "local-status.json").ok, 1);
    eq(r(L, "history/ks-8100ie-atsr.json").entries.length, 1, "historia toru A nie moze byc ruszona");
    eq(syncDataDirs(L, R), [], "drugie scalenie nic nie zmienia");
    truthy(changed.length === 3, "zmienione: " + changed.join(","));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- diagnostyka toru B (--doctor) ------------------------------------------

t("doctor: Node ponizej 20 to blad", () => {
  eq(assessNode("v18.19.0").level, "fail");
  eq(assessNode("v20.11.1").level, "ok");
});

t("doctor: skan z innej galezi niz main to blad", () => {
  eq(assessBranch("olx-lokalny", []).level, "fail");
  eq(assessBranch("main", []).level, "ok");
  eq(assessBranch("main", [" src/selftest.mjs"]).level, "warn");
});

// Dokladnie przypadek z 26.08.2026: dwa lokalne commity OLX na main.
t("doctor: lokalne commity na main to blad z podpowiedzia", () => {
  const r = assessSync("2\t0\n");
  eq(r.level, "fail");
  truthy(r.detail.includes("git push origin main:"), r.detail);
  eq(assessSync("0\t3").level, "info");
  eq(assessSync("0\t0").level, "ok");
  eq(assessSync("").level, "warn");
});

t("doctor: puls - brak, swiezy, zepsuty JSON", () => {
  eq(assessPulse(null, NOW).level, "fail");
  eq(assessPulse("{nie json", NOW).level, "fail");
  const fresh = JSON.stringify({ ts: new Date(NOW - 3600000).toISOString(), lastOkAt: new Date(NOW - 3600000).toISOString(), ok: 2, bad: 1 });
  eq(assessPulse(fresh, NOW).level, "ok");
});

const TASK_OK = { Name: "gen-watch skan lokalny", State: "Ready", LogonType: "Interactive",
  DisallowOnBattery: false, StartWhenAvailable: true, LastRun: "2026-09-24 07:00", LastResult: 0 };

t("doctor: brak zadania w Harmonogramie to blad", () => {
  const r = assessTasks([]);
  eq(r.length, 1);
  eq(r[0].level, "fail");
  truthy(r[0].detail.includes("zainstaluj-harmonogram"), r[0].detail);
});

t("doctor: poprawne zadanie przechodzi, pojedynczy obiekt z ConvertTo-Json tez", () => {
  eq(assessTasks([TASK_OK]).map((x) => x.level), ["ok"]);
  eq(assessTasks(TASK_OK).map((x) => x.level), ["ok"]);
});

// Kazda z tych przyczyn po cichu zatrzymuje skan na laptopie.
t("doctor: bateria, przegapione przebiegi, S4U, wylaczone, dwa zadania", () => {
  const lv = (over) => assessTasks([{ ...TASK_OK, ...over }]).filter((x) => x.level !== "ok").map((x) => x.level);
  eq(lv({ DisallowOnBattery: true }), ["warn"]);
  eq(lv({ StartWhenAvailable: false }), ["warn"]);
  eq(lv({ LogonType: "S4U" }), ["fail"]);
  eq(lv({ State: "Disabled" }), ["fail"]);
  eq(lv({ LastResult: 1 }), ["warn"]);
  eq(lv({ LastResult: 2147942402 }), ["fail"]);
  eq(lv({ LastRun: null, LastResult: 267011 }), ["warn"]);
  eq(assessTasks([TASK_OK, { ...TASK_OK, Name: "stare" }])[0].level, "warn");
});

// --- alerty toru B ida tym samym Issue co alerty toru A --------------------

// Wczesniej alert progowy ze skanu lokalnego (Ceneo, Amazon, Komputronik)
// konczyl w logu na Windowsie i ewentualnie na Telegramie - nigdy w mailu.

const PROD_EG = { id: "ks-8100ieg", name: "Könner & Söhnen KS 8100iEG", baseline: 5688, hardThreshold: 5400 };
const T0 = new Date(NOW - 2 * 3600000).toISOString();
const PA = pendingAlert({ productId: "ks-8100ieg", name: PROD_EG.name, site: "inne", shop: "amazon",
  price: 5300, url: "https://www.amazon.pl/dp/B09DTLH354", threshold: 5400, discountPct: 4, seenAt: T0 });

t("tor B alert: prawdziwy sklep zamiast 'inne', id z chwila skanu", () => {
  eq(PA.shop, "amazon");
  truthy(PA.id.includes("|inne|5300|") && PA.id.endsWith(T0), PA.id);
  eq(PA.telegramSent, false);
});

t("tor B alert: kolejny przebieg nie kasuje niewyslanego, 48 h to koniec", () => {
  const prev = { ts: T0, lastOkAt: T0, pendingAlerts: [PA] };
  const s = buildLocalStatus({ ts: new Date(NOW).toISOString(), results: RES_OK, prev });
  eq(s.pendingAlerts.length, 1);
  eq(mergePending([PA], [], Date.parse(T0) + 49 * 3600000).length, 0);
  eq(mergePending([PA], [PA], NOW).length, 1, "ten sam alert nie dubluje sie");
});

t("tor B alert: w snapshot.alerts w ksztalcie toru A (Issue, dashboard)", () => {
  const got = localAlertsForSnapshot({ pendingAlerts: [PA] }, {}, [PROD_EG], NOW);
  eq(got.length, 1);
  const a = got[0].alert;
  eq(a.shop, "amazon (skan lokalny)");
  eq(a.baseline, 5688);
  eq(a.effective, { cost: 5088, shippingKnown: false }, "rabat 4% w koszcie koncowym");
  truthy(a.reasons[0].code === "hard" && a.reasons[0].text.includes("skan lokalny"), a.reasons[0].text);
  eq(got[0].key, mailedKey(PA));
});

t("tor B alert: wyslany raz - drugi przebieg toru A go pomija", () => {
  const state = { [mailedKey(PA)]: NOW - 3600000 };
  eq(localAlertsForSnapshot({ pendingAlerts: [PA] }, state, [PROD_EG], NOW).length, 0);
  eq(localAlertsForSnapshot(null, {}, [PROD_EG], NOW).length, 0);
});

t("tor B alert: juz wyslany na Telegram przez tor B nie idzie tam drugi raz", () => {
  const sent = localAlertsForSnapshot({ pendingAlerts: [{ ...PA, telegramSent: true }] }, {}, [PROD_EG], NOW)[0].alert;
  const fresh = localAlertsForSnapshot({ pendingAlerts: [PA] }, {}, [PROD_EG], NOW)[0].alert;
  eq(planMessages({ ...SNAP_OK_BASE(), alerts: [sent] }, {}, NOW, 24).length, 0);
  eq(planMessages({ ...SNAP_OK_BASE(), alerts: [fresh] }, {}, NOW, 24).length, 1);
});

// --- strona posrednia antybotu ---------------------------------------------

// Prawdziwy przypadek z 24.09.2026: Amazon oddal torowi B 4 kB z przyciskiem
// "Kontynuuj zakupy" i skonczylo sie jako mismatch. To odmowa, nie inna strona.
t("antybot: strona posrednia Amazona i Cloudflare rozpoznana", () => {
  truthy(detectInterstitial("<title>Amazon.pl</title><p>Kliknij poniższy przycisk, aby kontynuować zakupy</p><button>Kontynuuj zakupy</button>"));
  truthy(detectInterstitial("<title>Cierpliwości...</title><p>Przeprowadzanie weryfikacji zabezpieczeń</p>"));
  truthy(detectInterstitial("<title>Just a moment...</title>"));
  // Profimarket 24.09.2026 - zapisana strona w test/fixtures.
  truthy(detectInterstitial("<title>Proszę czekać…</title><div class=\"throbber\"></div>"));
});

t("antybot: pelna karta produktu ze slowami 'kontynuuj zakupy' to nie strona posrednia", () => {
  const big = "<h1>KS 8100iEG</h1>" + "x".repeat(40000) + "<a>Kontynuuj zakupy</a>";
  eq(detectInterstitial(big), null);
  eq(detectInterstitial(JSONLD_SIMPLE), null);
});

// --- parsery na zapisanym HTML (test/fixtures) ------------------------------

// Kazde zrodlo z konfiguracji ma zapisana prawdziwa strone i przechodzi przez
// pelny scrapeSource: dopasowanie produktu, warstwy ekstrakcji, widelki. Zmiana
// ukladu strony sklepu albo zmiana parsera wychodzi tu, a nie w produkcji.
// Odswiezenie po zmianie strony: node src/save-fixtures.mjs (README).

const FIX_CFG = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "products.json"), "utf8"));
const fixtureNames = fs.existsSync(FIXTURE_DIR)
  ? fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort()
  : [];
const configured = FIX_CFG.products.flatMap((p) => [
  ...(p.sources || []).map((s) => ({ p, s, track: "a" })),
  ...(p.localSources || []).map((s) => ({ p, s, track: "b" })),
]);

t("fixture: kazde zrodlo z konfiguracji ma zapisana strone", () => {
  const missing = configured.map(({ p, s }) => fixtureName(p.id, s.shop)).filter((n) => !fixtureNames.includes(n));
  eq(missing, [], "brak fixture'ow - uruchom node src/save-fixtures.mjs:");
});

const methodsCovered = new Set();
for (const name of fixtureNames) {
  await ta(`fixture: ${name}`, async () => {
    const { meta, html } = loadFixture(name);
    const hit = configured.find(({ p, s, track }) => p.id === meta.productId && s.shop === meta.shop && track === meta.track);
    truthy(hit, `fixture bez zrodla w konfiguracji (${meta.productId}/${meta.shop}, tor ${meta.track}) - usun go albo przywroc zrodlo`);
    const got = summarize(await scrapeSource(hit.p, hit.s, { fetcher: fixtureFetcher(meta, html) }));
    eq(got, meta.expect, `strona z ${meta.capturedAt.slice(0, 10)}:`);
    if (got.method) methodsCovered.add(got.method);
  });
}

// --- Telegram: zmiany cen i raport dzienny ----------------------------------

// Bot pisal tylko przy alercie i awarii - przez miesiac prawie nic. Uzytkownik
// chce wiedziec, co sie dzieje: kazda zmiana najnizszej ceny i raport rano.

const ATSR = {
  id: "ks-8100ie-atsr", name: "KS 8100iE ATSR", hardThreshold: 4800, baseline: 4999,
  best: { shop: "kupagregat", price: 4999, url: "https://kupagregat.pl/p/x" },
  sources: [{ shop: "kupagregat", status: "ok" }, { shop: "morele", status: "ok" }],
};
const withBest = (shop, price, down = []) => ({
  ...ATSR, best: { shop, price, url: null },
  sources: ATSR.sources.map((s) => ({ ...s, status: down.includes(s.shop) ? "error" : "ok" })),
});

t("zmiany cen: pierwszy przebieg tylko zapisuje stan", () => {
  const r = planPriceChanges([ATSR], {}, NOW);
  eq(r.text, null);
  eq(r.silent[bestKey(ATSR.id)].price, 4999);
});

t("zmiany cen: spadek i wzrost, z odlegloscia od progu", () => {
  const state = { [bestKey(ATSR.id)]: { price: 4999, shop: "kupagregat" } };
  const down = planPriceChanges([withBest("kupagregat", 4899)], state, NOW);
  truthy(down.text.includes("📉") && down.text.includes(fmt(4899)) && down.text.includes("brakuje " + fmt(99)), down.text);
  eq(down.updates[bestKey(ATSR.id)].price, 4899);
  const up = planPriceChanges([withBest("kupagregat", 5099)], state, NOW);
  truthy(up.text.includes("📈") && up.text.includes("+2%"), up.text);
  const below = planPriceChanges([withBest("kupagregat", 4700)], state, NOW);
  truthy(below.text.includes("PONIZEJ progu"), below.text);
});

t("zmiany cen: ta sama cena nic nie wysyla", () => {
  const state = { [bestKey(ATSR.id)]: { price: 4999, shop: "kupagregat" } };
  eq(planPriceChanges([ATSR], state, NOW).text, null);
});

// Prawdziwy wzorzec: KupAgregat co kilka przebiegow nie odpowiada, wtedy
// najnizsza cena skacze do Morele i wraca. To nie jest zmiana ceny.
t("zmiany cen: migotanie sklepu nie daje wiadomosci", () => {
  const state = { [bestKey(ATSR.id)]: { price: 4999, shop: "kupagregat" } };
  const flap = planPriceChanges([withBest("morele", 6287.43, ["kupagregat"])], state, NOW);
  eq(flap.text, null);
  truthy(flap.silent[bestKey(ATSR.id)].missingSince, "musi zapamietac poczatek niedostepnosci");
  Object.assign(state, flap.silent);
  const back = planPriceChanges([ATSR], state, NOW + 3 * 3600000);
  eq(back.text, null, "powrot tej samej ceny to nie zmiana");
  eq(back.silent[bestKey(ATSR.id)].missingSince, undefined, "powrot czysci znacznik");
});

t("zmiany cen: po 24 h niedostepnosci sklepu nowa cena jest zglaszana z powodem", () => {
  const state = { [bestKey(ATSR.id)]: { price: 4999, shop: "kupagregat", missingSince: new Date(NOW - (FLAP_HOURS + 1) * 3600000).toISOString() } };
  const r = planPriceChanges([withBest("morele", 6287.43, ["kupagregat"])], state, NOW);
  truthy(r.text && r.text.includes("nie odpowiada od 24 h"), r.text);
});

t("zmiany cen: tanszy inny sklep przy dzialajacym poprzednim to zmiana", () => {
  const state = { [bestKey(ATSR.id)]: { price: 4999, shop: "kupagregat" } };
  truthy(planPriceChanges([withBest("morele", 4950)], state, NOW).text.includes(fmt(4950)));
});

t("raport dzienny: czas warszawski, raz na dobe, nie przed 7:00", () => {
  // 2026-09-01T04:30Z = 6:30 w Warszawie (CEST), 05:10Z = 7:10.
  eq(warsawParts(Date.parse("2026-09-01T04:30:00Z")), { date: "2026-09-01", hour: 6 });
  eq(dailyReportDue({}, Date.parse("2026-09-01T04:30:00Z"), 7), null);
  eq(dailyReportDue({}, Date.parse("2026-09-01T05:10:00Z"), 7), "telegram|daily|2026-09-01");
  eq(dailyReportDue({ "telegram|daily|2026-09-01": 1 }, Date.parse("2026-09-01T09:00:00Z"), 7), null);
  // Zima (CET): 06:10Z = 7:10.
  eq(warsawParts(Date.parse("2026-11-10T06:10:00Z")).hour, 7);
});

t("raport dzienny: zmiana od wczoraj z historii", () => {
  // Wpisy co 12 h: 36 h, 24 h i 12 h temu - "wczoraj" to wpis sprzed 24 h.
  eq(priceDayAgo(hist([5100, 5050, 4999], { spacingDays: 0.5 }), NOW), 5050);
  eq(priceDayAgo([], NOW), null);
});

t("raport dzienny: tresc i dlugosc", () => {
  const products = [ATSR, { ...ATSR, id: "b", name: "Fogo F 8001 iSG", best: null }];
  const text = formatDailyReport({
    snapshot: { products, local: localHealth(null, NOW, 36) },
    histories: { [ATSR.id]: hist([5100, 5050, 4999], { spacingDays: 0.5 }) },
    markets: { [ATSR.id]: { scans: [{ ts: new Date(NOW - 3600000).toISOString(), offers: [{ price: 4700, site: "olx", condition: "used", match: "czesciowe" }] }] } },
    deadline: "2026-11-22", dashboardUrl: "https://drinkman1.github.io/gen-watch/", nowMs: NOW,
  });
  for (const want of ["KS 8100iE ATSR", fmt(4999), "−" + fmt(51) + " od wczoraj", "brakuje " + fmt(199),
    "rynek (24 h): " + fmt(4700), "do obejrzenia", "brak ceny", "tor B", "Do terminu zakupu", "dashboard"]) {
    truthy(text.includes(want), `brak "${want}" w raporcie:\n${text}`);
  }
  truthy(text.length < 4096, "raport za dlugi dla Telegrama: " + text.length);
});

t("telegram: wiadomosc testowa ma godzine i ceny", () => {
  const s = formatTestMessage({ products: [ATSR] }, NOW);
  truthy(s.includes("test polaczenia") && s.includes(fmt(4999)), s);
});

t("config: sekcja telegram", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "products.json"), "utf8"));
  const tg = cfg.meta.telegram;
  truthy(tg && typeof tg.daily === "boolean" && typeof tg.changes === "boolean", "meta.telegram.daily/changes");
  truthy(tg.dailyFromHour >= 5 && tg.dailyFromHour <= 12, "raport rano");
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
  // Tor B chodzi 2x dziennie: ponizej 24 h kazdy opuszczony przebieg alarmuje,
  // powyzej 72 h cisza wychodzi za pozno przy zakupie z terminem.
  truthy(r.localStaleHours >= 24 && r.localStaleHours <= 72, "prog ciszy toru B poza 24-72 h");
});

// --- powiadomienia Telegram: wysylka (z wstrzyknietym fetch) --------------

await ta("telegram: sendTelegram zwraca ok:true przy 200", async () => {
  const fake = async () => ({ ok: true, status: 200 });
  const r = await sendTelegram("x", { token: "T", chatId: "1", fetchImpl: fake });
  eq(r.ok, true);
});

await ta("telegram: sendTelegram zwraca ok:false bez rzutu przy 429", async () => {
  const fake = async () => ({ ok: false, status: 429, json: async () => ({ description: "Too Many Requests" }) });
  const r = await sendTelegram("x", { token: "T", chatId: "1", fetchImpl: fake });
  eq(r.ok, false);
  eq(r.status, 429);
});

await ta("telegram: sendTelegram lapie wyjatek sieci", async () => {
  const fake = async () => { throw new Error("ECONNRESET"); };
  const r = await sendTelegram("x", { token: "T", chatId: "1", fetchImpl: fake });
  eq(r.ok, false);
  truthy(String(r.error).includes("ECONNRESET"), "wyjatek nie trafil do error: " + r.error);
});

// --- podsumowanie -----------------------------------------------------------

console.log(`Fixture'y: ${fixtureNames.length} stron, warstwy na prawdziwym HTML: ${[...methodsCovered].sort().join(", ") || "-"}`);
console.log(`\n${pass} zdanych, ${fail} oblanych`);
for (const f of failures) console.log("  X " + f);
if (fail) process.exit(1);
