// Adapter OLX - rynek wtorny, wylacznie ze skanu lokalnego.
//
// PODSTAWA: robots.txt OLX blokuje caly /api/, a potem jawnym wyjatkiem
// otwiera z powrotem `Allow: /api/v1/offers/`. To swiadoma decyzja operatora,
// a nie luka - i tylko z tego jednego endpointu korzystamy. Strony wyszukiwania
// (/oferty/...) tez nie sa zabronione, ale nie ma po co ich ruszac, skoro jest
// wersja przeznaczona do czytania maszynowego.
//
// GRZECZNOSC nie jest tu ozdoba, tylko warunkiem, na jakim to robimy:
//   - przedstawiamy sie wlasnym User-Agentem z linkiem do repo, nie udajemy
//     przegladarki. Jesli OLX uzna, ze nie chce takiego ruchu, ma prawo odmowic
//     i wtedy konczymy temat, zamiast szukac obejscia;
//   - jedno zapytanie na model, odstep miedzy zapytaniami, dwa przebiegi dziennie
//     - lacznie 10 zapytan na dobe;
//   - 429 i 503 traktujemy jako "wystarczy" i przerywamy przebieg.
//
// Filtrowanie po odleglosci robimy PO STRONIE KLIENTA, z wspolrzednych zwroconych
// w ofercie. Nie zgadujemy nazw parametrow lokalizacyjnych OLX-a, bo zla nazwa
// dalaby ciche, niepelne wyniki zamiast bledu.

import { sleep } from "../fetch.mjs";
import { parsePrice, normToken } from "../extract.mjs";

const UA = "gen-watch/1.0 (osobisty monitoring cen agregatow; +https://github.com/drinkman1/gen-watch)";
const BASE = "https://www.olx.pl/api/v1/offers/";

export function olxUrl(product, source) {
  const query = source.query || product.name;
  return `${BASE}?offset=0&limit=40&query=${encodeURIComponent(query)}`;
}

// Domyslny fetcher: wlasny User-Agent, JSON, limit czasu 20 s (bez niego
// zawieszone zapytanie trzymalo caly skan lokalny) i odstep 1,5 s PO kazdym
// zapytaniu - piec modeli to ok. 8 s. Ksztalt odpowiedzi jak smartFetch, zeby
// ten sam mechanizm fixture'ow (test/fixtures) dzialal i tutaj.
export async function olxFetch(url, { timeoutMs = 20000, spacingMs = 1500 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json", "Accept-Language": "pl-PL,pl;q=0.9" },
      signal: ac.signal,
    });
    const html = await res.text();
    return { ok: res.ok, status: res.status, html, finalUrl: res.url || url, via: "fetch" };
  } catch (e) {
    return { ok: false, status: 0, html: "", finalUrl: url, via: "fetch", error: String(e && e.message || e) };
  } finally {
    clearTimeout(t);
    await sleep(spacingMs);
  }
}

// Tytuly, ktore dyskwalifikuja oferte niezaleznie od ceny. Wyszukiwarka OLX
// tego nie odsiewa, a agregat "na czesci" za pol ceny nie jest okazja.
const REJECT = /uszkodzon|na cz[eę][sś]ci|niesprawn|nie odpala|nie dziala|nie dzia[lł]a|do naprawy|spalon|zatart/i;

export function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// Ksztalt odpowiedzi OLX-a nie jest przez nikogo gwarantowany, wiec zamiast
// zakladac sciezki, szukamy pol tolerancyjnie i raportujemy, czego nie bylo.
export function pickPrice(offer) {
  const params = Array.isArray(offer && offer.params) ? offer.params : [];
  for (const p of params) {
    if (!p || (p.key !== "price" && p.type !== "price")) continue;
    const v = p.value || {};
    const cand = [v.value, v.label];
    for (const c of cand) {
      const n = parsePrice(c);
      if (n != null && n > 0) return n;
    }
  }
  // Bywa tez plaskie pole.
  const flat = parsePrice(offer && (offer.price || (offer.price_value)));
  return flat != null && flat > 0 ? flat : null;
}

