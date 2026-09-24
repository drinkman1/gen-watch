# gen-watch

Monitoring cen pięciu agregatów prądotwórczych. Skan co 3 godziny na GitHub Actions,
alert przez Issue (GitHub wysyła za nie maila) i opcjonalnie Telegram, dashboard
z historią cen na GitHub Pages.

Bliźniak `role-watch` — ten sam układ gałęzi, ten sam mechanizm powiadomień, ta sama
zasada „bot nigdy nie dotyka `main`".

## Co śledzi

| Model | EAN | Cena bazowa | Próg sztywny |
|---|---|---|---|
| Könner & Söhnen KS 8100iE ATSR | 4260405364725 | 4 999 zł | < 4 800 zł |
| Könner & Söhnen KS 8100iEG | 4260405364817 | 5 688 zł | < 5 400 zł |
| Könner & Söhnen KS 9500iE S ATSR | 4260405367184 | 9 859 zł | < 9 300 zł |
| Fogo F 8001 iSG | brak | 8 999 zł | < 8 500 zł |
| Fogo F 12000 iSG | brak | 11 998 zł | < 11 300 zł |

Fogo nie publikuje EAN-ów — ani na stronie producenta, ani w kartach produktu.
Dla tych dwóch modeli dopasowanie idzie po znormalizowanej nazwie na **zamkniętej
liście URL-i**, nigdy na dziko. Numer `1000001714707` widoczny u profimarketu to
wewnętrzny identyfikator sklepu, nie GTIN — nie używać.

## Kiedy leci alert

Trzy niezależne wyzwalacze, alert przy **którymkolwiek**:

1. **Próg sztywny** — cena poniżej kwoty z tabeli wyżej.
2. **Mediana** — cena o 7% niżej niż mediana z 30 dni. Rusza dopiero po ośmiu
   pomiarach; wcześniej nie ma z czego liczyć i wyzwalacz milczy.
3. **Nowe minimum** — taniej niż kiedykolwiek wcześniej w historii.

Ta sama cena w tym samym sklepie nie alarmuje ponownie przez 24 h. Bez tego przy
skanie co 3 h jedna promocja dawałaby osiem maili dziennie.

Pierwszy przebieg nigdy nie alarmuje — inaczej start bota wysyłałby pięć powiadomień
„nowe minimum" na dzień dobry.

**Alerty ze skanu lokalnego (tor B1: Ceneo, Amazon, Komputronik)** idą tym samym
Issue `GEN_Alert`, więc tym samym mailem. Tor B nie zakłada Issue sam. Zapisuje alert
w `docs/data/local-status.json` (`pendingAlerts`), a najbliższy przebieg toru A dokłada
go do swoich alertów z dopiskiem „(skan lokalny)”. Mail przychodzi więc do ~3 h po
skanie lokalnym. Na Telegram tor B wysyła alert od razu, a tor A już go nie powtarza.
Alert niewysłany w ciągu 48 h przepada. Tor B1 ma tylko wyzwalacz progu sztywnego.

**Alert porównuje cenę katalogową, nie koszt końcowy.** Progi pochodzą z cen
katalogowych, więc doliczanie dostawy cicho przesunęłoby każdy z nich o 100–200 zł.
Koszt końcowy (z dostawą i rabatem, gdy są znane) jest liczony i pokazywany w
dashboardzie oraz w treści alertu — ale to człowiek go ocenia, nie bot.

## Uruchomienie od zera

1. Załóż **publiczne** repo `gen-watch` na GitHubie.
2. Z katalogu z tymi plikami:
   ```
   git remote add origin https://github.com/<login>/gen-watch.git
   git push -u origin main
   ```
3. Settings → Pages → Source: **GitHub Actions**. Bez tego krok publikacji padnie.
4. Actions → gen-watch → **Run workflow**. Pierwszy przebieg zbuduje baseline.
5. Dashboard: `https://<login>.github.io/gen-watch/`

Bez sekretów działa kanał podstawowy: alert idzie przez Issue przypisane do
właściciela repo, a maila wysyła sam GitHub — dlatego nie ma tu hasła do skrzynki.

## Powiadomienia na Telegram

