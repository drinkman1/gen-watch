# Tor B — skan przez przeglądarkę (Allegro, OLX, Ceneo)

Instrukcja dla sesji Cowork uruchamianej harmonogramem. Ten plik jest kontraktem:
sesja czyta go i wykonuje krok po kroku, zamiast improwizować.

## Dlaczego osobny tor

Allegro, OLX i Ceneo blokują adresy IP centrów danych. Runnery GitHub Actions stoją
w Azure, więc główny bot się od nich odbija. Chrome na maszynie użytkownika ma czysty
adres i zalogowaną sesję — i to jedyny powód, dla którego ten tor istnieje.

Pora dnia nie ma na to wpływu — te serwisy nie limitują ruchu zegarem, tylko
reputacją adresu i odciskiem przeglądarki. Godziny 7:00 i 18:00 wybrano dlatego, że
Chrome otwiera zakładki na ekranie użytkownika i nie ma tego robić w środku pracy.

## Warunki wstępne

- Laptop włączony, aplikacja Claude uruchomiona. Gdy jej nie ma, przebieg po prostu
  nie wystartuje — i to jest akceptowana dziura, nie awaria do naprawiania.
- W rozszerzeniu Chrome nadane uprawnienia dla `allegro.pl`, `olx.pl`, `ceneo.pl`.
  Bez nich przeglądarka odmówi i tor nie ruszy ani razu.

## Co sprawdzić

Progi i modele bierz z `config/products.json` w tym repo (publiczne, więc czytaj
surowy plik z `raw.githubusercontent.com`). Nie przepisuj ich do promptu — rozjadą
się przy pierwszej zmianie.

Dla każdego z pięciu modeli:

| Serwis | Czego szukać |
|---|---|
| Allegro | po EAN dla trzech modeli K&S; po nazwie dla dwóch Fogo |
| OLX | po nazwie modelu, promień **100 km od Grodziska Mazowieckiego** |
| Allegro Lokalnie | jak OLX |
| Ceneo | strona produktu, lista sklepów |

## Reguły oceny

1. **Używane wymaga oceny człowieka.** Bot z toru A porównuje ceny nowych sztuk
   do progu i tyle. Przy ofercie z drugiej ręki zawsze zapisz motogodziny, rok,
   stan i to, czy sprzedający pokazuje agregat pod obciążeniem. Cena sama w sobie
   nic tu nie znaczy — agregat po 800 mth za pół ceny nie jest okazją.
2. **Odrzucaj oferty z „uszkodzony", „na części", „nie odpala".** Wyszukiwarka OLX
   nie filtruje tego sama.
3. **Litery w nazwie to filtr techniczny**, nie ozdoba: `i` = inwerter,
   brak `i` = AVR (odrzuć), `G` = dual fuel LPG, `ATSR` = gniazdo automatyki,
   `1/3` = przełączalny 1/3 fazy, `KSB` = linia budżetowa Basic, `HD` = diesel z AVR.
   Sklepy i sprzedający notorycznie przekręcają zapis — „KS 8100iE G" to KS 8100iEG.
4. **Specyfikacja tylko od producenta.** Z ogłoszenia bierz cenę, stan i lokalizację.

## Co zrobić z wynikiem — Issue jako skrzynka podawcza

Wyniki wracają do repo przez **Issue**, nie przez token. Sesja Cowork nie ma i nie
potrzebuje żadnych poświadczeń: zapis wykonuje workflow `ingest`, który żyje
kilkanaście sekund i znika. Autoryzacją jest zalogowana sesja GitHuba w Chrome —
ta sama przeglądarka, która i tak robi skan.

1. Zbuduj ładunek. Dokładnie ten kształt, inaczej workflow odrzuci zgłoszenie:

   ~~~
   ```json
   {
     "scan": "2026-08-24T05:00:00Z",
     "offers": [
       {
         "productId": "ks-8100ieg",
         "site": "olx",
         "price": 4200,
         "condition": "used",
         "url": "https://www.olx.pl/oferta/...",
         "location": "Żyrardów",
         "distanceKm": 22,
         "note": "350 mth, faktura, odpalany przy mnie"
       }
     ]
   }
   ```
   ~~~

   `productId` musi pochodzić z `config/products.json`. `site`: `olx`,
   `allegro`, `allegro-lokalnie`, `ceneo` albo `inne`. `condition`: `new`,
   `used`, `unknown` — `damaged` jest przyjmowane i celowo pomijane przy zapisie.

2. Otwórz w Chrome adres z wypełnionym formularzem (title, body i etykieta w
   parametrach zapytania), sprawdź podgląd i kliknij **Submit new issue**:

   ```
   https://github.com/drinkman1/gen-watch/issues/new?labels=GEN_Scan&title=Skan+przegladarkowy&body=<ładunek zakodowany URL-em>
   ```

   Etykieta `GEN_Scan` jest obowiązkowa — bez niej workflow nie ruszy. Jeśli
   ładunek nie mieści się w adresie, załóż puste Issue z etykietą i wklej blok
   w treści; `edited` też wyzwala przebieg.

3. Workflow odpowie komentarzem: ile ofert przyjął, co odrzucił i dlaczego, oraz
   które schodzą poniżej progu. Przy udanym imporcie sam zamyka zgłoszenie.
   Przeczytaj ten komentarz — jest jedynym potwierdzeniem, że dane doszły.

4. Niezależnie od Issue: jeśli coś schodzi poniżej progu, napisz o tym w rozmowie
   i wyślij maila. Nie każ użytkownikowi czekać na przebieg Actions.

5. Jeśli nic nie schodzi poniżej progu — jedno zdanie i koniec. Bez raportu.

## Dlaczego oferty z drugiej ręki nie wchodzą do historii cen

Rynek wtórny jest trzymany osobno, w `docs/data/market/`, i pokazywany jako osobna
tabela pod wykresem. Powód jest praktyczny: używany egzemplarz za 3 000 zł
wywróciłby medianę i minimum historyczne, a potem każdy nowy agregat wyglądałby na
absurdalnie drogi i wyzwalacze przestałyby cokolwiek znaczyć.

Z tego samego powodu przy rynku wtórnym działa **wyłącznie próg sztywny**. Mediana
z trzech ogłoszeń na kwartał to nie jest statystyka, tylko przypadek.

## Bezpieczeństwo

Repo jest publiczne, więc Issue może założyć każdy. Workflow przetwarza wyłącznie
zgłoszenia, których autorem jest właściciel repo, i tylko z etykietą `GEN_Scan` —
reszta kończy się natychmiast, bez czytania treści. Sama treść jest danymi: idzie
przez `JSON.parse`, jest walidowana pole po polu i nigdy nie trafia do polecenia
powłoki ani do `eval`. Adresy inne niż `https://` są odrzucane, bo ta treść ląduje
później w HTML dashboardu.