export function pickCoords(offer) {
  const m = offer && (offer.map || offer.location || {});
  const lat = Number(m.lat != null ? m.lat : (offer.location && offer.location.lat));
  const lon = Number(m.lon != null ? m.lon : (offer.location && offer.location.lon));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

export function pickCity(offer) {
  const l = offer && offer.location;
  if (!l) return null;
  const city = l.city && (l.city.name || l.city);
  const region = l.region && (l.region.name || l.region);
  return [city, region].filter(Boolean).join(", ") || null;
}

export function pickCondition(offer) {
  const params = Array.isArray(offer && offer.params) ? offer.params : [];
  for (const p of params) {
    if (p && (p.key === "state" || p.key === "stan")) {
      const v = String((p.value && (p.value.key || p.value.label)) || "").toLowerCase();
      if (v.includes("new") || v.includes("now")) return "new";
      if (v.includes("used") || v.includes("uzyw") || v.includes("używan")) return "used";
    }
  }
  return "unknown";
}

// Dopasowanie do modelu, DWUSTOPNIOWE.
//
// Pierwsza wersja wymagala pelnego tokenu ("ks8100ieatsr") i 26.08.2026 odrzucila
// komplet - 40 z 40 ogloszen przy kazdym modelu. Powod byl prozaiczny: na OLX-ie
// nikt tak nie pisze. Tam jest "Agregat Konner Sohnen 8100" albo "KS 8100iE".
// Sprzedajacy z drugiej reki nie zna sie na sufiksach i nie ma powodu ich podawac.
//
//   "dokladne"  - pelen token modelu jest w tresci. Takie oferty moga alarmowac.
//   "czesciowe" - jest marka i numer rodziny (8100, 9500, 12000), ale bez sufiksu.
//                 Trafia do raportu jako kandydat do obejrzenia, NIGDY nie alarmuje.
//
// Rozroznienie jest istotne wlasnie przez sufiksy: "i" to inwerter, "G" to dual
// fuel, "ATSR" to gniazdo automatyki. KS 8100iE ATSR i KS 8100iEG to dwa rozne
// urzadzenia i bot nie ma prawa zgadywac, ktore sprzedajacy ma w garazu.
export function matchesProduct(offer, product) {
  const hay = normToken(String(offer.title || "") + " " + String(offer.description || "").slice(0, 600));

  const exact = (product.matchTokens || []).some((t) => hay.includes(normToken(t)));
  if (exact) {
    const collides = (product.rejectTokens || []).some(
      (r) => hay.includes(normToken(r)) && !hay.includes(normToken(product.matchTokens[0]))
    );
    return collides ? false : "dokladne";
  }

  const core = product.coreTokens || [];
  const brand = product.brandTokens || [];
  if (!core.length || !brand.length) return false;
  // Ogloszenie jawnie o innym wariancie (np. "KS 8100iEG" przy szukaniu
  // KS 8100iE ATSR) nie jest nawet kandydatem do obejrzenia.
  if ((product.rejectTokens || []).some((r) => hay.includes(normToken(r)))) return false;
  const hasCore = core.some((c) => hay.includes(normToken(c)));
  const hasBrand = brand.some((b) => hay.includes(normToken(b)));
  return hasCore && hasBrand ? "czesciowe" : false;
}

export async function scrapeOlx(product, source, { fetcher = olxFetch, meta = {} } = {}) {
  const res = await fetcher(olxUrl(product, source), {});
  const body = res.html || "";

  if (res.status === 0) {
    return { status: "error", offers: [], issues: ["blad sieci: " + (res.error || "brak odpowiedzi")] };
  }
  if (res.status === 429 || res.status === 503) {
    return { status: "blocked", offers: [], issues: [`HTTP ${res.status} - OLX prosi o spokoj, przerywam`] };
  }
  if (!res.ok) {
    return { status: res.status === 403 ? "blocked" : "error", offers: [],
      issues: [`HTTP ${res.status}`, `pierwsze 120 znakow: ${body.slice(0, 120).replace(/\s+/g, " ")}`] };
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return { status: "error", offers: [], issues: ["odpowiedz nie jest JSON-em", `poczatek: ${body.slice(0, 120)}`] };
  }

  const list = Array.isArray(json && json.data) ? json.data : null;
  if (!list) {
    return { status: "error", offers: [],
      issues: ["brak tablicy `data` w odpowiedzi", `klucze najwyzszego poziomu: ${Object.keys(json || {}).join(", ")}`] };
  }

  const origin = meta.origin;
  const maxKm = meta.usedRadiusKm;
  if (!origin || !Number.isFinite(maxKm)) {
    return { status: "error", offers: [], issues: ["brak meta.origin / meta.usedRadiusKm w konfiguracji"] };
  }
  const out = [];
  const skipped = { model: 0, uszkodzone: 0, daleko: 0, bezCeny: 0, bezWspolrzednych: 0 };

  const sampleTitles = [];
  for (const o of list) {
    const match = matchesProduct(o, product);
    if (!match) {
      skipped.model++;
      if (sampleTitles.length < 5) sampleTitles.push(String(o.title || "").slice(0, 70));
      continue;
    }
    if (REJECT.test(String(o.title || "") + " " + String(o.description || "").slice(0, 400))) { skipped.uszkodzone++; continue; }

    const price = pickPrice(o);
    if (price == null) { skipped.bezCeny++; continue; }

    const coords = pickCoords(o);
    if (!coords) { skipped.bezWspolrzednych++; continue; }
    const km = haversineKm(origin, coords);
    if (km > maxKm) { skipped.daleko++; continue; }

    out.push({
      productId: product.id,
      site: "olx",
      price,
      condition: pickCondition(o),
      url: typeof o.url === "string" && /^https:\/\//.test(o.url) ? o.url : null,
      title: String(o.title || "").slice(0, 160),
      location: pickCity(o),
      distanceKm: km,
      match,
      // Czesciowe dopasowanie nigdy nie alarmuje (marketAlerts je pomija) -
      // trafia tylko na dashboard i do raportu jako kandydat do obejrzenia.
      note: match === "czesciowe" ? "do obejrzenia - wariant niepewny" : null,
    });
  }

  const issues = [];
  const dropped = Object.entries(skipped).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`);
  if (dropped.length) issues.push(`odrzucone — ${dropped.join(", ")}`);
  if (!out.length && !list.length) issues.push("OLX nie zwrocil zadnych ogloszen dla tego zapytania");
  // Gdy nic nie przeszlo filtra, pokazujemy probke tytulow. Bez tego "model: 40"
  // znaczy tylko "nie pasowalo" i nie wiadomo, czy filtr jest za ostry, czy OLX
  // po prostu oddal 40 innych agregatow.
  if (!out.length && sampleTitles.length) {
    issues.push("przyklady odrzuconych tytulow: " + sampleTitles.map((t) => `"${t}"`).join(", "));
  }


  return { status: "ok", offers: out, issues };
}