Drugi, niezależny kanał obok Issue. Wysyłka w jedną stronę — bot tylko wypycha
alerty, nie czyta Twoich wiadomości. Alert cenowy i sygnał o zepsutych źródłach
lecą jako osobne wiadomości. Ten sam sygnał „degraded" nie powtarza się częściej
niż raz na `realertAfterHours` (24 h); dopiero zmiana zestawu zepsutych źródeł
jest nową wiadomością.

Konfiguracja:

1. @BotFather → `/newbot` → token. Napisz do bota dowolną wiadomość (inaczej nie
   może odezwać się pierwszy).
2. `chat_id`: `https://api.telegram.org/bot<TOKEN>/getUpdates`, pole
   `result[].message.chat.id`. W czacie prywatnym to Twoje numeryczne ID.
3. Repo → Settings → Secrets and variables → Actions → dodaj `TELEGRAM_BOT_TOKEN`
   i `TELEGRAM_CHAT_ID`.
4. Test: `node src/notify-telegram.mjs --test` wysyła sztywną wiadomość.

Brak sekretów = krok cicho się pomija. Nieudana wysyłka nie przewraca przebiegu —
Issue i historia zostają źródłem prawdy. Dla toru B ustaw te same wartości jako
zmienne środowiskowe na Windowsie (`setx TELEGRAM_BOT_TOKEN "…"`); tam Telegram
odzywa się tylko przy całkowitej porażce skanu.

## Zmiana progów i modeli

Wszystko siedzi w `config/products.json`. Po każdej zmianie:

```
npm run check
```

Testy pilnują, że próg jest niższy od ceny bazowej, że każdy model ma co najmniej
jedno źródło niebędące `best-effort` i że wszystkie URL-e są na https.

## Testy na zapisanym HTML

`test/fixtures/` trzyma prawdziwą stronę **każdego** źródła z `config/products.json`
(tor A i tor B), jako `<produkt>__<sklep>.html.gz` plus `<produkt>__<sklep>.json`. W JSON-ie
jest adres, data zapisu i oczekiwany wynik: status, cena, warstwa, liczba ofert. `npm run check`
przepuszcza każdą stronę przez pełny `scrapeSource`: dopasowanie produktu, warstwy ekstrakcji
i widełki. Wynik musi się zgadzać co do grosza. Źródło w konfiguracji bez zapisanej strony
to czerwony test. Te same testy chodzą na każdym PR (`.github/workflows/test.yml`).

**Czerwony test fixture'a** znaczy jedno z dwóch:

- zmieniłeś parser albo konfigurację źródła i zmienił się wynik na tej samej stronie.
  Sprawdź, czy to zamierzone;
- sklep przebudował stronę, a Ty odświeżyłeś fixture. Wtedy nowy `expect` trzeba porównać
  z ceną widoczną w sklepie.

**Odświeżenie po zmianie strony sklepu** (albo po dodaniu źródła):

```
node src\save-fixtures.mjs --track b                  # Ceneo, Amazon, Komputronik - z laptopa
node src\save-fixtures.mjs --track a --only tooles    # jeden sklep toru A
```

Tor A da się zapisać także z laptopa, poza stronami renderowanymi w Chromium (KupAgregat,
Alnar). Do nich potrzebne jest `npm install` i `npx playwright install chromium`. Skrypt
wypisuje wynik parsera dla każdej strony. **Przed commitem porównaj ceny z dashboardem** z
tego samego dnia, bo `expect` to wynik parsera w chwili zapisu, a nie niezależne źródło prawdy.

Strona pośrednia antybotu (Amazon „Kontynuuj zakupy”, Cloudflare „Cierpliwości…”,
„Proszę czekać…” u Profimarketu) kończy jako `blocked` z opisem, a nie jako `mismatch`.
Bot jej nie obchodzi.

Pierwsze zapisane strony od razu znalazły błąd w parserze Ceneo. Wiersze sklepów w HTML
nie zawierają najtańszej oferty, która jest tylko w JSON-LD porównywarki: 6 466,51 zamiast
6 819 z wierszy. Porównywarka dokłada teraz cenę z JSON-LD, gdy jest niższa niż wszystkie
wiersze.

## Skąd biorą się ceny

**Warstwa pewna** — bezpośrednie strony sklepów. Cena czytana warstwowo:
JSON-LD `Product/offers` → microdata `itemprop="price"` → `og:price:amount` →
regex z konfiguracji sklepu. Każda cena niesie ze sobą `method`, więc w raporcie
widać, na czym bot się oparł. Cena z warstwy tekstowej jest oznaczana jako
podejrzana.

