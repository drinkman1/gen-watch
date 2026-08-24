// Buduje docs/index.html z docs/data. Strona jest samowystarczalna: zero CDN,
// zero fetchy - dane sa wstrzykniete w plik. Dzieki temu dziala tak samo z
// GitHub Pages, z dysku i po przeslaniu komus dalej.
//
// Forma: male wielokrotnosci, jeden wykres na model. Piec modeli ma ceny od
// ~5 tys. do ~12 tys. zl - wspolna os spłaszczylaby trzy z nich do plaskiej
// kreski, a druga os y jest wykluczona. Kazdy panel ma wiec wlasna skale.
// Serie jest jedna na panel, wiec kolor kategoryczny tez jest jeden; mediana i
// prog to adnotacje w tuszu drugorzednym, nie kolejne serie.

import fs from "node:fs";
import path from "node:path";
import { readJson, DATA_DIR, loadHistory } from "./store.mjs";
import { median, windowPrices, allTimeLow } from "./alerts.mjs";
import { marketFile } from "./ingest.mjs";

const OUT = path.join(process.cwd(), "docs", "index.html");
const latest = readJson(path.join(DATA_DIR, "latest.json"), null);

if (!latest) {
  console.error("Brak docs/data/latest.json - najpierw uruchom skan.");
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "products.json"), "utf8"));
const rules = cfg.meta.alertRules;
const nowMs = Date.parse(latest.generatedAt) || Date.now();

const panels = latest.products.map((p) => {
  const history = loadHistory(p.id)
    .filter((h) => h.best && Number.isFinite(h.best.price))
    .map((h) => ({ t: Date.parse(h.ts), y: h.best.price, shop: h.best.shop }))
    .filter((h) => Number.isFinite(h.t))
    .sort((a, b) => a.t - b.t);

  const raw = loadHistory(p.id);
  const win = windowPrices(raw, nowMs, rules.medianWindowDays);
  const med = win.length >= rules.minSamplesForMedian ? median(win) : null;

  // Przy zakupie z terminem to jest wazniejsza liczba niz prog: mowi, czy
  // dzisiejsza cena jest najlepsza, jaka widzielismy, czy tylko przecietna.
  const low = allTimeLow(raw);
  const lowAt = low == null ? null
    : (raw.filter((h) => h.best && h.best.price === low).slice(-1)[0] || {}).ts || null;

  const market = readJson(marketFile(p.id), null);
  const lastScan = market && Array.isArray(market.scans) && market.scans.length
    ? market.scans[market.scans.length - 1] : null;

  return {
    id: p.id,
    name: p.name,
    ean: p.ean,
    baseline: p.baseline,
    threshold: p.hardThreshold,
    best: p.best,
    offers: p.offers,
    sources: p.sources,
    alerted: p.alerted,
    median: med,
    low,
    lowAt,
    series: history,
    specSource: p.specSource,
    specNote: p.specNote,
    market: lastScan ? { ts: lastScan.ts, offers: lastScan.offers } : null,
  };
});

const payload = {
  generatedAt: latest.generatedAt,
  run: latest.run,
  alerts: latest.alerts,
  rules,
  deadline: cfg.meta.deadline || null,
  panels,
};

const html = render(payload);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, "utf8");
console.log(`Dashboard: ${OUT} (${(html.length / 1024).toFixed(0)} kB, ${panels.length} paneli)`);

