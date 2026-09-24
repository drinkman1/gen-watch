import { smartFetch } from "../fetch.mjs";
import {
  extractPrice, pageMatchesProduct, parsePrice, stripTags, decodeEntities, normToken, priceBounds, guessBounds,
} from "../extract.mjs";

// Kazdy adapter zwraca liste ofert w jednym ksztalcie:
//   { shop, price, currency, availability, url, method, note }
// plus osobno { status, issues } opisujace zdrowie samego zrodla.
// Rozdzielenie jest celowe: zero ofert przy status "ok" znaczy "sprawdzone,
// nie ma", a zero ofert przy status "blocked" znaczy "nie wiemy". Zlanie tych
// dwoch przypadkow w jedno bylo najczestszym bledem w role-watch.

function ok(offers, issues = []) { return { status: "ok", offers, issues }; }
function fail(status, issues) { return { status, offers: [], issues }; }

// Diagnostyka dla zrodel, ktore nie oddaly ceny. Bez tego "mismatch" znaczy
// tylko "cos poszlo nie tak" i trzeba zgadywac, czy to zmiana ukladu strony,
// czy strona-przekladaniec od ochrony antybotowej. Tytul i dlugosc odpowiedzi
// rozstrzygaja to w jednym spojrzeniu.
function diagnose(html, res) {
  const out = [];
  const t = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html || "");
  out.push(`tytul: "${t ? decodeEntities(t[1]).trim().slice(0, 80) : "(brak)"}"`);
  out.push(`${Math.round((html || "").length / 1024)} kB, via ${res.via}`);
  const head = stripTags(html || "").slice(0, 120);
  if (head) out.push(`tekst: "${head}"`);
  return out;
}

// Strona posrednia ochrony antybotowej: Amazon ("Kliknij ponizszy przycisk,
// aby kontynuowac zakupy", 4 kB zamiast 1,3 MB) i Cloudflare ("Cierpliwosci...
// Przeprowadzanie weryfikacji zabezpieczen"). To nie jest "inna strona"
// (mismatch), tylko odmowa - i tak ja raportujemy. Obchodzic jej nie bedziemy.
// Limit dlugosci, bo prawdziwa karta produktu tez potrafi zawierac slowa
// "kontynuuj zakupy" (np. w koszyku), a strona posrednia jest zawsze mala.
const INTERSTITIAL = [
  [/kontynuowa[cć] zakup|continue shopping/i, "Amazon: przycisk 'Kontynuuj zakupy'"],
  [/cierpliwo[sś]ci|weryfikacj\w* zabezpiecze|just a moment|checking your browser/i, "Cloudflare: weryfikacja zabezpieczen"],
  // Profimarket 24.09.2026: 12 kB, tytul "Prosze czekac...", spinner i skrypt.
  [/prosz[eę] czeka[cć]/i, "strona 'Prosze czekac' ze skryptem weryfikujacym"],
];

export function detectInterstitial(html) {
  const h = String(html || "");
  if (h.length > 30000) return null;
  const text = stripTags(h).slice(0, 2000);
  for (const [re, label] of INTERSTITIAL) if (re.test(text)) return label;
  return null;
}

