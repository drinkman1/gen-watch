// Skan lokalny - tor B bez przegladarki i bez modelu.
//
// Powod istnienia: e-katalog, Ceneo, Amazon i Komputronik odrzucaja runnery
// GitHuba, bo stoja w Azure. Nie potrzebuja jednak ani Chrome'a, ani LLM-a -
// potrzebuja adresu IP z domowego lacza. Ten skrypt uruchamiany Harmonogramem
// zadan Windows robi dokladnie to samo, co tor A, tylko z Twojego polaczenia,
// i zapisuje wynik prosto na galezi `data` Twoimi poswiadczeniami gita.
//
//   node src/scan-local.mjs --dry     # tylko sprawdz, nic nie zapisuj
//   node src/scan-local.mjs           # sprawdz, zapisz i wypchnij
//
// Dane trafiaja do docs/data/market/, czyli tam gdzie skan przegladarkowy -
// osobno od historii cen z toru A. Dashboard na GitHub Pages odswiezy sie przy
// najblizszym przebiegu Actions, czyli w ciagu trzech godzin.
//
// Przy kazdym przebiegu (takze bez ani jednej ceny) idzie tez puls
// docs/data/local-status.json - po nim tor A poznaje, ze tor B zamilkl.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(REPO, ".local-data");
const DRY = process.argv.includes("--dry");

process.env.GEN_WATCH_DATA_DIR = path.join(WORK, "docs", "data");
process.env.GEN_WATCH_NO_BROWSER = "1";

const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "config", "products.json"), "utf8"));
const rules = cfg.meta.alertRules;

function git(args, cwd = WORK) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function originUrl() {
  return git(["remote", "get-url", "origin"], REPO).trim();
}

// Plytki klon galezi data w podkatalogu. Drzewo robocze uzytkownika zostaje
// nietkniete - bez tego `git checkout origin/data -- docs/data` brudzilby
// gałąź main przy kazdym uruchomieniu.
function prepareWorkdir() {
  // Tryb --dry nigdy nie dotyka gita. Ma odpowiedziec na jedno pytanie:
  // czy z tej maszyny w ogole da sie pobrac te strony.
  if (DRY) {
    fs.mkdirSync(path.join(WORK, "docs", "data"), { recursive: true });
    console.log("Tryb --dry: bez gita, bez zapisu - sprawdzam tylko dostepnosc zrodel.");
    return;
  }
  if (!fs.existsSync(path.join(WORK, ".git"))) {
    console.log("Pierwsze uruchomienie - klonuje galaz data...");
    fs.rmSync(WORK, { recursive: true, force: true });
    execFileSync("git", ["clone", "--depth", "1", "--branch", "data", originUrl(), WORK],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } else {
    git(["fetch", "--depth", "1", "origin", "data"]);
    git(["reset", "--hard", "origin/data"]);
  }
}

// Nazwa sklepu -> kategoria serwisu w danych rynkowych.
function siteOf(shop) {
  const s = String(shop).toLowerCase();
  if (s.includes("ceneo")) return "ceneo";
  if (s.includes("allegro")) return "allegro";
  return "inne";
}

const started = new Date().toISOString();

try {
  prepareWorkdir();
} catch (e) {
  console.error("Nie udalo sie przygotowac katalogu roboczego: " + (e && e.message));
  console.error("Sprawdz, czy jestes w katalogu repo i czy `git fetch` dziala z tej maszyny.");
  process.exit(2);
}

// Import PO ustawieniu GEN_WATCH_DATA_DIR - store.mjs czyta ta zmienna przy
// wczytaniu modulu, wiec statyczny import wskazalby zly katalog.
const { scrapeSource } = await import("./adapters/index.mjs");
const { closeBrowser } = await import("./fetch.mjs");
const { mergeMarket, marketAlerts } = await import("./ingest.mjs");
const { readJson, writeJson, ensureDirs, DATA_DIR } = await import("./store.mjs");
const { buildLocalStatus, LOCAL_STATUS } = await import("./localstatus.mjs");
const { mergeState } = await import("./datasync.mjs");

ensureDirs();

const offers = [];
const report = [];
const results = [];
let ok = 0, bad = 0;

for (const product of cfg.products) {
  for (const source of product.localSources || []) {
    let r;
    try {
      r = await scrapeSource(product, source);
    } catch (e) {
      r = { status: "error", offers: [], issues: ["wyjatek: " + String(e && e.message || e)] };
    }

    if (r.status === "ok" && r.offers.length) {
      ok++;
      for (const o of r.offers) {
        offers.push({
          productId: product.id,
          site: siteOf(o.shop),
          price: o.price,
          condition: "new",
          url: o.url || source.url,
          title: o.shop,
          location: null,
          distanceKm: null,
          note: `sklep: ${o.shop}${o.discountPct ? `, rabat ${o.discountPct}%` : ""}`,
          seenAt: started,
        });
      }
      results.push({ productId: product.id, shop: source.shop, status: "ok",
        price: Math.min(...r.offers.map((o) => o.price)), issue: null });
      report.push(`  OK   ${product.id} / ${source.shop}: ${r.offers.map((o) => o.price + " zl (" + o.shop + ")").join(", ")}`);
    } else {
      bad++;
      const why = (r.issues || []).join(" · ");
      // "ok" bez ofert to w torze B tez porazka - zrodlo nie oddalo ceny.
      results.push({ productId: product.id, shop: source.shop,
        status: r.status === "ok" ? "empty" : r.status, price: null, issue: why || null });
      report.push(`  --   ${product.id} / ${source.shop}: ${r.status}${why ? " — " + why : ""}`);
    }
  }
}

await closeBrowser();

console.log(`\nSkan lokalny ${started}`);
console.log(report.join("\n"));
console.log(`\nZrodel z cena: ${ok}, bez ceny: ${bad}, ofert lacznie: ${offers.length}`);

if (!offers.length) {
  console.log("\nNic nie zebrano. Jesli w powodach widzisz \"Cierpliwosci\" albo");
  console.log("\"weryfikacja zabezpieczen\" - to znaczy, ze ochrona antybotowa odrzuca");
  console.log("takze Twoj adres, i sam skrypt tego nie przeskoczy.");
}

if (DRY) {
  console.log("\nTryb --dry: nic nie zapisano ani nie wypchnieto.");
  process.exit(0);
}

// Alerty i Telegram licza sie raz, na stanie z galezi data. Do pliku trafiaja
// dopiero w applyToWorkdir - jako roznica, zeby ponowienie po odrzuconym
// pushu moglo nalozyc ja na swiezy stan zdalny.
const statePath = path.join(DATA_DIR, "state.json");
const state0 = readJson(statePath, {});
const state = { ...state0 };
const alerts = marketAlerts(offers, cfg.products, state, Date.now(), rules.realertAfterHours);

if (alerts.length) {
  console.log("\n=== PONIZEJ PROGU ===");
  for (const a of alerts) {
    console.log(`  ${a.name}: ${a.price} zl (prog ${a.threshold}) — ${a.shop}`);
    if (a.url) console.log(`     ${a.url}`);
  }
} else if (offers.length) {
  console.log("\nZadna oferta nie schodzi ponizej progu.");
}

// Telegram - ten sam modul co tor A. Tor B nie ma modelu zdrowia zrodel jak
// tor A, wiec sygnal o awarii leci tylko przy calkowitej porazce (zero ofert),
// z lista zrodel, ktore nie oddaly ceny.
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  const { planMessages, sendTelegram } = await import("./telegram.mjs");
  const names = new Map(cfg.products.map((p) => [p.id, p.name]));
  const snapLike = {
    alerts,
    products: offers.length ? [] : [...names].map(([id, name]) => ({
      name: `${name} (tor B)`,
      best: { price: 0 },
      sources: results.filter((r) => r.productId === id)
        .map((r) => ({ shop: r.shop, status: r.status, bestEffort: false })),
    })),
    run: { status: offers.length ? "ok" : "error", sourcesOk: ok, sourcesBad: bad },
  };
  const msgs = planMessages(snapLike, state, Date.now(), rules.realertAfterHours);
  for (const m of msgs) {
    const r = await sendTelegram(m, {
      token: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
    });
    console.log(r.ok ? "Telegram: wyslano." : `Telegram: wysylka nieudana - ${r.error}`);
  }
}