// ---------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function render(data) {
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  const runStamp = new Date(data.generatedAt).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" });
  const statusWord = { ok: "wszystko zebrane", degraded: "czesc zrodel padla", error: "brak ceny dla modelu" }[data.run.status] || data.run.status;

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>gen-watch — ceny agregatow</title>
<style>
  :root{
    color-scheme: light;
    --plane:#f9f9f7; --surface:#fcfcfb;
    --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
    --grid:#e1e0d9; --axis:#c3c2b7; --ring:rgba(11,11,11,0.10);
    --series-1:#2a78d6;
    --good:#0ca30c; --warning:#fab219; --critical:#d03b3b;
    --success-text:#006300;
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      color-scheme: dark;
      --plane:#0d0d0d; --surface:#1a1a19;
      --ink:#ffffff; --ink-2:#c3c2b7; --muted:#898781;
      --grid:#2c2c2a; --axis:#383835; --ring:rgba(255,255,255,0.10);
      --series-1:#3987e5;
      --success-text:#0ca30c;
    }
  }
  :root[data-theme="dark"]{
    color-scheme: dark;
    --plane:#0d0d0d; --surface:#1a1a19;
    --ink:#ffffff; --ink-2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --axis:#383835; --ring:rgba(255,255,255,0.10);
    --series-1:#3987e5;
    --success-text:#0ca30c;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--plane);color:var(--ink);
    font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{max-width:1120px;margin:0 auto;padding:28px 20px 72px}
  h1{font-size:22px;margin:0 0 4px;letter-spacing:-0.01em}
  .sub{color:var(--ink-2);font-size:13px;margin:0 0 22px}
  .sub b{color:var(--ink);font-weight:600}
  a{color:var(--series-1)}

  .banner{border:1px solid var(--ring);border-radius:10px;padding:12px 14px;
    background:var(--surface);margin:0 0 20px;font-size:14px}
  .banner.hit{border-color:var(--critical)}
  .banner .ttl{font-weight:600;margin-bottom:4px;display:flex;gap:8px;align-items:center}
  .dot{width:9px;height:9px;border-radius:50%;flex:none}

  .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(330px,1fr))}
  .card{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:14px 16px 10px}
  .card h2{font-size:15px;margin:0 0 2px;font-weight:600}
  .meta{font-size:12px;color:var(--muted);margin:0 0 10px}
  .now{display:flex;align-items:baseline;gap:10px;margin:0 0 2px}
  .price{font-size:26px;font-weight:600;letter-spacing:-0.02em}
  .delta{font-size:13px;color:var(--ink-2)}
  .delta.down{color:var(--success-text)}
  .where{font-size:12px;color:var(--ink-2);margin:0 0 10px}
  figure{margin:0}
  svg{display:block;width:100%;height:auto;overflow:visible}
  .tick{font-size:10px;fill:var(--muted)}
  .annot{font-size:10px;fill:var(--ink-2)}
  .empty{font-size:12px;color:var(--muted);padding:26px 0;text-align:center}

  table{border-collapse:collapse;width:100%;font-size:13px;margin-top:8px}
  th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--grid)}
  th{color:var(--ink-2);font-weight:500;font-size:12px}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  details{margin-top:8px}
  summary{cursor:pointer;font-size:12px;color:var(--ink-2)}
  .flag{font-size:11px;color:var(--muted)}
  .bad{color:var(--critical)}
  .warn{color:var(--warning)}

  .tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .08s;
    background:var(--surface);border:1px solid var(--ring);border-radius:8px;
    padding:6px 9px;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.18);z-index:9}
  .tip b{font-variant-numeric:tabular-nums}
  footer{margin-top:34px;font-size:12px;color:var(--muted);line-height:1.7}
</style>
</head>
<body>
<div class="wrap">
  <h1>gen-watch</h1>
  <p class="sub">Ostatni skan: <b>${esc(runStamp)}</b> · status: <b>${esc(statusWord)}</b> ·
     zrodla ok ${data.run.sourcesOk}/${data.run.sourcesOk + data.run.sourcesBad}
     ${data.run.runUrl ? `· <a href="${esc(data.run.runUrl)}">przebieg</a>` : ""}
     <span id="deadline"></span></p>
  <div id="banner"></div>
  <div class="grid" id="grid"></div>
  <footer id="foot"></footer>
</div>
<div class="tip" id="tip"></div>
<script id="payload" type="application/json">${json}</script>
<script>
const D = JSON.parse(document.getElementById("payload").textContent);
const zl = (n) => n == null || !isFinite(n) ? "—"
  : n.toLocaleString("pl-PL",{maximumFractionDigits:0}) + " zł";
