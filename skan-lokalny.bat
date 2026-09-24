@echo off
REM Skan lokalny gen-watch (tor B). Uruchamiany przez Harmonogram zadan -
REM zadanie zaklada scripts\zainstaluj-harmonogram.ps1.
REM
REM Katalog jest ustalany wzgledem polozenia tego pliku, wiec .bat mozna
REM przeniesc razem z repo bez edycji sciezek.
REM
REM Przed skanem git pull na main: poprawki z GitHuba trafiaja tu same, bez
REM pamietania o recznym pullu. Gdy pull sie nie uda (lokalne zmiany, lokalne
REM commity, brak sieci), skan i tak rusza na dotychczasowym kodzie, a w logu
REM zostaje ostrzezenie. Diagnostyka: node src\scan-local.mjs --doctor
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set "LOG=skan-lokalny.log"

REM Rotacja: powyzej 1 MB biezacy log staje sie poprzednim.
if exist "%LOG%" for %%I in ("%LOG%") do if %%~zI GTR 1048576 move /y "%LOG%" "skan-lokalny.poprzedni.log" >nul

set "BR="
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BR=%%b"

REM Wszystko od git pull do konca w JEDNYM bloku. cmd.exe czyta plik .bat
REM kawalkami w trakcie wykonania, wiec gdyby pull podmienil ten plik, reszta
REM wykonalaby sie od zlego miejsca. Blok w nawiasach jest parsowany w calosci
REM przed startem - stad tez !zmienne! zamiast %zmienne% ponizej.
(
  >>"%LOG%" echo.
  >>"%LOG%" echo ===== start !date! !time! =====
  if /i "!BR!"=="main" (
    git pull --ff-only --quiet >>"%LOG%" 2>&1 || >>"%LOG%" echo UWAGA: git pull sie nie udal - skan idzie na dotychczasowym kodzie. Sprawdz: node src\scan-local.mjs --doctor
  ) else (
    >>"%LOG%" echo UWAGA: galaz "!BR!" zamiast main - pomijam git pull. Sprawdz: node src\scan-local.mjs --doctor
  )
  node src\scan-local.mjs >>"%LOG%" 2>&1
  set "RC=!ERRORLEVEL!"
  >>"%LOG%" echo ===== koniec !date! !time!, kod !RC! =====
  exit /b !RC!
)
