// Komunikaty informacyjne na Telegram, obok alertow: kazda zmiana najnizszej
// ceny i raport dzienny. Alert mowi "kupuj", te wiadomosci mowia "co sie
// dzieje" - bez nich bot milczal tygodniami, bo alertow prawie nie bylo.
//
// Czyste funkcje, testowane offline w selftest. Wysylka i zapis stanu siedza
// w notify-telegram.mjs.

import { fmt } from "./alerts.mjs";
import { escapeHtml } from "./telegram.mjs";
import { describeHealth } from "./localstatus.mjs";

const HOUR = 3600 * 1000;
export const bestKey = (id) => `telegram|best|${id}`;

// Po tylu godzinach niedostepnosci sklepu z ostatnio zgloszona cena
// przestajemy czekac na jego powrot i zglaszamy nowa najnizsza cene.
export const FLAP_HOURS = 24;

function pctText(from, to) {
  const p = Math.round(((to - from) / from) * 1000) / 10;
  return `${p > 0 ? "+" : "−"}${Math.abs(p).toLocaleString("pl-PL")}%`;
}

function gapText(price, threshold) {
  if (!Number.isFinite(threshold)) return "";
  if (price < threshold) return `PONIZEJ progu ${fmt(threshold)}`;
  const gap = Math.round((price - threshold) * 100) / 100;
  return `do progu ${fmt(threshold)} brakuje ${fmt(gap)} (${(Math.round((gap / price) * 1000) / 10).toLocaleString("pl-PL")}%)`;
}

function shopLink(shop, url) {
  return url ? `<a href="${escapeHtml(url)}">${escapeHtml(shop)}</a>` : escapeHtml(shop);
}

// Zmiana najnizszej ceny modelu wzgledem ostatnio ZGLOSZONEJ (nie ostatnio
// widzianej). Zwraca:
//   text     - jedna wiadomosc ze wszystkimi zmianami albo null,
//   updates  - stan do zapisania PO udanej wysylce,
//   silent   - stan do zapisania zawsze (pierwszy przebieg, migotanie).
//
// Filtr migotania: KupAgregat co kilka przebiegow nie odpowiada i wtedy
// najnizsza cena skacze 4 999 -> 6 287 -> 4 999. To nie jest zmiana ceny,
// tylko zmiana dostepnosci zrodla, wiec czekamy na powrot sklepu - najwyzej
// FLAP_HOURS, potem uznajemy nowa cene i piszemy dlaczego.
export function planPriceChanges(products, state, nowMs) {
  const lines = [];
  const updates = {};
  const silent = {};
  for (const p of products || []) {
    const cur = p.best;
    if (!cur || !Number.isFinite(cur.price)) continue;
    const key = bestKey(p.id);
    const prev = state && state[key];
    const now = { price: cur.price, shop: cur.shop, ts: new Date(nowMs).toISOString() };

    if (!prev || !Number.isFinite(prev.price)) { silent[key] = now; continue; }
    if (cur.price === prev.price) {
      if (cur.shop !== prev.shop || prev.missingSince) silent[key] = now;
      continue;
    }

    const prevShopOk = (p.sources || []).some((s) => s.shop === prev.shop && s.status === "ok");
    let note = "";
    if (!prevShopOk && cur.shop !== prev.shop) {
      const since = prev.missingSince ? Date.parse(prev.missingSince) : nowMs;
      if (nowMs - since < FLAP_HOURS * HOUR) {
        silent[key] = { ...prev, missingSince: new Date(since).toISOString() };
        continue;
      }
      note = `\n   (${escapeHtml(prev.shop)} nie odpowiada od ${FLAP_HOURS} h)`;
    }

    const arrow = cur.price < prev.price ? "📉" : "📈";
    lines.push(
      `${arrow} <b>${escapeHtml(p.name)}</b>: ${fmt(prev.price)} → <b>${fmt(cur.price)}</b> ` +
      `(${pctText(prev.price, cur.price)}) @ ${shopLink(cur.shop, cur.url)}\n` +
      `   ${gapText(cur.price, p.hardThreshold)}${note}`,
    );
    updates[key] = now;
  }
  const text = lines.length ? [`<b>gen-watch — zmiana ceny</b>`, ...lines].join("\n") : null;
  return { text, updates, silent };
}

