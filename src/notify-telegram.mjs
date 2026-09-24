// Entrypoint powiadomien Telegram dla toru A (GitHub Actions). Cienki: cala
// logika "co wyslac" siedzi w telegram.mjs i jest testowana offline. Tu tylko
// wczytanie snapshotu, kluczy z env i wyslanie.
//
//   node src/notify-telegram.mjs           # przeczytaj latest.json, wyslij co trzeba
//   node src/notify-telegram.mjs --test    # wiadomosc testowa z aktualnymi cenami
//
// Poza alertami (telegram.mjs) wysyla zmiany najnizszej ceny i raport dzienny
// (digest.mjs); wlacza/wylacza je meta.telegram w config/products.json.
//
// W zwyklym trybie nigdy nie konczy bledem: awaria Telegrama albo brak
// sekretow nie moga przewrocic przebiegu, Issue i historia sa zrodlem prawdy.
// Wyjatek to --test: tam blad ma byc widoczny (czerwony przebieg w Actions).

import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, loadHistory, DATA_DIR } from "./store.mjs";
import { marketFile } from "./ingest.mjs";
import { planMessages, sendTelegram } from "./telegram.mjs";
import { planPriceChanges, dailyReportDue, formatDailyReport, formatTestMessage } from "./digest.mjs";

const TEST = process.argv.includes("--test");
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const latestFile = path.join(DATA_DIR, "latest.json");

if (!token || !chatId) {
  console.log("Telegram: brak TELEGRAM_BOT_TOKEN albo TELEGRAM_CHAT_ID - pomijam.");
  // Test ma swiecic na czerwono, gdy sekretow nie ma - po to sie go klika.
  process.exit(TEST ? 1 : 0);
}

if (TEST) {
  const r = await sendTelegram(formatTestMessage(readJson(latestFile, null), Date.now()), { token, chatId });
  console.log(r.ok ? "Telegram: test wyslany." : `Telegram: test nieudany - ${r.error}`);
  process.exit(r.ok ? 0 : 1);
}

if (!fs.existsSync(latestFile)) {
  console.log("Telegram: brak docs/data/latest.json - nie ma z czego wysylac.");
  process.exit(0);
}

const snapshot = readJson(latestFile, null);
if (!snapshot) {
  console.log("Telegram: latest.json nie parsuje sie - pomijam.");
  process.exit(0);
}

const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "products.json"), "utf8"));
const realertAfterHours = cfg.meta.alertRules.realertAfterHours;
const tg = { daily: true, changes: true, dailyFromHour: 7, ...(cfg.meta.telegram || {}) };
const nowMs = Date.now();

const stateFile = path.join(DATA_DIR, "state.json");
const state = readJson(stateFile, {});

// Alert, degraded i cisza toru B: planMessages wpisuje swoje znaczniki do
// `state` od razu (tak bylo od poczatku). Nowe wiadomosci niosa wlasne
// `updates`, zapisywane dopiero po udanej wysylce - nieudany raport dzienny
// nie moze przepasc na cala dobe.
const outgoing = planMessages(snapshot, state, nowMs, realertAfterHours).map((text) => ({ text, updates: null }));
let dirty = false;

if (tg.changes) {
  const ch = planPriceChanges(snapshot.products, state, nowMs);
  if (Object.keys(ch.silent).length) { Object.assign(state, ch.silent); dirty = true; }
  if (ch.text) outgoing.push({ text: ch.text, updates: ch.updates });
}

const dailyKey = tg.daily ? dailyReportDue(state, nowMs, tg.dailyFromHour) : null;
if (dailyKey) {
  const histories = {}, markets = {};
  for (const p of snapshot.products || []) {
    histories[p.id] = loadHistory(p.id);
    markets[p.id] = readJson(marketFile(p.id), null);
  }
  const repo = process.env.GITHUB_REPOSITORY;
  const dashboardUrl = repo ? `https://${repo.split("/")[0]}.github.io/${repo.split("/")[1]}/` : null;
  outgoing.push({
    text: formatDailyReport({ snapshot, histories, markets, deadline: cfg.meta.deadline, dashboardUrl, nowMs }),
    updates: { [dailyKey]: nowMs },
  });
}

if (!outgoing.length) console.log("Telegram: nic do wyslania.");

let anySent = false;
for (const msg of outgoing) {
  const r = await sendTelegram(msg.text, { token, chatId });
  if (r.ok) {
    anySent = true;
    if (msg.updates) Object.assign(state, msg.updates);
    console.log("Telegram: wyslano wiadomosc.");
  } else {
    console.log(`Telegram: wysylka nieudana (${r.status || "-"}) - ${r.error}`);
  }
}

// Znaczniki z planMessages utrwalamy tylko, gdy cokolwiek poszlo - inaczej
// awaria Telegrama wyciszylaby sygnal na dobe mimo ze nic nie doszlo.
if (anySent || dirty) writeJson(stateFile, state);

process.exit(0);
