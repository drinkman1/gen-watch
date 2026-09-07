// Entrypoint powiadomien Telegram dla toru A (GitHub Actions). Cienki: cala
// logika "co wyslac" siedzi w telegram.mjs i jest testowana offline. Tu tylko
// wczytanie snapshotu, kluczy z env i wyslanie.
//
//   node src/notify-telegram.mjs           # przeczytaj latest.json, wyslij co trzeba
//   node src/notify-telegram.mjs --test    # wyslij sztywna wiadomosc testowa
//
// Nigdy nie konczy bledem: awaria Telegrama albo brak sekretow nie moga
// przewrocic przebiegu. Issue i historia sa zrodlem prawdy.

import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, DATA_DIR } from "./store.mjs";
import { planMessages, sendTelegram } from "./telegram.mjs";

const TEST = process.argv.includes("--test");
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  console.log("Telegram: brak TELEGRAM_BOT_TOKEN albo TELEGRAM_CHAT_ID - pomijam.");
  process.exit(0);
}

if (TEST) {
  const r = await sendTelegram("gen-watch: test polaczenia", { token, chatId });
  console.log(r.ok ? "Telegram: test wyslany." : `Telegram: test nieudany - ${r.error}`);
  process.exit(0);
}

const latestFile = path.join(DATA_DIR, "latest.json");
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

const stateFile = path.join(DATA_DIR, "state.json");
const state = readJson(stateFile, {});

const messages = planMessages(snapshot, state, Date.now(), realertAfterHours);
if (!messages.length) {
  console.log("Telegram: nic do wyslania.");
  process.exit(0);
}

let anySent = false;
for (const msg of messages) {
  const r = await sendTelegram(msg, { token, chatId });
  if (r.ok) {
    anySent = true;
    console.log("Telegram: wyslano wiadomosc.");
  } else {
    console.log(`Telegram: wysylka nieudana (${r.status || "-"}) - ${r.error}`);
  }
}

// Znacznik anty-spamu dla sygnalu degraded zostal juz wpisany do `state` przez
// planMessages. Utrwalamy go tylko, gdy cokolwiek poszlo - inaczej awaria
// Telegrama wyciszylaby sygnal na dobe mimo ze nic nie doszlo.
if (anySent) writeJson(stateFile, state);

process.exit(0);