// Data i godzina w Warszawie - raport ma przychodzic rano czasu polskiego,
// niezaleznie od zmiany czasu i od tego, ze runner chodzi w UTC.
export function warsawParts(nowMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

// Klucz raportu, jesli dzis jeszcze nie poszedl i jest juz po `fromHour`;
// inaczej null. Tor A chodzi co 3 h, wiec raport przychodzi z pierwszym
// przebiegiem po 7:00 (cron 06:00 UTC = ok. 8:00 latem, 7:00 zima).
export function dailyReportDue(state, nowMs, fromHour = 7) {
  const { date, hour } = warsawParts(nowMs);
  if (hour < fromHour) return null;
  const key = `telegram|daily|${date}`;
  return state && state[key] ? null : key;
}

// Wpis historii najblizszy chwili sprzed doby - do "zmiany od wczoraj".
export function priceDayAgo(history, nowMs) {
  const cutoff = nowMs - 24 * HOUR;
  let best = null;
  for (const h of history || []) {
    const t = Date.parse(h && h.ts);
    if (!Number.isFinite(t) || t > cutoff || !h.best || !Number.isFinite(h.best.price)) continue;
    if (!best || t > best.t) best = { t, price: h.best.price };
  }
  return best ? best.price : null;
}

function cheapestMarket(doc, nowMs) {
  let out = null;
  for (const s of (doc && doc.scans) || []) {
    if (nowMs - Date.parse(s.ts) > 24 * HOUR) continue;
    for (const o of s.offers || []) {
      if (!Number.isFinite(o.price)) continue;
      if (!out || o.price < out.price) out = o;
    }
  }
  return out;
}

export function formatDailyReport({ snapshot, histories = {}, markets = {}, deadline = null, dashboardUrl = null, nowMs }) {
  const { date } = warsawParts(nowMs);
  const lines = [`<b>gen-watch — raport ${date}</b>`];
  for (const p of (snapshot && snapshot.products) || []) {
    lines.push("");
    if (!p.best) {
      lines.push(`<b>${escapeHtml(p.name)}</b>: brak ceny w ostatnim skanie`);
      continue;
    }
    const ago = priceDayAgo(histories[p.id], nowMs);
    const day = ago == null ? "brak danych sprzed doby"
      : ago === p.best.price ? "bez zmian od wczoraj"
        : `${ago > p.best.price ? "−" : "+"}${fmt(Math.abs(Math.round((p.best.price - ago) * 100) / 100))} od wczoraj`;
    const lows = (histories[p.id] || []).filter((h) => h.best && Number.isFinite(h.best.price)).map((h) => h.best.price);
    const low = lows.length ? Math.min(...lows) : null;
    lines.push(`<b>${escapeHtml(p.name)}</b>: ${fmt(p.best.price)} @ ${shopLink(p.best.shop, p.best.url)} · ${day}`);
    lines.push(`   ${gapText(p.best.price, p.hardThreshold)}${low != null ? ` · minimum obserwacji ${fmt(low)}` : ""}`);
    const m = cheapestMarket(markets[p.id], nowMs);
    if (m) {
      const where = m.site === "inne" ? (m.title || "sklep") : m.site;
      lines.push(`   rynek (24 h): ${fmt(m.price)} @ ${shopLink(where, m.url)}${m.condition === "used" ? ", uzywany" : ""}${m.match === "czesciowe" ? ", do obejrzenia (wariant niepewny)" : ""}`);
    }
  }
  lines.push("");
  if (snapshot && snapshot.local) lines.push(escapeHtml(describeHealth(snapshot.local)));
  if (deadline) {
    const left = Math.ceil((Date.parse(deadline) - nowMs) / (24 * HOUR));
    lines.push(`Do terminu zakupu (${deadline}): ${left} dni`);
  }
  if (dashboardUrl) lines.push(`<a href="${escapeHtml(dashboardUrl)}">dashboard</a>`);
  return lines.join("\n");
}

export function formatTestMessage(snapshot, nowMs) {
  const { date, hour } = warsawParts(nowMs);
  const lines = [`<b>gen-watch — test polaczenia</b>`, `${date}, godz. ${hour} (Warszawa). Jesli to widzisz, kanal dziala.`];
  const ps = (snapshot && snapshot.products) || [];
  if (ps.length) {
    lines.push("", "Najnizsze ceny z ostatniego skanu:");
    for (const p of ps) lines.push(`• ${escapeHtml(p.name)}: ${p.best ? fmt(p.best.price) : "brak ceny"}`);
  }
  return lines.join("\n");
}
