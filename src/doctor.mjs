// Diagnostyka toru B na Windowsie: `node src/scan-local.mjs --doctor`.
//
// Odpowiada na jedno pytanie: dlaczego tor B nie zapisuje danych. Tor B
// milczal od 26.08.2026 i nie bylo jak tego sprawdzic bez grzebania w
// Harmonogramie zadan, logach i gicie po kolei. Tu wszystko jest w jednym
// miejscu, a kazdy problem ma podpowiedz, co zrobic.
//
// Podzial jak w telegram.mjs: ocena wynikow to czyste funkcje (assess*) i
// przechodzi przez selftest; wywolania gita i PowerShella sa cienka warstwa w
// runDoctor.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { localHealth, describeHealth, DEFAULT_STALE_HOURS } from "./localstatus.mjs";

const OK = "ok", WARN = "warn", FAIL = "fail", INFO = "info";

export function assessNode(version) {
  const major = Number(String(version).replace(/^v/, "").split(".")[0]);
  return major >= 20
    ? { level: OK, name: "Node", detail: version }
    : { level: FAIL, name: "Node", detail: `${version} - potrzebny Node 20 lub nowszy (nodejs.org, wersja LTS)` };
}

export function assessBranch(branch, dirtyFiles) {
  if (branch !== "main") {
    return { level: FAIL, name: "Galaz repo", detail: `jestes na "${branch}", a skan ma chodzic z main: git checkout main` };
  }
  if (dirtyFiles.length) {
    return { level: WARN, name: "Galaz repo",
      detail: `main ze zmienionymi plikami (${dirtyFiles.slice(0, 3).join(", ")}${dirtyFiles.length > 3 ? ", ..." : ""}) - git pull moze sie nie udac` };
  }
  return { level: OK, name: "Galaz repo", detail: "main, bez lokalnych zmian" };
}

// Wynik `git rev-list --left-right --count HEAD...origin/main`: "ahead behind".
// Lokalne commity na main to dokladnie przypadek z 26.08.2026: praca nad OLX
// nie zostala wypchnieta, pull --ff-only przestal dzialac i Harmonogram
// uruchamial kod, ktorego nie ma na GitHubie.
export function assessSync(aheadBehind) {
  const [ahead, behind] = String(aheadBehind).trim().split(/\s+/).map(Number);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return { level: WARN, name: "Zgodnosc z GitHubem", detail: "nie udalo sie porownac z origin/main" };
  }
  if (ahead > 0) {
    return { level: FAIL, name: "Zgodnosc z GitHubem",
      detail: `${ahead} lokalnych commitow na main, ktorych nie ma na GitHubie - skan chodzi na innym kodzie niz repo. ` +
        "Wypchnij je na osobna galaz (git push origin main:<nazwa>), potem git reset --hard origin/main" };
  }
  if (behind > 0) {
    return { level: INFO, name: "Zgodnosc z GitHubem", detail: `${behind} commitow do pobrania - skan-lokalny.bat zrobi git pull sam` };
  }
  return { level: OK, name: "Zgodnosc z GitHubem", detail: "kod zgodny z origin/main" };
}

export function assessPulse(statusJson, nowMs, staleAfterHours = DEFAULT_STALE_HOURS) {
  let status = null;
  try { status = statusJson ? JSON.parse(statusJson) : null; } catch { status = null; }
  const h = localHealth(status, nowMs, staleAfterHours);
  return { level: h.stale ? FAIL : OK, name: "Puls na galezi data", detail: describeHealth(h) };
}

// Lista zadan z PowerShella (Get-ScheduledTask + Get-ScheduledTaskInfo), tylko
// te, ktore uruchamiaja skan-lokalny. Kazda z tych przyczyn potrafi po cichu
// zatrzymac skan na laptopie.
export function assessTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : tasks ? [tasks] : [];
  if (!list.length) {
    return [{ level: FAIL, name: "Harmonogram zadan",
      detail: "brak zadania uruchamiajacego skan-lokalny.bat - uruchom scripts\\zainstaluj-harmonogram.ps1" }];
  }
  const out = [];
  if (list.length > 1) {
    out.push({ level: WARN, name: "Harmonogram zadan",
      detail: `${list.length} zadania uruchamiaja skan (${list.map((t) => t.Name).join(", ")}) - zostaw jedno` });
  }
  for (const t of list) {
    const n = `Zadanie "${t.Name}"`;
    if (String(t.State) === "Disabled") out.push({ level: FAIL, name: n, detail: "wylaczone" });
    if (t.DisallowOnBattery) out.push({ level: WARN, name: n, detail: "nie startuje na baterii - laptop bez zasilacza pominie skan" });
    if (!t.StartWhenAvailable) out.push({ level: WARN, name: n, detail: "brak 'uruchom jak najszybciej po przegapieniu' - uspiony laptop gubi przebieg" });
    // S4U = "uruchom niezaleznie od zalogowania" bez zapisanego hasla. Zadanie
    // nie ma wtedy dostepu do Menedzera poswiadczen, wiec git push nie ma loginu.
    if (String(t.LogonType) === "S4U") {
      out.push({ level: FAIL, name: n, detail: "logowanie S4U (bez zapisanego hasla) - git nie widzi poswiadczen i push na data pada. Zainstaluj zadanie ponownie skryptem" });
    }
    const code = Number(t.LastResult);
    if (!t.LastRun || code === 267011) out.push({ level: WARN, name: n, detail: "jeszcze nigdy nie uruchomione" });
    else if (code === 0) out.push({ level: OK, name: n, detail: `ostatnio ${t.LastRun}, zakonczone bez bledu` });
    else if (code === 1) out.push({ level: WARN, name: n, detail: `ostatnio ${t.LastRun}, kod 1 - zero cen albo nieudany push; szczegoly w skan-lokalny.log` });
    else out.push({ level: FAIL, name: n, detail: `ostatnio ${t.LastRun}, kod ${code} (0x${code.toString(16)}) - skrypt nie wystartowal albo zostal przerwany` });
  }
  return out;
}