const esc = (s) => String(s==null?"":s).replace(/[&<>"']/g, c =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

// --- termin zakupu ---------------------------------------------------------
(function(){
  if (!D.deadline) return;
  const left = Math.ceil((Date.parse(D.deadline) - Date.parse(D.generatedAt)) / 86400000);
  const el = document.getElementById("deadline");
  if (left > 0) el.innerHTML = ' · do zakupu <b>' + left + ' dni</b>';
  else el.innerHTML = ' · <b>termin zakupu minal</b>';
})();

// --- baner alertow ---------------------------------------------------------
(function(){
  const el = document.getElementById("banner");
  if (!D.alerts.length){
    el.innerHTML = '<div class="banner"><div class="ttl">'
      + '<span class="dot" style="background:var(--good)"></span>Zadnej okazji</div>'
      + '<div style="color:var(--ink-2)">Wszystkie modele powyzej progow. '
      + 'Alert leci przy cenie ponizej progu sztywnego, przy spadku o '
      + D.rules.medianDropPct + '% wzgledem mediany ' + D.rules.medianWindowDays
      + ' dni, albo przy nowym minimum.</div></div>';
    return;
  }
  const rows = D.alerts.map(a =>
    '<li><b>' + esc(a.name) + '</b> — ' + zl(a.price) + ' w ' + esc(a.shop)
    + ' · ' + a.reasons.map(r => esc(r.text)).join(" · ")
    + ' · <a href="' + esc(a.url) + '">oferta</a></li>').join("");
  el.innerHTML = '<div class="banner hit"><div class="ttl">'
    + '<span class="dot" style="background:var(--critical)"></span>'
    + 'Okazja: ' + D.alerts.length + '</div><ul style="margin:6px 0 0;padding-left:18px">'
    + rows + '</ul></div>';
})();

// --- panele ----------------------------------------------------------------
const grid = document.getElementById("grid");
for (const p of D.panels) grid.appendChild(card(p));

function card(p){
  const el = document.createElement("section");
  el.className = "card";

  const best = p.best;
  const d = best ? (1 - best.price / p.baseline) * 100 : null;
  const deltaTxt = d == null ? ""
    : (d >= 0.5 ? "−" + d.toFixed(1) + "% vs baza" : d <= -0.5 ? "+" + (-d).toFixed(1) + "% vs baza" : "bez zmian vs baza");

  el.innerHTML =
    '<h2>' + esc(p.name) + '</h2>'
    + '<p class="meta">' + (p.ean ? "EAN " + esc(p.ean) : "bez EAN — dopasowanie po nazwie")
    + ' · prog ' + zl(p.threshold) + '</p>'
    + '<div class="now"><span class="price">' + zl(best && best.price) + '</span>'
    + '<span class="delta' + (d >= 0.5 ? " down" : "") + '">' + esc(deltaTxt) + '</span></div>'
    + '<p class="where">' + (best ? esc(best.shop) + (best.availability ? " · " + esc(best.availability) : "") : "brak ceny w tym przebiegu") + '</p>'
    + lowLine(p);

  function lowLine(p){
    if (p.low == null) return '';
    const isNow = best && best.price <= p.low;
    if (isNow) return '<p class="where"><b>To najtaniej, odkad obserwujemy.</b></p>';
    const when = p.lowAt ? new Date(p.lowAt).toLocaleDateString("pl-PL",{day:"numeric",month:"short"}) : null;
    return '<p class="where">Najtaniej dotad: <b>' + zl(p.low) + '</b>'
      + (when ? ' (' + when + ')' : '') + '</p>';
  }

  const fig = document.createElement("figure");
  fig.appendChild(chart(p));
  el.appendChild(fig);

  el.appendChild(offersTable(p));
  el.appendChild(marketTable(p));
  el.appendChild(sourceLog(p));
  return el;
}

// Rynek wtorny z toru B. Celowo osobna tabela, nie punkty na wykresie:
// uzywany egzemplarz i nowa sztuka ze sklepu to dwa rozne rynki, a wrzucenie
// ogloszenia za 3 000 zl do historii cen nowych wywrociloby mediane i minimum.
function marketTable(p){
  const d = document.createElement("details");
  if (!p.market){
    d.innerHTML = '<summary>Skan przegladarkowy — <span class="warn">brak danych</span></summary>'
      + '<p class="empty">Skan przez przegladarke jeszcze tu nic nie dolozyl. '
      + 'Ten tor dziala tylko przy wlaczonym komputerze.</p>';
    return d;
  }
  const ageH = Math.round((Date.parse(D.generatedAt) - Date.parse(p.market.ts)) / 3600000);
  const stale = ageH > 24;
  const ageTxt = ageH < 1 ? "przed chwila" : ageH < 48 ? ageH + " h temu"
    : Math.round(ageH/24) + " dni temu";

  d.innerHTML = '<summary>Skan przegladarkowy (' + p.market.offers.length + ') — '
    + '<span class="' + (stale ? "warn" : "flag") + '">' + ageTxt + '</span></summary>';

  const rows = p.market.offers.slice().sort((a,b) => a.price - b.price).map(o =>
    '<tr><td>' + (o.url ? '<a href="' + esc(o.url) + '">' + esc(o.site) + '</a>' : esc(o.site))
    + ' <span class="flag">' + esc(o.condition === "used" ? "uzywany" : o.condition === "new" ? "nowy" : "?") + '</span></td>'
    + '<td class="num">' + zl(o.price) + '</td>'
    + '<td>' + esc(o.location || "—") + (o.distanceKm != null ? ' <span class="flag">~' + o.distanceKm + ' km</span>' : '') + '</td>'
    + '<td class="flag">' + esc(o.note || o.title || "") + '</td></tr>').join("");

  d.innerHTML += '<table><thead><tr><th>Serwis</th><th class="num">Cena</th>'
    + '<th>Lokalizacja</th><th>Uwagi</th></tr></thead><tbody>' + rows + '</tbody></table>'
    + (stale ? '<p class="flag warn" style="margin-top:6px">Te dane sa nieswieze — '
      + 'ogloszenia z drugiej reki znikaja szybciej niz raz na dobe.</p>' : '');
  return d;
}

// Wykres liniowy, jedna seria. Prog i mediana to adnotacje w tuszu
// drugorzednym — nie kolejne serie, wiec legenda nie jest potrzebna:
// tytul panelu nazywa jedyna serie.
function chart(p){
  const W = 300, H = 132, L = 44, R = 12, T = 12, B = 22;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("role", "img");

  const pts = p.series;
  if (pts.length < 2){
    const g = document.createElementNS(NS, "text");
    g.setAttribute("x", W/2); g.setAttribute("y", H/2);
    g.setAttribute("text-anchor", "middle"); g.setAttribute("class", "tick");
    g.textContent = pts.length ? "jeden pomiar — historia buduje sie od dzis" : "brak historii";
    svg.appendChild(g);
    svg.setAttribute("aria-label", "Brak danych historycznych dla " + p.name);
    return svg;
  }

  const ys = pts.map(o => o.y).concat([p.threshold]).concat(p.median ? [p.median] : []);
  let lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
  if (hi === lo){ hi = lo * 1.02; lo = lo * 0.98; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const t0 = pts[0].t, t1 = pts[pts.length-1].t || t0 + 1;
  const X = t => L + (W - L - R) * (t1 === t0 ? 1 : (t - t0) / (t1 - t0));
  const Y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));

  // Siatka: trzy poziomy, hairline, celowo recesywna.
  for (let i = 0; i <= 2; i++){
    const v = lo + (hi - lo) * i / 2;
    const ln = document.createElementNS(NS, "line");
    ln.setAttribute("x1", L); ln.setAttribute("x2", W - R);
    ln.setAttribute("y1", Y(v)); ln.setAttribute("y2", Y(v));
    ln.setAttribute("stroke", "var(--grid)"); ln.setAttribute("stroke-width", "1");
    svg.appendChild(ln);
    const tx = document.createElementNS(NS, "text");
    tx.setAttribute("x", L - 6); tx.setAttribute("y", Y(v) + 3);
    tx.setAttribute("text-anchor", "end"); tx.setAttribute("class", "tick");
    tx.textContent = Math.round(v).toLocaleString("pl-PL");
    svg.appendChild(tx);
  }

  annotation(svg, NS, L, W - R, Y(p.threshold), "prog", "var(--critical)");
  if (p.median) annotation(svg, NS, L, W - R, Y(p.median), "mediana", "var(--muted)");

  const dAttr = pts.map((o, i) => (i ? "L" : "M") + X(o.t).toFixed(1) + " " + Y(o.y).toFixed(1)).join(" ");
  const line = document.createElementNS(NS, "path");
  line.setAttribute("d", dAttr);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "var(--series-1)");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linejoin", "round");
  line.setAttribute("stroke-linecap", "round");
  svg.appendChild(line);

  // Ostatni punkt dostaje marker z pierscieniem w kolorze powierzchni —
  // 2px odstepu, zeby nie zlewal sie z linia ani z siatka.
  const last = pts[pts.length-1];
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", X(last.t)); dot.setAttribute("cy", Y(last.y));
  dot.setAttribute("r", "4.5");
  dot.setAttribute("fill", "var(--series-1)");
  dot.setAttribute("stroke", "var(--surface)"); dot.setAttribute("stroke-width", "2");
  svg.appendChild(dot);

  const dtl = document.createElementNS(NS, "text");
  const flip = X(last.t) > W - R - 46;
  dtl.setAttribute("x", X(last.t) + (flip ? -8 : 8));
  dtl.setAttribute("y", Y(last.y) - 8);
  dtl.setAttribute("text-anchor", flip ? "end" : "start");
  dtl.setAttribute("class", "annot");
  dtl.textContent = Math.round(last.y).toLocaleString("pl-PL");
  svg.appendChild(dtl);

  const d0 = document.createElementNS(NS, "text");
  d0.setAttribute("x", L); d0.setAttribute("y", H - 6); d0.setAttribute("class", "tick");
  d0.textContent = new Date(t0).toLocaleDateString("pl-PL", { day:"numeric", month:"short" });
  svg.appendChild(d0);
  const d1 = document.createElementNS(NS, "text");
  d1.setAttribute("x", W - R); d1.setAttribute("y", H - 6);
  d1.setAttribute("text-anchor", "end"); d1.setAttribute("class", "tick");
  d1.textContent = new Date(t1).toLocaleDateString("pl-PL", { day:"numeric", month:"short" });
  svg.appendChild(d1);

  svg.setAttribute("aria-label",
    "Historia najnizszej ceny " + p.name + ": " + pts.length + " pomiarow, od "
    + zl(pts[0].y) + " do " + zl(last.y) + ". Pelne dane w tabeli ponizej.");

  hover(svg, pts, X, Y, L, W - R, p);
  return svg;
}