// `fetcher` wstrzykiwany w testach na zapisanym HTML (test/fixtures);
// w produkcji zawsze smartFetch.
export async function scrapeShop(product, source, { fetcher = smartFetch } = {}) {
  const res = await fetcher(source.url, {
    needsBrowser: !!source.needsBrowser,
    waitFor: source.waitFor || null,
  });

  if (!res.ok) {
    const blocked = [401, 403, 406, 429].includes(res.status);
    return fail(blocked ? "blocked" : "error", [
      `HTTP ${res.status || "-"}${res.error ? " (" + res.error + ")" : ""}`,
    ]);
  }

  const wall = detectInterstitial(res.html);
  if (wall) return fail("blocked", [`strona posrednia antybotu (${wall})`, ...diagnose(res.html, res)]);

  const match = pageMatchesProduct(res.html, product);
  if (!match.ok) {
    // Strona wstala, ale opisuje co innego - najczesciej przekierowanie na
    // kategorie po wygaszeniu produktu albo strona-przekladaniec od ochrony.
    // Cena z takiej strony jest gorsza niz brak, ale POKAZUJEMY ja w raporcie:
    // jesli wyglada sensownie, znaczy ze zawiodlo dopasowanie, a nie zrodlo.
    const peek = extractPrice(res.html, {});
    return fail("mismatch", [
      `strona nie zawiera identyfikatora produktu${match.by ? " (kolizja z " + match.by + ")" : ""}`,
      ...(peek.price != null ? [`odrzucona cena ze strony: ${peek.price} (${peek.method})`] : []),
      ...diagnose(res.html, res),
    ]);
  }

  const expect = [product.ean, ...(product.matchTokens || [])].filter(Boolean);
  const { min, max } = priceBounds(product.baseline);
  // Warstwa atrybutowa jest OPT-IN per sklep. Domyslnie wylaczona, bo zgaduje.
  // Historia tej decyzji: u Lewora zwrocila kolejno 18 559,66 zl i 12 667,16 zl
  // przy realnej cenie ok. 9 000 - zaciskanie widelek bylo gra w kotka i myszke.
  // Wlaczamy ja tylko tam, gdzie zobaczylismy, ze oddaje sensowna wartosc.
  const g = source.allowGuess ? guessBounds(product.baseline) : { min: null, max: null };
  const got = extractPrice(res.html, {
    expectTokens: expect, textPattern: source.textPattern,
    min, max,
    guessMin: source.allowGuess ? g.min : Infinity,
    guessMax: source.allowGuess ? g.max : -Infinity,
  });

  if (got.price == null) {
    return fail("noprice", [got.reason || "brak ceny", ...diagnose(res.html, res)]);
  }

  const issues = [];
  if (got.method === "text") issues.push("cena z warstwy tekstowej - traktuj z rezerwa");
  if (got.method === "priceattr") issues.push("cena z atrybutu HTML, nie z danych strukturalnych");
  if (got.matchedExpected === false) issues.push("JSON-LD nie potwierdzil nazwy produktu");
  if (res.escalatedFrom) issues.push(`zwykly fetch odbity (${res.escalatedFrom}), poszlo przez Chromium`);

  return ok([{
    shop: source.shop,
    price: got.price,
    currency: got.currency || "PLN",
    availability: got.availability,
    url: res.finalUrl || source.url,
    method: got.method,
    shipping: source.shipping != null ? source.shipping : null,
    discountPct: source.discountPct || 0,
    note: source.shippingNote || null,
  }], issues);
}

// --- e-katalog --------------------------------------------------------------

// e-katalog oddaje liste sklepow zwyklym HTTP, bez Cloudflare. Nie znam jego
// wewnetrznych klas i nie zamierzam ich zgadywac, wiec parser jest dwustopniowy:
// najpierw probuje wyciagnac pary sklep+cena, a jak sie nie uda, cofa sie do
// samej ceny minimalnej z JSON-LD. Druga warstwa wystarcza do alertu - tracimy
// tylko informacje, KTORY sklep jest najtanszy.
export async function scrapeAggregator(product, source, { fetcher = smartFetch } = {}) {
  const res = await fetcher(source.url, { needsBrowser: !!source.needsBrowser });

  if (!res.ok) {
    const blocked = [401, 403, 406, 429].includes(res.status);
    return fail(blocked ? "blocked" : "error", [`HTTP ${res.status || "-"}`]);
  }

  const wall = detectInterstitial(res.html);
  if (wall) return fail("blocked", [`strona posrednia antybotu (${wall})`, ...diagnose(res.html, res)]);

  const match = pageMatchesProduct(res.html, product);
  if (!match.ok) {
    return fail("mismatch", ["strona porownywarki nie dotyczy tego produktu", ...diagnose(res.html, res)]);
  }

  const offers = parseAggregatorRows(res.html, source.shop);
  const expect = [product.ean, ...(product.matchTokens || [])].filter(Boolean);
  const { min, max } = priceBounds(product.baseline);
  const got = extractPrice(res.html, { expectTokens: expect, min, max });
  const summary = () => ({
    shop: source.shop,
    price: got.price,
    currency: got.currency || "PLN",
    availability: got.availability,
    url: res.finalUrl || source.url,
    method: got.method,
    shipping: null,
    discountPct: 0,
    note: "najnizsza cena wg danych strukturalnych porownywarki - sklep nierozpoznany",
  });

  if (offers.length) {
    // Wiersze sklepow bywaja niepelne. 24.09.2026 Ceneo mialo 4 oferty, w
    // atrybutach data-shop/data-price byly 3 (6 819, 6 819, 6 898,75), a
    // najtansza (6 466,51) tylko w JSON-LD porownywarki. Bez tego bot bral
    // zawyzone minimum - stad dawna notatka "Ceneo bywa zawyzone".
    const rowMin = Math.min(...offers.map((o) => o.price));
    const issues = res.escalatedFrom ? ["poszlo przez Chromium"] : [];
    if (got.price != null && got.price < rowMin) {
      offers.push(summary());
      issues.push(`najtansza oferta (${got.price}) tylko w danych strukturalnych, bez nazwy sklepu`);
    }
    return ok(offers, issues);
  }

  if (got.price == null) return fail("noprice", ["ani wierszy sklepow, ani ceny zbiorczej", got.reason]);
  return ok([summary()], ["nie udalo sie rozbic na sklepy, zostala cena minimalna"]);
}