function sh(cmd, args, cwd) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }) };
  } catch (e) {
    return { ok: false, out: String((e && (e.stderr || e.message)) || e) };
  }
}

const PS_TASKS = [
  "$ErrorActionPreference='SilentlyContinue';",
  "Get-ScheduledTask | Where-Object { (($_.Actions | ForEach-Object { [string]$_.Execute + ' ' + [string]$_.Arguments }) -join ' ') -match 'skan-lokalny' } |",
  "ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; [pscustomobject]@{",
  "Name = $_.TaskName; State = [string]$_.State; LogonType = [string]$_.Principal.LogonType;",
  "DisallowOnBattery = [bool]$_.Settings.DisallowStartIfOnBatteries; StartWhenAvailable = [bool]$_.Settings.StartWhenAvailable;",
  "LastRun = $(if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('yyyy-MM-dd HH:mm') } else { $null });",
  "LastResult = $i.LastTaskResult } } | ConvertTo-Json -Compress",
].join(" ");

export async function runDoctor({ repo, cfg, nowMs = Date.now() }) {
  const results = [];
  const add = (r) => results.push(...(Array.isArray(r) ? r : [r]));

  add(assessNode(process.version));

  const gitv = sh("git", ["--version"], repo);
  if (!gitv.ok) {
    add({ level: FAIL, name: "Git", detail: "git niedostepny w PATH" });
    return report(results);
  }

  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo).out.trim();
  const dirty = sh("git", ["status", "--porcelain", "--untracked-files=no"], repo).out
    .split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
  add(assessBranch(branch, dirty));

  const fetch = sh("git", ["fetch", "--quiet", "origin", "main", "data"], repo);
  if (!fetch.ok) {
    add({ level: FAIL, name: "Dostep do GitHuba (odczyt)", detail: "git fetch nie dziala: " + fetch.out.split("\n")[0] });
  } else {
    add({ level: OK, name: "Dostep do GitHuba (odczyt)", detail: "git fetch dziala" });
    add(assessSync(sh("git", ["rev-list", "--left-right", "--count", "HEAD...origin/main"], repo).out));
    const status = sh("git", ["show", "origin/data:docs/data/local-status.json"], repo);
    add(assessPulse(status.ok ? status.out : null, nowMs, cfg.meta.alertRules.localStaleHours));
  }

  // --dry-run laczy sie z GitHubem i sprawdza uprawnienia, ale niczego nie tworzy.
  const push = sh("git", ["push", "--dry-run", "--quiet", "origin", "HEAD:refs/heads/gen-watch-doctor-test"], repo);
  add(push.ok
    ? { level: OK, name: "Dostep do GitHuba (zapis)", detail: "poswiadczenia gita pozwalaja na push" }
    : { level: FAIL, name: "Dostep do GitHuba (zapis)", detail: "push odrzucony: " + push.out.split("\n")[0] + " - zaloguj sie: git push z tego katalogu i podaj login w oknie Git Credential Manager" });

  add({ level: INFO, name: "Telegram",
    detail: process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
      ? "zmienne ustawione - awaria toru B da wiadomosc"
      : "brak TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID - tor B nie powiadomi sam o awarii (tor A i tak zauwazy cisze)" });

  if (process.platform === "win32") {
    // -EncodedCommand (UTF-16LE w base64): zadnych cudzyslowow do przepychania
    // przez linie polecen Windowsa.
    const enc = Buffer.from(PS_TASKS, "utf16le").toString("base64");
    const ps = sh("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", enc], repo);
    let tasks = [];
    try { tasks = ps.out.trim() ? JSON.parse(ps.out) : []; } catch { tasks = []; }
    add(assessTasks(tasks));
  } else {
    add({ level: INFO, name: "Harmonogram zadan", detail: "sprawdzany tylko na Windowsie" });
  }

  const log = path.join(repo, "skan-lokalny.log");
  if (fs.existsSync(log)) {
    const tail = fs.readFileSync(log, "utf8").trimEnd().split(/\r?\n/).slice(-4).join("\n      ");
    add({ level: INFO, name: "Koniec skan-lokalny.log", detail: "\n      " + tail });
  } else {
    add({ level: INFO, name: "skan-lokalny.log", detail: "brak pliku - skan z Harmonogramu jeszcze nie ruszyl w tym katalogu" });
  }

  return report(results);
}

function report(results) {
  const tag = { ok: "[ OK ]", warn: "[ !! ]", fail: "[BLAD]", info: "[ -- ]" };
  console.log("gen-watch - diagnostyka toru B\n");
  for (const r of results) console.log(`${tag[r.level]} ${r.name}: ${r.detail}`);
  const fails = results.filter((r) => r.level === FAIL).length;
  const warns = results.filter((r) => r.level === WARN).length;
  console.log(`\n${fails ? `${fails} bledow` : "Bez bledow"}${warns ? `, ${warns} ostrzezen` : ""}.`);
  return fails ? 1 : 0;
}
