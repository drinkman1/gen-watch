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

ensureDirs();

const offers = [];
const report = [];
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
      report.push(`  OK   ${product.id} / ${source.shop}: ${r.offers.map((o) => o.price + " zl (" + o.shop + ")").join(", ")}`);
    } else {
      bad++;
      const why = (r.issues || []).join(" · ");
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
  process.exit(DRY ? 0 : 1);
}

if (DRY) {
  console.log("\nTryb --dry: nic nie zapisano ani nie wypchnieto.");
  process.exit(0);
}

// Zapis i alerty. Rynek "nowy" ze sklepow chodzi tym samym torem co uzywane -
// osobno od historii cen, z jednym wyzwalaczem: prog sztywny.
mergeMarket(offers);
const state = readJson(path.join(DATA_DIR, "state.json"), {});
const alerts = marketAlerts(offers, cfg.products, state, Date.now(), rules.realertAfterHours);
writeJson(path.join(DATA_DIR, "state.json"), state);

if (alerts.length) {
  console.log("\n=== PONIZEJ PROGU ===");
  for (const a of alerts) {
    console.log(`  ${a.name}: ${a.price} zl (prog ${a.threshold}) — ${a.shop}`);
    if (a.url) console.log(`     ${a.url}`);
  }
} else {
  console.log("\nZadna oferta nie schodzi ponizej progu.");
}

try {
  git(["add", "-A"]);
  const staged = git(["diff", "--staged", "--name-only"]).trim();
  if (!staged) {
    console.log("\nBez zmian w danych - nie ma czego wypychac.");
  } else {
    git(["-c", "user.name=gen-watch local", "-c", "user.email=actions@github.com",
      "commit", "-q", "-m", `gen-watch: skan lokalny ${started.slice(0, 16)}Z`]);
    git(["push", "origin", "HEAD:data"]);
    console.log("\nZapisano na galezi data. Dashboard odswiezy sie przy najblizszym przebiegu Actions.");
  }
} catch (e) {
  console.error("\nZapis albo push nie powiodl sie: " + (e && e.message));
  console.error("Dane zostaly policzone, ale nie trafily do repo. Sprawdz poswiadczenia gita.");
  process.exit(1);
}
