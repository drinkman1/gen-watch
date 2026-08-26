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
    const cand = [v.value, v.label, v.arranged === true ? null : null];
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

// Dopasowanie do modelu. Fogo nie ma EAN, K&S ma - ale w ogloszeniach z drugiej
// reki EAN i tak nie pada, wiec obie marki idą po znormalizowanej nazwie.
export function matchesProduct(offer, product) {
  const hay = normToken(String(offer.title || "") + " " + String(offer.description || "").slice(0, 400));
  const hit = (product.matchTokens || []).some((t) => hay.includes(normToken(t)));
  if (!hit) return false;
  return !(product.rejectTokens || []).some((r) => hay.includes(normToken(r)) && !hay.includes(normToken(product.matchTokens[0])));
}

export async function scrapeOlx(product, source, meta) {
  const query = source.query || product.name;
  const url = `${BASE}?offset=0&limit=40&query=${encodeURIComponent(query)}`;

  let res, body;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json", "Accept-Language": "pl-PL,pl;q=0.9" },
    });
    body = await res.text();
  } catch (e) {
    return { status: "error", offers: [], issues: ["blad sieci: " + String(e && e.message || e)] };
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
  const out = [];
  const skipped = { model: 0, uszkodzone: 0, daleko: 0, bezCeny: 0, bezWspolrzednych: 0 };

  for (const o of list) {
    if (!matchesProduct(o, product)) { skipped.model++; continue; }
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
      note: null,
    });
  }

  const issues = [];
  const dropped = Object.entries(skipped).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`);
  if (dropped.length) issues.push(`odrzucone — ${dropped.join(", ")}`);
  if (!out.length && !list.length) issues.push("OLX nie zwrocil zadnych ogloszen dla tego zapytania");

  // Odstep miedzy zapytaniami. Piec modeli x 1,5 s to osiem sekund na przebieg.
  await sleep(1500);

  return { status: "ok", offers: out, issues };
}