**Warstwa atrybutów** — dla sklepów bez danych strukturalnych (Tooles, Lewor) cena
jest szukana w elementach z „price" w klasie, id albo `data-*`. To z definicji
zgadywanie, więc działa **wyłącznie w widełkach** wyliczonych z ceny bazowej
(0,45× – 2,5×). Bez nich pierwsza lepsza liczba na stronie — rata leasingu, koszt
dostawy — wyglądałaby jak okazja. Widełki obowiązują wszystkie warstwy, nie tylko tę.

Strony renderowane po stronie klienta (KupAgregat, Alnar) idą przez Chromium.
Zwykły `fetch` eskaluje do przeglądarki sam, gdy dostanie 403/406/429 albo pusty
szkielet.

**Czego tu nie ma, a było w planie:** `e-katalog.pl`, Ceneo, Amazon i Komputronik.
Pierwszy przebieg na Actions pokazał, że wszystkie cztery oddają runnerowi w Azure
stronę „Cierpliwości… Przeprowadzanie weryfikacji zabezpieczeń" — również przez
Chromium. Ceneo, Amazon i Komputronik przeszły do toru B1 (skan lokalny z domowego
łącza). e-katalog odrzuca także łącze domowe (403) i wypadł całkiem. To boli najbardziej przy
e-katalogu, bo był zaplanowany jako główna warstwa zwiadu.

## Czego ten bot NIE robi

- **Sam nie chodzi na Allegro, OLX ani Allegro Lokalnie.** Te serwisy blokują adresy
  IP centrów danych, a runnery GitHuba stoją w Azure. Obsługuje je osobny tor przez
  przeglądarkę na maszynie użytkownika, a wyniki wracają tu przez Issue —
  patrz `BROWSER-SCAN.md`.
- **Nie czyta specyfikacji ze sklepów.** Sklepowe parametry rozjeżdżają się z
  danymi producenta. Ze sklepów bierzemy wyłącznie cenę i dostępność; specyfikacja
  pochodzi z `konner-sohnen.pl` i `fogo.pl`, a link do niej jest przy każdym modelu.
- **Nie ocenia, czy warto kupić.** Podaje cenę, koszt końcowy i historię. Decyzja
  jest po stronie człowieka.

## Trzy tory, jedno miejsce

| | Tor A — sklepy | Tor B1 — skan lokalny | Tor B2 — rynek wtórny |
|---|---|---|---|
| Gdzie działa | GitHub Actions, co 3 h | skrypt Node na Windowsie | Chrome na laptopie, na żądanie |
| Co obejmuje | sklepy bezpośrednio | Ceneo, Amazon, Komputronik | Allegro, OLX, Allegro Lokalnie |
| Potrzebuje laptopa | nie | tak (włączonego) | tak (z sesją Claude) |
| Potrzebuje przeglądarki | nie | **nie** | tak |
| Zapis do repo | bezpośrednio | bezpośrednio, poświadczeniami gita | przez Issue `GEN_Scan` |
| Wyzwalacze alertu | wszystkie trzy | tylko próg sztywny | tylko próg sztywny |
| Mail (Issue `GEN_Alert`) | od razu | przy najbliższym przebiegu toru A | komentarz w Issue `GEN_Scan` |
| Gdzie ląduje | `docs/data/history/` | `docs/data/market/` | `docs/data/market/` |

Podział na B1 i B2 powstał po awarii 24.08.2026: zaplanowane zadanie w chmurze nie ma
dostępu ani do Chrome'a, ani do lokalnych serwerów MCP, więc tor przeglądarkowy nie
mógł działać bez nadzoru. Okazało się przy tym, że **e-katalog i Ceneo nie potrzebują
przeglądarki — potrzebują adresu IP z domowego łącza.** Stąd B1: te same parsery,
uruchamiane lokalnie, bez modelu i bez przeglądarki.

Allegro i OLX zostają w B2 na żądanie, bo tam i tak potrzebna jest ocena człowieka —
motogodziny, rok, stan. Skrypt tego nie rozstrzygnie.

## Tor B na Windows — uruchomienie

Tor B1 to `skan-lokalny.bat` uruchamiany przez Harmonogram zadań. Sprawdza Ceneo, Amazon
i Komputronik z domowego łącza i zapisuje wynik na gałęzi `data`. Całość, od zera do
działającego zadania, to trzy kroki.

