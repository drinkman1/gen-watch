// Puls toru B. Skan lokalny przy kazdym przebiegu zapisuje na galezi data
// docs/data/local-status.json - takze wtedy, gdy nie zebral ani jednej ceny.
// Tor A czyta ten plik i sprawdza, kiedy tor B ostatnio cos oddal.
//
// Powod: od 26.08.2026 tor B nie zapisal nic i nikt tego nie zauwazyl, bo
// awaria na Windowsie konczyla sie przed pushem i nie zostawiala sladu. Teraz
// cisza jest widoczna z dwoch stron: brak nowego pliku (laptop wylaczony,
// zepsuty git) albo plik z zerem ofert (ochrona antybotowa, zmiana stron).

export const LOCAL_STATUS = "local-status.json";

// Domyslny prog ciszy. Tor B chodzi dwa razy dziennie, wiec 36 h to trzy
// opuszczone przebiegi z rzedu - jeden wylaczony wieczorem laptop nie alarmuje.
export const DEFAULT_STALE_HOURS = 36;

// `prev` to poprzedni status z galezi data. Z niego przechodzi lastOkAt, gdy
// biezacy przebieg nic nie zebral - inaczej jedna nieudana proba kasowalaby
// informacje, kiedy tor B ostatnio dzialal.
export function buildLocalStatus({ ts, code = null, results = [], prev = null }) {
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
  };
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