// Szuka fragmentow, w ktorych blisko siebie stoi nazwa sklepu i kwota w zl.
// Celowo konserwatywny: lepiej zwrocic pusto i zejsc do ceny zbiorczej niz
// nakarmic historie cenami akcesoriow z paska "polecane".
export function parseAggregatorRows(html, aggregatorName) {
  const rows = [];
  const seen = new Set();

  // Wariant A: dane w atrybutach (data-shop / data-price) - typowe dla widgetow.
  const attrRe = /data-(?:shop|store|merchant)(?:-name)?\s*=\s*["']([^"']{2,60})["'][^>]{0,400}?data-price\s*=\s*["']([^"']{1,20})["']/gi;
  let m;
  while ((m = attrRe.exec(html))) {
    const price = parsePrice(m[2]);
    if (price != null && price > 0) push(decodeEntities(m[1]).trim(), price, null);
  }

  // Wariant B: link do sklepu, a w poblizu kwota. Okno 600 znakow dobrane tak,
  // zeby zlapac typowy wiersz tabeli i nie przeskoczyc do nastepnego.
  if (!rows.length) {
    const linkRe = /<a\b[^>]*href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>([\s\S]{0,600}?)(\d[\d\s  .,]{2,12})\s*(?:z[lł]|PLN)/gi;
    while ((m = linkRe.exec(html))) {
      const price = parsePrice(m[4]);
      if (price == null || price < 100) continue;
      const label = stripTags(decodeEntities(m[2])).trim();
      const host = hostOf(m[1]);
      const shop = label && label.length <= 40 && !/^\d/.test(label) ? label : host;
      if (!shop) continue;
      push(shop, price, m[1]);
    }
  }

  function push(shop, price, url) {
    // Ceneo trzyma w data-shop numeryczne ID sklepu ("35585"), nie nazwe.
    // Bez tego w historii ladowaly oferty sklepu o nazwie "55521", czego nie
    // da sie ani zweryfikowac, ani klikniec.
    if (/^\d+$/.test(String(shop).trim())) {
      shop = url ? (hostOf(url) || aggregatorName + "/nieznany") : aggregatorName + "/nieznany";
    }
    const key = normToken(shop) + ":" + price;
    if (seen.has(key)) return;
    // Sam agregator nie jest sklepem.
    if (normToken(shop) === normToken(aggregatorName)) return;
    seen.add(key);
    rows.push({
      shop: shop.slice(0, 40),
      price,
      currency: "PLN",
      availability: null,
      url: url || null,
      method: "aggregator",
      shipping: null,
      discountPct: 0,
      note: `wg ${aggregatorName}`,
    });
  }

  // Sanity check: jesli rozrzut jest absurdalny, parser prawie na pewno zlapal
  // akcesoria obok agregatow. Wolimy nic niz smieci w historii.
  if (rows.length >= 2) {
    const ps = rows.map((r) => r.price).sort((a, b) => a - b);
    if (ps[ps.length - 1] / ps[0] > 8) return [];
  }
  return rows;
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; }
}

export async function scrapeSource(product, source, opts = {}) {
  if (source.kind === "aggregator") return scrapeAggregator(product, source, opts);
  return scrapeShop(product, source, opts);
}