### Wymagania (raz)

- **Node 20+** (nodejs.org, wersja LTS) i **Git for Windows**. Sprawdzenie: `node -v`,
  `git --version`.
- Repo sklonowane na dysk. Dalej przykładowa ścieżka:
  `%USERPROFILE%\Documents\CLAUDE cowork\AGREGATY\gen-watch`.
- Git zalogowany do GitHuba. Pierwszy `git pull` albo `git push` otwiera okno Git
  Credential Manager; po zalogowaniu poświadczenia zostają w Menedżerze poświadczeń Windows.
- `npm install` **nie jest potrzebny**: tor B nie używa przeglądarki.

### 1. Kod z GitHuba i test bez zapisu

W zwykłym wierszu poleceń (cmd):

```
cd /d "%USERPROFILE%\Documents\CLAUDE cowork\AGREGATY\gen-watch"
git checkout main
git pull
node src\scan-local.mjs --dry
```

`--dry` nie dotyka gita, sprawdza tylko, czy sklepy odpowiadają. Jeśli w powodach
zobaczysz „Cierpliwości” albo „weryfikacja zabezpieczeń”, ochrona antybotowa odrzuca
także łącze domowe. Wtedy ten tor nie ma sensu i zostaje tor B2 (przeglądarka).

### 2. Zadanie w Harmonogramie — jednym poleceniem

Z katalogu repo, w zwykłym (nie administratorskim) PowerShellu:

```
powershell -ExecutionPolicy Bypass -File scripts\zainstaluj-harmonogram.ps1
```

Skrypt zakłada zadanie „gen-watch skan lokalny” (7:00 i 18:00, inne godziny:
`-Godziny "06:30,19:00"`) z ustawieniami, które wcześniej trzeba było pamiętać, a
które po cichu zatrzymują skan na laptopie:

- **start także na baterii**, bo domyślnie Windows pomija zadanie bez zasilacza;
- **nadrabianie przegapionego przebiegu** po wybudzeniu laptopa;
- **logowanie interaktywne**: zadanie chodzi, gdy jesteś zalogowany (także przy
  zablokowanym ekranie). Wcześniej README zalecało „Uruchom niezależnie od tego, czy
  użytkownik jest zalogowany”. Bez zapisanego hasła to tryb S4U, w którym zadanie **nie
  widzi poświadczeń gita** i push na `data` pada.

Jeśli masz już zadanie założone ręcznie, skrypt je pokaże i poda polecenie do
usunięcia. Dwa zadania to dwa równoległe skany. Na końcu skrypt uruchamia diagnostykę.

Pierwszy przebieg od razu, bez czekania do 7:00:

```
Start-ScheduledTask -TaskName "gen-watch skan lokalny"
```

Wynik po minucie jest w `skan-lokalny.log`, a na gałęzi `data` pojawia się
`docs/data/local-status.json`.

### 3. Co robi każdy przebieg

- **`git pull --ff-only` na `main`**, więc poprawki z GitHuba trafiają na laptopa same.
  Gdy pull się nie uda (lokalne zmiany albo lokalne commity), skan rusza na dotychczasowym
  kodzie, a w logu jest „UWAGA: git pull sie nie udal”;
- klonuje gałąź `data` do `.local-data/` — **drzewo robocze zostaje nietknięte**;
- czyta ceny tymi samymi warstwami co tor A, z tymi samymi widełkami;
- dopisuje oferty do `docs/data/market/` i wypycha na gałąź `data`;
- **przy każdym przebiegu, także nieudanym**, zapisuje puls `docs/data/local-status.json`
  (kiedy, ile źródeł oddało cenę, kiedy ostatni udany skan);
- gdy push zostanie odrzucony, bo tor A w międzyczasie zrobił force-push, ponawia go raz
  na świeżym stanie gałęzi;
- loguje wszystko do `skan-lokalny.log` (start, koniec i kod wyjścia każdego
  przebiegu). Powyżej 1 MB log przechodzi do `skan-lokalny.poprzedni.log`.

Kod wyjścia 1 w Harmonogramie oznacza, że skan nie zebrał ani jednej ceny albo push
się nie udał. Szczegóły są w logu.

### Gdy coś nie działa: `--doctor`