function annotation(svg, NS, x1, x2, y, label, color){
  const ln = document.createElementNS(NS, "line");
  ln.setAttribute("x1", x1); ln.setAttribute("x2", x2);
  ln.setAttribute("y1", y); ln.setAttribute("y2", y);
  ln.setAttribute("stroke", color); ln.setAttribute("stroke-width", "1");
  ln.setAttribute("stroke-dasharray", "3 3"); ln.setAttribute("opacity", "0.75");
  svg.appendChild(ln);
  // Podpis adnotacji idzie na LEWO. Prawa krawedz nalezy do ostatniego punktu
  // i jego etykiety - przy podpisie po prawej "mediana" nachodzila na kwote.
  const tx = document.createElementNS(NS, "text");
  tx.setAttribute("x", x1 + 3); tx.setAttribute("y", y - 3);
  tx.setAttribute("text-anchor", "start"); tx.setAttribute("class", "annot");
  tx.textContent = label;
  svg.appendChild(tx);
}

// Krzyzyk + dymek. Cel trafienia to cala szerokosc panelu, nie sam punkt.
function hover(svg, pts, X, Y, left, right, p){
  const NS = "http://www.w3.org/2000/svg";
  const tip = document.getElementById("tip");
  const cross = document.createElementNS(NS, "line");
  cross.setAttribute("stroke", "var(--axis)");
  cross.setAttribute("stroke-width", "1");
  cross.setAttribute("opacity", "0");
  svg.appendChild(cross);
  const mark = document.createElementNS(NS, "circle");
  mark.setAttribute("r", "5"); mark.setAttribute("fill", "var(--series-1)");
  mark.setAttribute("stroke", "var(--surface)"); mark.setAttribute("stroke-width", "2");
  mark.setAttribute("opacity", "0");
  svg.appendChild(mark);

  svg.addEventListener("pointermove", (ev) => {
    const box = svg.getBoundingClientRect();
    const vx = (ev.clientX - box.left) / box.width * 300;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i++){
      const dd = Math.abs(X(pts[i].t) - vx);
      if (dd < bd){ bd = dd; bi = i; }
    }
    const o = pts[bi];
    cross.setAttribute("x1", X(o.t)); cross.setAttribute("x2", X(o.t));
    cross.setAttribute("y1", 8); cross.setAttribute("y2", 112);
    cross.setAttribute("opacity", "1");
    mark.setAttribute("cx", X(o.t)); mark.setAttribute("cy", Y(o.y));
    mark.setAttribute("opacity", "1");
    tip.innerHTML = '<b>' + zl(o.y) + '</b><br>' + esc(o.shop || "") + '<br>'
      + new Date(o.t).toLocaleString("pl-PL", { timeZone:"Europe/Warsaw", dateStyle:"short", timeStyle:"short" });
    tip.style.opacity = "1";
    tip.style.left = Math.min(ev.clientX + 14, window.innerWidth - 170) + "px";
    tip.style.top = (ev.clientY + 14) + "px";
  });
  svg.addEventListener("pointerleave", () => {
    tip.style.opacity = "0";
    cross.setAttribute("opacity", "0");
    mark.setAttribute("opacity", "0");
  });
}

