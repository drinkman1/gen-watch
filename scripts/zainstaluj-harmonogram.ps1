# Zaklada zadanie Harmonogramu zadan Windows dla toru B (skan lokalny).
#
# Uruchomienie z katalogu repo, w zwyklym (nie administratorskim) PowerShellu:
#
#   powershell -ExecutionPolicy Bypass -File scripts\zainstaluj-harmonogram.ps1
#
# Opcje:
#   -Godziny "07:00,18:00"   pory skanu (domyslnie 7:00 i 18:00)
#   -Nazwa "gen-watch skan lokalny"
#
# Ustawienia, ktore wczesniej trzeba bylo pamietac w oknie Harmonogramu, a
# ktore po cichu zatrzymuja skan na laptopie:
#   - start takze na baterii (domyslnie Windows pomija zadanie bez zasilacza),
#   - "uruchom jak najszybciej po przegapieniu" (uspiony laptop o 7:00),
#   - logowanie interaktywne: zadanie widzi poswiadczenia gita z Menedzera
#     poswiadczen. Tryb "niezaleznie od zalogowania" bez zapisanego hasla (S4U)
#     ich nie widzi i push na galaz data pada.
# Skrypt mozna uruchamiac wielokrotnie - zadanie o tej samej nazwie jest
# nadpisywane.

param(
  [string]$Godziny = "07:00,18:00",
  [string]$Nazwa = "gen-watch skan lokalny"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$bat = Join-Path $repo "skan-lokalny.bat"

Write-Host "Repo: $repo"
if (-not (Test-Path $bat)) { throw "Nie ma $bat - uruchom skrypt z katalogu repo gen-watch." }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Nie widze node w PATH. Zainstaluj Node 20+ (nodejs.org, wersja LTS) i otworz PowerShell ponownie." }
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) { throw "Nie widze git w PATH. Zainstaluj Git for Windows i otworz PowerShell ponownie." }
Write-Host "Node: $($node.Source)"
Write-Host "Git:  $($git.Source)"

# Inne zadania uruchamiajace ten sam skan - dwa zadania to dwa rownolegle
# pushe na data. Nie kasujemy ich sami, tylko pokazujemy.
$inne = Get-ScheduledTask | Where-Object {
  $_.TaskName -ne $Nazwa -and
  ((($_.Actions | ForEach-Object { [string]$_.Execute + ' ' + [string]$_.Arguments }) -join ' ') -match 'skan-lokalny')
}
foreach ($t in $inne) {
  Write-Warning "Istnieje juz zadanie '$($t.TaskPath)$($t.TaskName)', ktore uruchamia skan. Usun je w Harmonogramie zadan albo poleceniem:"
  Write-Warning "  Unregister-ScheduledTask -TaskName '$($t.TaskName)' -TaskPath '$($t.TaskPath)'"
}

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$bat`"" -WorkingDirectory $repo
$triggers = @()
foreach ($g in $Godziny.Split(",")) {
  $triggers += New-ScheduledTaskTrigger -Daily -At $g.Trim()
}
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $Nazwa -Action $action -Trigger $triggers -Settings $settings `
  -Principal $principal -Description "gen-watch: tor B, skan lokalny cen agregatow" -Force | Out-Null
Write-Host ""
Write-Host "Zadanie '$Nazwa' zapisane: codziennie o $Godziny, takze na baterii, z nadrabianiem przegapionych."
Write-Host ""

Push-Location $repo
try {
  Write-Host "Diagnostyka:"
  & $node.Source "src\scan-local.mjs" "--doctor"
  Write-Host ""
  Write-Host "Pierwszy skan od razu (wynik w skan-lokalny.log):"
  Write-Host "  Start-ScheduledTask -TaskName '$Nazwa'"
} finally {
  Pop-Location
}
