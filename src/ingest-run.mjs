// Wejscie dla workflow "ingest". Czyta tresc Issue z pliku, waliduje, dopisuje
// oferty rynku wtornego i wypluwa raport, ktory workflow wkleja w komentarzu.
//
// Uzycie: node src/ingest-run.mjs <plik-z-trescia-issue>
//
// Kod wyjscia 0 nawet przy odrzuconym zgloszeniu - workflow ma skomentowac
// Issue i zamknac je, a nie swiecic na czerwono z powodu literowki w tresci.

import fs from "node:fs";
import path from "node:path";
import { extractBlock, validate, mergeMarket, marketAlerts } from "./ingest.mjs";
import { readJson, writeJson, DATA_DIR } from "./store.mjs";

const bodyFile = process.argv[2];
if (!bodyFile) {
  console.error("Podaj plik z trescia Issue.");
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "products.json"), "utf8"));
const ids = new Set(cfg.products.map((p) => p.id));
const rules = cfg.meta.alertRules;
const nowMs = Date.now();

const body = fs.readFileSync(bodyFile, "utf8");
const report = [];
let accepted = 0;
let alerts = [];

const block = extractBlock(body);
if (!block.ok) {
  report.push(`Nie przyjalem zgloszenia: **${block.error}**`);
  report.push("", "Oczekiwany format to blok ```json z polami `scan` i `offers` — patrz `BROWSER-SCAN.md`.");
} else {
  const v = validate(block.data, ids);
  for (const e of v.errors) report.push(`- odrzucone: ${e}`);

  if (!v.offers.length) {
    report.push("", "Zadna oferta nie przeszla walidacji — nic nie zapisalem.");
  } else {
    mergeMarket(v.offers);
    accepted = v.offers.length;

    const state = readJson(path.join(DATA_DIR, "state.json"), {});
    alerts = marketAlerts(v.offers, cfg.products, state, nowMs, rules.realertAfterHours);
    writeJson(path.join(DATA_DIR, "state.json"), state);

    const zl = (n) => Number(n).toLocaleString("pl-PL") + " zl";
    report.unshift(`Przyjalem **${accepted}** ofert z rynku wtornego.`, "");

    if (alerts.length) {
      report.push("", "### Ponizej progu", "", "| Model | Cena | Gdzie | Stan | Lokalizacja |", "|---|---|---|---|---|");
      for (const a of alerts) {
        const cell = (s) => String(s == null ? "—" : s).replace(/\|/g, "/");
        report.push(`| ${cell(a.name)} | **${zl(a.price)}** (prog ${zl(a.threshold)}) | ${a.url ? `[${cell(a.shop)}](${a.url})` : cell(a.shop)} | ${cell(a.condition)} | ${cell(a.location)}${a.distanceKm != null ? ` (~${a.distanceKm} km)` : ""} |`);
      }
      report.push("", "Uzywany egzemplarz ponizej progu to nie to samo co promocja w sklepie — sprawdz motogodziny, rok i to, czy sprzedajacy odpali go pod obciazeniem.");
    } else {
      report.push("", "Zadna z ofert nie schodzi ponizej progu.");
    }
  }
}

fs.writeFileSync("/tmp/ingest-report.md", report.join("\n") + "\n");
fs.writeFileSync("/tmp/ingest-accepted.txt", String(accepted));
console.log(report.join("\n"));
