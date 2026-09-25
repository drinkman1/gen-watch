// Scalenie z aktualna galezia data tuz przed `push --force`.
//
// Tor A i ingest pobieraja galaz data na starcie, a po kilku-kilkunastu
// minutach wypychaja ja z --force. Jesli w tym oknie tor B (skan lokalny)
// dopisal swoje oferty, force-push je kasowal - bez sladu. Ten modul pobiera
// swiezy stan galezi i dokleja do drzewa roboczego to, co w miedzyczasie
// przyszlo z zewnatrz. Uklad katalogow i sam force-push zostaja bez zmian.
//
// Kto co pisze - i dlatego jak scalamy:
//   market/*.json      tor B i ingest       unia skanow po ts, ostatnie `keepScans`
//   state.json         wszyscy              per klucz wygrywa pozniejszy znacznik
//   local-status.json  tylko tor B          wygrywa nowszy `ts`
//   history/, latest.json, runs.json  tylko tor A - nie ruszamy
//
//   node src/datasync.mjs <katalog docs/data z galezi zdalnej>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson, DATA_DIR } from "./store.mjs";
import { LOCAL_STATUS } from "./localstatus.mjs";

export function mergeMarketDoc(local, remote, keepScans = 12) {
  const scans = new Map();
  // Zdalne najpierw, lokalne nadpisuja przy tym samym ts - lokalna kopia to
  // ta, ktora biezacy przebieg wlasnie przygotowal.
  for (const doc of [remote, local]) {
    for (const s of (doc && Array.isArray(doc.scans) ? doc.scans : [])) {
      if (s && s.ts) scans.set(s.ts, s);
    }
  }
  const productId = (local && local.productId) || (remote && remote.productId);
  const merged = [...scans.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { productId, scans: merged.slice(-keepScans) };
}

// Wartosci w state to znaczniki czasu (ms). Wiekszy = pozniejszy, wiec max
// zachowuje wyciszenie ustawione przez ktorakolwiek strone.
export function mergeState(local, remote) {
  const out = { ...(remote || {}) };
  for (const [k, v] of Object.entries(local || {})) {
    const r = out[k];
    out[k] = Number.isFinite(r) && Number.isFinite(v) ? Math.max(r, v) : v;
  }
  return out;
}

export function newerStatus(local, remote) {
  if (!remote) return local || null;
  if (!local) return remote;
  return Date.parse(remote.ts) > Date.parse(local.ts) ? remote : local;
}

// Scala katalog `remoteDir` (docs/data z galezi zdalnej) do `localDir`.
// Zwraca liste zmienionych plikow - do logu przebiegu.
export function syncDataDirs(localDir, remoteDir) {
  const changed = [];
  const put = (rel, data, before) => {
    if (JSON.stringify(data) === JSON.stringify(before)) return;
    writeJson(path.join(localDir, rel), data);
    changed.push(rel);
  };

  const remoteMarket = path.join(remoteDir, "market");
  if (fs.existsSync(remoteMarket)) {
    for (const f of fs.readdirSync(remoteMarket).filter((x) => x.endsWith(".json"))) {
      const rel = path.join("market", f);
      const local = readJson(path.join(localDir, rel), null);
      const remote = readJson(path.join(remoteDir, rel), null);
      put(rel, mergeMarketDoc(local, remote), local);
    }
  }

  const localState = readJson(path.join(localDir, "state.json"), null);
  const remoteState = readJson(path.join(remoteDir, "state.json"), null);
  if (remoteState) put("state.json", mergeState(localState, remoteState), localState);

  const localStatus = readJson(path.join(localDir, LOCAL_STATUS), null);
  const remoteStatus = readJson(path.join(remoteDir, LOCAL_STATUS), null);
  const status = newerStatus(localStatus, remoteStatus);
  if (status) put(LOCAL_STATUS, status, localStatus);

  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const remoteDir = process.argv[2];
  if (!remoteDir || !fs.existsSync(remoteDir)) {
    console.log("Scalenie: brak katalogu z galezi zdalnej - nic do scalenia.");
    process.exit(0);
  }
  const changed = syncDataDirs(DATA_DIR, remoteDir);
  console.log(changed.length
    ? `Scalenie z galezia data: doklejono ${changed.join(", ")}`
    : "Scalenie z galezia data: nic nowego z zewnatrz.");
}