// Tabela ofert. Pelni tez role widoku tabelarycznego dla wykresu obok.
function offersTable(p){
  const d = document.createElement("details");
  const n = p.offers.length;
  d.innerHTML = '<summary>Oferty w tym przebiegu (' + n + ')</summary>';
  if (!n){ d.innerHTML += '<p class="empty">Zadne zrodlo nie oddalo ceny.</p>'; return d; }

  const rows = p.offers.map(o => {
    const cost = o.shippingKnown ? zl(o.cost) : zl(o.cost) + ' <span class="flag">bez dostawy</span>';
    const flags = [];
    if (o.method === "text") flags.push('<span class="warn">warstwa tekstowa</span>');
    if (o.method === "aggregator") flags.push('<span class="flag">z porownywarki</span>');
    if (o.discountPct) flags.push('<span class="flag">−' + o.discountPct + '%</span>');
    return '<tr><td>' + (o.url ? '<a href="' + esc(o.url) + '">' + esc(o.shop) + '</a>' : esc(o.shop)) + '</td>'
      + '<td class="num">' + zl(o.price) + '</td>'
      + '<td class="num">' + cost + '</td>'
      + '<td>' + esc(o.availability || "—") + ' ' + flags.join(" ") + '</td></tr>';
  }).join("");

  d.innerHTML += '<table><thead><tr><th>Sklep</th><th class="num">Cena</th>'
    + '<th class="num">Koszt koncowy</th><th>Stan</th></tr></thead><tbody>'
    + rows + '</tbody></table>'
    + '<p class="flag" style="margin-top:6px">Alert porownuje cene katalogowa, nie koszt koncowy — '
    + 'progi pochodza z cen katalogowych. Koszt koncowy jest tu po to, zebys sam ocenil, '
    + 'czy tansza oferta nadal jest tansza po dostawie.</p>';
  return d;
}