```
node src\scan-local.mjs --doctor
```

Sprawdza po kolei: wersję Node, gałąź i lokalne zmiany, zgodność z GitHubem (lokalne
commity na `main`), odczyt i zapis do repo (`git push --dry-run`, niczego nie tworzy),
wiek pulsu na gałęzi `data`, zmienne Telegrama, zadanie w Harmonogramie (bateria,
nadrabianie, tryb logowania, ostatni wynik) i koniec logu. Każdy problem ma podpowiedź.

| Doctor mówi | Co zrobić |
|---|---|
| lokalne commity na main, których nie ma na GitHubie | `git push origin main:<nazwa-gałęzi>`, potem `git reset --hard origin/main` |
| push odrzucony | `git push` z katalogu repo i zalogowanie się w oknie Git Credential Manager |
| logowanie S4U / nie startuje na baterii / brak nadrabiania | ponownie `scripts\zainstaluj-harmonogram.ps1` |
| brak zadania uruchamiającego skan-lokalny.bat | `scripts\zainstaluj-harmonogram.ps1` |
| puls: bez ani jednej ceny | ochrona antybotowa albo zmiana stron sklepów, szczegóły w `skan-lokalny.log` |

Telegram dla toru B: `setx TELEGRAM_BOT_TOKEN "…"` i `setx TELEGRAM_CHAT_ID "…"`, potem
wyloguj się i zaloguj ponownie, żeby zadanie widziało nowe zmienne.

### Puls toru B — kto zauważy, że tor B stanął

Tor A przy każdym przebiegu czyta `local-status.json`. Jeśli od ostatniego **udanego**
skanu toru B minęło więcej niż `alertRules.localStaleHours` (36 h, czyli trzy opuszczone
przebiegi), to:

- dashboard pokazuje pod nagłówkiem linię „tor B: …” z ostrzeżeniem;
- podsumowanie przebiegu Actions ma sekcję „Tor B (skan lokalny) — CISZA”;
- Telegram wysyła „tor B milczy” (najwyżej raz na 24 h dla tej samej ciszy).

Cisza obejmuje oba przypadki: wyłączony laptop albo zepsuty git (brak nowego pulsu) oraz
blokadę antybotową (puls jest, ale bez ani jednej ceny). Przed wdrożeniem pulsu tor B
milczał od 26.08.2026 i nikt tego nie zauważył.

### Wspólna gałąź `data`

Tor A i ingest wypychają `data` z `--force`. Żeby nie skasować tego, co tor B dopisał w
trakcie ich przebiegu, tuż przed dashboardem i force-pushem pobierają świeży stan gałęzi
i scalają pliki pisane z zewnątrz (`src/datasync.mjs`): `market/*.json` (unia skanów),
`state.json` (późniejszy znacznik per klucz), `local-status.json` (nowszy wygrywa).
Historia cen toru A nie jest przy tym ruszana.

Dashboard na Pages odświeży się przy najbliższym przebiegu Actions, czyli w ciągu
trzech godzin — skrypt lokalny celowo nie dotyka publikacji.

## Termin zakupu

`config/products.json` ma pole `meta.deadline`. Dashboard liczy od niego pozostałe
dni i przy każdym modelu pokazuje **najniższą cenę w całej obserwacji**. Przy zakupie
z terminem to jest ważniejsza liczba niż próg: mówi, czy dzisiejsza cena jest
najlepsza, jaką widzieliśmy, czy tylko przeciętna. Może się zdarzyć, że przez cały
okres obserwacji nie padnie ani jeden alert — wtedy decyzją jest „kupuję po
najlepszej cenie, jaką widziałem", a nie „czekam dalej".

## Diagnostyka

`status: degraded` znaczy „padło źródło, na którym polegamy" — awaria źródła
`best-effort` do tego nie wystarcza. `status: error` znaczy „któryś model nie ma
w ogóle ceny" i kończy przebieg kodem 1.

Zero ofert przy statusie `ok` to poprawny wynik („sprawdzone, nie ma"). Zero ofert
przy statusie `blocked` znaczy „nie wiemy". Zlanie tych dwóch przypadków w jedno
było najczęstszym błędem w `role-watch` i tutaj są rozdzielone.

Podgląd bez zapisu:

```
npm run dry
```

Jeden model:

```
npm run scan:one -- ks-8100ieg
```
