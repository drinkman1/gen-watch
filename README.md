# gen-watch

Monitoring cen pięciu agregatów prądotwórczych. Skan co 3 godziny na GitHub Actions,
alert przez Issue (GitHub wysyła za nie maila), dashboard z historią cen na GitHub Pages.

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

Żadnych sekretów. Powiadomienia idą przez Issue przypisane do właściciela repo,
a maila wysyła sam GitHub — dlatego nie ma tu hasła do skrzynki.

## Zmiana progów i modeli

Wszystko siedzi w `config/products.json`. Po każdej zmianie:

```
npm run check
```

Testy pilnują, że próg jest niższy od ceny bazowej, że każdy model ma co najmniej
jedno źródło niebędące `best-effort` i że wszystkie URL-e są na https.

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
Chromium. Przeniesione do toru przeglądarkowego. To boli najbardziej przy
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

## Dwa tory, jedno miejsce

| | Tor A — sklepy | Tor B — rynek wtórny |
|---|---|---|
| Gdzie działa | GitHub Actions, co 3 h | Chrome na laptopie, 7:00 i 18:00 |
| Co obejmuje | sklepy bezpośrednio | Allegro, OLX, Allegro Lokalnie, e-katalog, Ceneo, Amazon, Komputronik |
| Niezależny od laptopa | tak | nie |
| Zapis do repo | bezpośrednio | przez Issue z etykietą `GEN_Scan` |
| Wyzwalacze alertu | wszystkie trzy | tylko próg sztywny |
| Gdzie ląduje | `docs/data/history/` | `docs/data/market/` |

Żaden z torów nie wymaga sekretu. Tor A pisze `GITHUB_TOKEN`-em przebiegu, tor B —
przez workflow `ingest`, wyzwalany zgłoszeniem założonym z zalogowanej przeglądarki.

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