function sourceLog(p){
  const bad = p.sources.filter(s => s.status !== "ok");
  const d = document.createElement("details");
  d.innerHTML = '<summary>Zrodla: ' + (p.sources.length - bad.length) + '/' + p.sources.length
    + ' ok' + (bad.length ? ' — ' + bad.length + ' do sprawdzenia' : '') + '</summary>';
  d.innerHTML += '<table><tbody>' + p.sources.map(s =>
    '<tr><td>' + esc(s.shop) + (s.bestEffort ? ' <span class="flag">best-effort</span>' : '') + '</td>'
    + '<td class="' + (s.status === "ok" ? "" : s.bestEffort ? "warn" : "bad") + '">' + esc(s.status) + '</td>'
    + '<td class="flag">' + esc(s.issues.join("; ")) + '</td></tr>').join("") + '</tbody></table>';
  return d;
}

document.getElementById("foot").innerHTML =
  'Alert leci, gdy zadziala <b>ktorykolwiek</b> z trzech wyzwalaczy: cena ponizej progu sztywnego, '
  + 'spadek o ' + D.rules.medianDropPct + '% wzgledem mediany ' + D.rules.medianWindowDays + ' dni '
  + '(potrzeba ' + D.rules.minSamplesForMedian + ' pomiarow, zanim zacznie dzialac), albo nowe minimum. '
  + 'Ta sama cena w tym samym sklepie nie alarmuje ponownie przez ' + D.rules.realertAfterHours + ' h.'
  + '<br>Specyfikacje techniczne bierz wylacznie ze stron producenta — sklepy sie rozjezdzaja. '
  + 'Ta strona pokazuje ze sklepow wylacznie cene i dostepnosc.';
</script>
</body>
</html>`;
}