const stateUpdates = {};
for (const [k, v] of Object.entries(state)) if (state0[k] !== v) stateUpdates[k] = v;

let code = null;
try { code = git(["rev-parse", "--short", "HEAD"], REPO).trim(); } catch { /* bez wersji */ }

// Zapis do klonu galezi data. Puls idzie ZAWSZE, takze przy zerze ofert -
// inaczej awaria toru B wygladalaby z zewnatrz dokladnie jak wylaczony laptop.
function applyToWorkdir() {
  const statusPath = path.join(DATA_DIR, LOCAL_STATUS);
  const prev = readJson(statusPath, null);
  writeJson(statusPath, buildLocalStatus({ ts: started, code, results, prev }));
  if (offers.length) mergeMarket(offers);
  writeJson(statePath, mergeState(stateUpdates, readJson(statePath, {})));
}

function commitAndPush() {
  git(["add", "-A"]);
  if (!git(["diff", "--staged", "--name-only"]).trim()) return false;
  git(["-c", "user.name=gen-watch local", "-c", "user.email=actions@github.com",
    "commit", "-q", "-m", `gen-watch: skan lokalny ${started.slice(0, 16)}Z`]);
  git(["push", "origin", "HEAD:data"]);
  return true;
}

let pushed = false;
try {
  applyToWorkdir();
  pushed = commitAndPush();
} catch (e) {
  // Najczestszy powod: tor A zrobil w miedzyczasie force-push i nasz push nie
  // jest juz fast-forward. Jedno ponowienie na swiezym stanie galezi.
  console.error("\nPierwszy push odrzucony (" + String(e && e.message || e).split("\n")[0] + ") - ponawiam na swiezym stanie.");
  try {
    git(["fetch", "--depth", "1", "origin", "data"]);
    git(["reset", "--hard", "origin/data"]);
    applyToWorkdir();
    pushed = commitAndPush();
  } catch (e2) {
    console.error("\nZapis albo push nie powiodl sie: " + (e2 && e2.message));
    console.error("Dane zostaly policzone, ale nie trafily do repo. Sprawdz poswiadczenia gita.");
    process.exit(1);
  }
}

console.log(pushed
  ? "\nZapisano na galezi data. Dashboard odswiezy sie przy najblizszym przebiegu Actions."
  : "\nBez zmian w danych - nie ma czego wypychac.");

// Kod 1 przy zerze ofert zostaje: Harmonogram zadan pokaze wtedy blad, a puls
// z zerem i tak juz jest na galezi data.
process.exit(offers.length ? 0 : 1);
