@echo off
REM Skan lokalny gen-watch. Podpiac pod Harmonogram zadan Windows.
REM Katalog jest ustalany wzgledem polozenia tego pliku, wiec .bat mozna
REM przeniesc razem z repo bez edycji sciezek.
cd /d "%~dp0"
node src\scan-local.mjs >> skan-lokalny.log 2>&1
