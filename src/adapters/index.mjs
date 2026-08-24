import { smartFetch } from "../fetch.mjs";
import {
  extractPrice, pageMatchesProduct, parsePrice, stripTags, decodeEntities, normToken,
} from "../extract.mjs";

// Kazdy adapter zwraca liste ofert w jednym ksztalcie:
//   { shop, price, currency, availability, url, method, note }
// plus osobno { status, issues } opisujace zdrowie samego zrodla.
// Rozdzielenie jest celowe: zero ofert przy status "ok" znaczy "sprawdzone,
// nie ma", a zero ofert przy status "blocked" znaczy "nie wiemy". Zlanie tych
// dwoch przypadkow w jedno bylo najczestszym bledem w role-watch.

function ok(offers, issues = []) { return { status: "ok", offers, issues }; }
function fail(status, issues) { return { status, offers: [], issues }; }

export async function scrapeShop(product, source) {
  const res = await smartFetch(source.url, {
    needsBrowser: !!source.needsBrowser,
    waitFor: source.waitFor || null,
  });

  if (!res.ok) {
    const blocked = [401, 403, 406, 429].includes(res.status);
    return fail(blocked ? "blocked" : "error", [
      `HTTP ${res.status || "-"}${res.error ? " (" + res.error + ")" : ""}`,
    ]);
  }

  const match = pageMatchesProduct(res.html, product);
  if (!match.ok) {
    // Strona wstala, ale opisuje co innego - najczesciej przekierowanie na
    // kategorie po wygaszeniu produktu. Cena z takiej strony jest gorsza niz brak.
    return fail("mismatch", [
      `strona nie zawiera identyfikatora produktu${match.by ? " (kolizja z " + match.by + ")" : ""}`,
    ]);
  }

  const expect = [product.ean, ...(product.matchTokens || [])].filter(Boolean);
  const got = extractPrice(res.html, { expectTokens: expect, textPattern: source.textPattern });

  if (got.price == null) {
    return fail("noprice", [got.reason || "brak ceny", `warstwy wyczerpane, via ${res.via}`]);
  }

  const issues = [];
  if (got.method === "text") issues.push("cena z warstwy tekstowej - traktuj z rezerwa");
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
export async function scrapeAggregator(product, source) {
  const res = await smartFetch(source.url, { needsBrowser: !!source.needsBrowser });

  if (!res.ok) {
    const blocked = [401, 403, 406, 429].includes(res.status);
    return fail(blocked ? "blocked" : "error", [`HTTP ${res.status || "-"}`]);
  }

  const match = pageMatchesProduct(res.html, product);
  if (!match.ok) return fail("mismatch", ["strona porownywarki nie dotyczy tego produktu"]);

  const offers = parseAggregatorRows(res.html, source.shop);
  if (offers.length) return ok(offers, res.escalatedFrom ? ["poszlo przez Chromium"] : []);

  const expect = [product.ean, ...(product.matchTokens || [])].filter(Boolean);
  const got = extractPrice(res.html, { expectTokens: expect });
  if (got.price == null) return fail("noprice", ["ani wierszy sklepow, ani ceny zbiorczej"]);

  return ok([{
    shop: source.shop,
    price: got.price,
    currency: got.currency || "PLN",
    availability: got.availability,
    url: res.finalUrl || source.url,
    method: got.method,
    shipping: null,
    discountPct: 0,
    note: "cena zbiorcza z porownywarki - sklep nierozpoznany",
  }], ["nie udalo sie rozbic na sklepy, zostala cena minimalna"]);
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

export async function scrapeSource(product, source) {
  if (source.kind === "aggregator") return scrapeAggregator(product, source);
  return scrapeShop(product, source);
}
