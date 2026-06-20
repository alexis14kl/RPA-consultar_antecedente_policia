taskkill /f /im chrome.exe /t 2>$null
Start-Sleep -Seconds 2
Remove-Item "$env:LOCALAPPDATA\Google\Chrome\User Data\Profile 1\LOCK" -Force -EA SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\Google\Chrome\User Data\lockfile" -Force -EA SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\LOCK" -Force -EA SilentlyContinue

# Borrar sesion anterior (formato viejo Y nuevo Chrome v124+) para no restaurar tabs de Buster
Remove-Item "$env:LOCALAPPDATA\Google\Chrome\User Data\Profile 1\Current Session" -Force -EA SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\Google\Chrome\User Data\Profile 1\Current Tabs" -Force -EA SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\Google\Chrome\User Data\Profile 1\Last Session" -Force -EA SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\Google\Chrome\User Data\Profile 1\Last Tabs" -Force -EA SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\Google\Chrome\User Data\Profile 1\Sessions\*" -Force -EA SilentlyContinue

Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList @(
    "--remote-debugging-port=9223",
    "--remote-allow-origins=*",
    "--user-data-dir=$env:LOCALAPPDATA\Google\Chrome\User Data",
    "--profile-directory=Profile 1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml"
) -WindowStyle Normal

Write-Host "Chrome lanzado. Esperando CDP..."
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        Invoke-WebRequest http://127.0.0.1:9223/json/version -UseBasicParsing -TimeoutSec 1 | Out-Null
        Write-Host "CDP ACTIVO en $($i+1)s"
        $ok = $true
        break
    } catch {}
}
if (-not $ok) { Write-Host "ERROR: CDP no respondio"; exit 1 }
exit 0
