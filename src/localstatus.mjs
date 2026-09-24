// Puls toru B. Skan lokalny przy kazdym przebiegu zapisuje na galezi data
// docs/data/local-status.json - takze wtedy, gdy nie zebral ani jednej ceny.
// Tor A czyta ten plik i sprawdza, kiedy tor B ostatnio cos oddal.
//
// Powod: od 26.08.2026 tor B nie zapisal nic i nikt tego nie zauwazyl, bo
// awaria na Windowsie konczyla sie przed pushem i nie zostawiala sladu. Teraz
// cisza jest widoczna z dwoch stron: brak nowego pliku (laptop wylaczony,
// zepsuty git) albo plik z zerem ofert (ochrona antybotowa, zmiana stron).

import { effectiveCost, fmt } from "./alerts.mjs";

export const LOCAL_STATUS = "local-status.json";

// Alert z toru B czeka w pulsie na najblizszy przebieg toru A, ktory wysyla go
// tym samym Issue (i mailem) co wlasne alerty. 48 h wystarcza z zapasem przy
// skanie co 3 h; starszy alert nie jest juz wiadomoscia, tylko historia.
export const PENDING_KEEP_HOURS = 48;

// Domyslny prog ciszy. Tor B chodzi dwa razy dziennie, wiec 36 h to trzy
// opuszczone przebiegi z rzedu - jeden wylaczony wieczorem laptop nie alarmuje.
export const DEFAULT_STALE_HOURS = 36;

// `prev` to poprzedni status z galezi data. Z niego przechodzi lastOkAt, gdy
// biezacy przebieg nic nie zebral - inaczej jedna nieudana proba kasowalaby
// informacje, kiedy tor B ostatnio dzialal.
export function buildLocalStatus({ ts, code = null, results = [], prev = null, alerts = [] }) {
  const ok = results.filter((r) => r.status === "ok" && r.price != null).length;
  return {
    ts,
    lastOkAt: ok > 0 ? ts : (prev && prev.lastOkAt) || null,
    code,
    ok,
    bad: results.length - ok,
    sources: results.map((r) => ({
      productId: r.productId,
      shop: r.shop,
      status: r.status,
      price: r.price != null ? r.price : null,
      issue: r.issue ? String(r.issue).slice(0, 160) : null,
    })),
    pendingAlerts: mergePending(prev && prev.pendingAlerts, alerts, Date.parse(ts)),
  };
}

// Poprzednie oczekujace alerty przechodza dalej, dopoki nie przeterminuja
// sie - kolejny przebieg toru B nie moze skasowac alertu, ktorego tor A
// jeszcze nie wyslal (cron Actions potrafi spoznic sie o kilka godzin).
export function mergePending(prev, fresh, nowMs, keepHours = PENDING_KEEP_HOURS) {
  const byId = new Map();
  for (const a of [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(fresh) ? fresh : [])]) {
    if (a && a.id) byId.set(a.id, a);
  }
  return [...byId.values()].filter((a) => nowMs - Date.parse(a.seenAt) <= keepHours * 3600000);
}

// Jeden oczekujacy alert: id laczy klucz wyciszenia z chwila skanu, wiec ta
// sama cena po oknie ciszy jest nowym alertem, a nie duplikatem.
export function pendingAlert({ productId, name, site, shop, price, url, threshold, discountPct = 0, seenAt }) {
  return {
    id: `market|${productId}|${site}|${price}|${seenAt}`,
    productId, name, shop, price, url: url || null, threshold,
    discountPct: discountPct || 0, seenAt, telegramSent: false,
  };
}

export const mailedKey = (a) => `mailed|${a.id}`;

// Tor A: oczekujace alerty toru B, ktorych jeszcze nie wyslal, w ksztalcie
// snapshot.alerts - ten sam, ktory czyta krok "Alert jako Issue", dashboard i
// Telegram. Znaczniki `mailed|` trafiaja do state dopiero u wywolujacego
// (scan.mjs pomija je w --dry-run).
export function localAlertsForSnapshot(status, state, products, nowMs, keepHours = PENDING_KEEP_HOURS) {
  const byId = new Map((products || []).map((p) => [p.id, p]));
  const out = [];
  for (const a of mergePending(status && status.pendingAlerts, [], nowMs, keepHours)) {
    if (state && state[mailedKey(a)]) continue;
    const p = byId.get(a.productId);
    const when = String(a.seenAt).slice(0, 16).replace("T", " ");
    out.push({
      alert: {
        productId: a.productId,
        name: a.name || (p && p.name) || a.productId,
        price: a.price,
        shop: `${a.shop} (skan lokalny)`,
        url: a.url,
        effective: effectiveCost({ price: a.price, discountPct: a.discountPct, shipping: null }),
        reasons: [{ code: "hard", text: `ponizej progu ${fmt(a.threshold)} (jest ${fmt(a.price)}) - skan lokalny ${when} UTC` }],
        baseline: p ? p.baseline : null,
        source: "local",
        telegramSent: !!a.telegramSent,
      },
      key: mailedKey(a),
    });
  }
  return out;
}

// Brak pliku to tez cisza: tor B jeszcze nigdy nie zapisal pulsu.
export function localHealth(status, nowMs, staleAfterHours = DEFAULT_STALE_HOURS) {
  if (!status || typeof status !== "object") {
    return { stale: true, lastRunAt: null, lastOkAt: null, ageHours: null, ok: 0, bad: 0, staleAfterHours };
  }
  const okMs = Date.parse(status.lastOkAt);
  const ageHours = Number.isFinite(okMs) ? Math.round((nowMs - okMs) / 360000) / 10 : null;
  return {
    stale: ageHours == null || ageHours > staleAfterHours,
    lastRunAt: status.ts || null,
    lastOkAt: status.lastOkAt || null,
    ageHours,
    ok: status.ok || 0,
    bad: status.bad || 0,
    staleAfterHours,
  };
}

// Jedno zdanie do raportu, dashboardu i Telegrama - wszedzie to samo.
export function describeHealth(h) {
  if (!h) return "tor B: brak danych";
  if (!h.lastOkAt) {
    return h.lastRunAt
      ? `tor B: ostatni przebieg ${h.lastRunAt.slice(0, 16).replace("T", " ")} UTC bez ani jednej ceny`
      : "tor B: jeszcze nigdy nie zapisal pulsu";
  }
  const age = h.ageHours < 48 ? `${Math.round(h.ageHours)} h` : `${Math.round(h.ageHours / 24)} dni`;
  return `tor B: ostatni udany skan ${age} temu · ostatni przebieg: ${h.ok}/${h.ok + h.bad} zrodel z cena`;
}
