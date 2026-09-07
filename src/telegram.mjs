// Drugi kanal powiadomien, obok Issue. Wysylka w jedna strone: bot nie czyta
// Twoich wiadomosci, tylko wypycha alerty z gen-watch na Telegram.
//
// Podzial celowy: funkcje formatujace i klucz anty-spamu sa czyste i przechodza
// przez selftest offline. Jedyny kawalek dotykajacy sieci to sendTelegram, i on
// dostaje fetch przez wstrzykniecie, zeby dalo sie go przetestowac bez sklepu.
//
// parse_mode=HTML, nie MarkdownV2 - w cenach sa kropki i myslniki ("8 599 zl",
// "nowe minimum -"), a w HTML escapuje sie tylko < > &.

import { fmt } from "./alerts.mjs";

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// "1 alert" / "2 alerty" / "5 alertow" - ta sama odmiana co w watch.yml.
function plAlerts(n) {
  if (n === 1) return "1 alert";
  const t = n % 10, h = n % 100;
  return t >= 2 && t <= 4 && (h < 12 || h > 14) ? `${n} alerty` : `${n} alertow`;
}

// Wejscie: znormalizowane alerty. Tor A podaje reasons + effective (z snapshot.
// alerts), tor B tylko name/price/shop/url/threshold (z marketAlerts). Format
// radzi sobie z obydwoma - brakujace pola po prostu znikaja z wiadomosci.
export function formatAlerts(alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) return null;

  const blocks = [`<b>gen-watch — ${plAlerts(alerts.length)}</b>`];
  for (const a of alerts) {
    const where = a.url
      ? `<a href="${escapeHtml(a.url)}">${escapeHtml(a.shop)}</a>`
      : escapeHtml(a.shop);
    const lines = [`<b>${escapeHtml(a.name)}</b> — <b>${escapeHtml(fmt(a.price))}</b> @ ${where}`];

    const why = Array.isArray(a.reasons) && a.reasons.length
      ? a.reasons.map((r) => escapeHtml(r.text)).join(" · ")
      : a.threshold != null
        ? `ponizej progu ${escapeHtml(fmt(a.threshold))}`
        : null;
    if (why) lines.push(why);

    if (a.effective && Number.isFinite(a.effective.cost)) {
      lines.push(
        `koszt koncowy: ${escapeHtml(fmt(a.effective.cost))}` +
        (a.effective.shippingKnown ? "" : " bez dostawy"),
      );
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

// Krotki sygnal, ze skan nie domknal sie czysto. Osobna wiadomosc od alertu
// cenowego, zeby jedno nie ginelo w drugim. Stan "ok" nie jest wydarzeniem.
export function formatDegraded(run, broken) {
  if (!run || run.status === "ok") return null;

  const total = (run.sourcesOk || 0) + (run.sourcesBad || 0);
  const lines = [
    `<b>gen-watch — skan ${escapeHtml(run.status)}</b>`,
    `Zrodla: ${run.sourcesOk || 0}/${total}`,
  ];
  const list = Array.isArray(broken) ? broken : [];
  if (list.length) {
    lines.push("", "Nie odpowiedzialy:");
    for (const b of list) {
      lines.push(`• ${escapeHtml(b.name)} / ${escapeHtml(b.shop)}: ${escapeHtml(b.status)}`);
    }
  } else {
    lines.push("", "Brak szczegolow o zrodlach.");
  }
  return lines.join("\n");
}

// Klucz anty-spamu dla sygnalu "degraded". Ten sam zestaw zepsutych zrodel co
// 3h to nie osiem powiadomien dziennie - dopiero zmiana zestawu jest nowa
// wiadomoscia. Kolejnosc listy nie moze wplywac na klucz.
export function degradedKey(broken) {
  const parts = (Array.isArray(broken) ? broken : [])
    .map((b) => `${b.name}/${b.shop}:${b.status}`)
    .sort();
  return "telegram|degraded|" + (parts.length ? parts.join(",") : "none");
}

// Ten sam wzorzec co marketAlerts w ingest.mjs: sprawdz stan, przy przejsciu
// zapisz znacznik czasu do stanu. Zwraca true, gdy wiadomosc ma pojsc.
export function shouldSendDegraded(state, broken, nowMs, realertAfterHours) {
  const key = degradedKey(broken);
  const prev = state && state[key];
  if (prev && nowMs - prev < realertAfterHours * 3600 * 1000) return false;
  if (state) state[key] = nowMs;
  return true;
}

// Czyste zlozenie zadania HTTP - bez sieci, zeby test sprawdzil sam ksztalt.
export function buildSendRequest(text, { token, chatId, disablePreview = true } = {}) {
  if (!token || !chatId) {
    throw new Error("brak TELEGRAM_BOT_TOKEN albo TELEGRAM_CHAT_ID");
  }
  return {
    url: `https://api.telegram.org/bot${token}/sendMessage`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: disablePreview,
    }),
  };
}

// Cala decyzja "co wyslac" z jednego snapshotu (docs/data/latest.json), zeby
// entrypoint byl cienki i bez logiki. Zwraca liste gotowych wiadomosci; przy
// sygnale degraded zapisuje znacznik anty-spamu do `state`.
//
// Alerty cenowe nie maja tu wlasnego tlumienia - snapshot.alerts zawiera juz
// tylko te, ktore scan.mjs uznal za warte alertu (reszte wyciszyl na etapie
// state). Tak samo dziala krok "Alert jako Issue".
export function planMessages(snapshot, state, nowMs, realertAfterHours) {
  const messages = [];

  const alertMsg = formatAlerts(snapshot && snapshot.alerts);
  if (alertMsg) messages.push(alertMsg);

  const run = snapshot && snapshot.run;
  if (run && run.status !== "ok") {
    const broken = [];
    for (const p of snapshot.products || []) {
      for (const s of p.sources || []) {
        // best-effort znaczy "wiemy, ze bywa zablokowane" - jego awaria nie
        // jest wydarzeniem, dokladnie jak w raporcie skanu.
        if (s.status !== "ok" && !s.bestEffort) {
          broken.push({ name: p.name, shop: s.shop, status: s.status });
        }
      }
      if (!p.best) {
        broken.push({ name: p.name, shop: "(wszystkie zrodla)", status: "brak ceny" });
      }
    }
    if (shouldSendDegraded(state, broken, nowMs, realertAfterHours)) {
      const dMsg = formatDegraded(run, broken);
      if (dMsg) messages.push(dMsg);
    }
  }

  return messages;
}

// Wysylka. Nigdy nie rzuca przy bledzie sieci ani odpowiedzi 4xx/5xx - zwraca
// { ok: false, ... }. Awaria Telegrama nie moze przewrocic przebiegu, bo Issue
// i historia sa zrodlem prawdy. Rzuca tylko przy braku tokenu/chatId (blad
// konfiguracji, nie runtime).
export async function sendTelegram(text, opts = {}) {
  const req = buildSendRequest(text, opts);
  const f = opts.fetchImpl || globalThis.fetch;
  if (typeof f !== "function") return { ok: false, error: "brak fetch w tym srodowisku" };

  try {
    const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body });
    if (!res.ok) {
      let detail = "";
      try { detail = JSON.stringify(await res.json()); } catch { /* odpowiedz bez JSON */ }
      return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
