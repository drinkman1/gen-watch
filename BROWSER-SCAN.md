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

## Co zrobić z wynikiem

1. Dopisz przebieg do `AGREGATY/browser-scans/<data>.json` w podłączonym folderze.
   Ten plik NIE trafia do repo — patrz ograniczenie niżej.
2. Jeśli któraś oferta schodzi poniżej progu z `config/products.json`: wyślij maila
   i napisz w rozmowie. Podaj cenę, lokalizację, dystans od Grodziska i to, czego
   w ogłoszeniu brakuje.
3. Jeśli nic nie schodzi poniżej progu: jedno zdanie i koniec. Bez raportu.

## Ograniczenie, o którym trzeba pamiętać

Wyniki tego toru **nie trafiają na dashboard**. Sesja Cowork nie ma poświadczeń do
zapisu w repo, a dashboard buduje się na GitHub Actions z danych, które tam leżą.
Historia cen na dashboardzie pokazuje więc wyłącznie sklepy z toru A.

Żeby to zmienić, trzeba by wpuścić do sesji token GitHuba o wąskim zakresie. To
jedna dodatkowa ruchoma część i jeden sekret na dysku — dlatego domyślnie tego nie
robimy, a nie dlatego, że się nie da.
