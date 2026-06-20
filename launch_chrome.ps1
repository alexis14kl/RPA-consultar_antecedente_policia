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

# Corregir exit_type=Crashed en Preferences — Chrome restaura tabs aunque no haya session files
$prefsPath = "$env:LOCALAPPDATA\Google\Chrome\User Data\Profile 1\Preferences"
if (Test-Path $prefsPath) {
    $prefs = Get-Content $prefsPath -Raw | ConvertFrom-Json
    $prefs.profile | Add-Member -Force -MemberType NoteProperty -Name "exit_type"     -Value "Normal"
    $prefs.profile | Add-Member -Force -MemberType NoteProperty -Name "exited_cleanly" -Value $true
    if (-not $prefs.session) { $prefs | Add-Member -Force -MemberType NoteProperty -Name "session" -Value ([PSCustomObject]@{}) }
    $prefs.session | Add-Member -Force -MemberType NoteProperty -Name "restore_on_startup" -Value 1
    $prefs | ConvertTo-Json -Depth 100 -Compress | Set-Content $prefsPath -Encoding UTF8
    Write-Host "Preferences: exit_type=Normal, restore_on_startup=1"
}

Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList @(
    "--remote-debugging-port=9223",
    "--remote-allow-origins=*",
    "--user-data-dir=$env:LOCALAPPDATA\Google\Chrome\User Data",
    "--profile-directory=Profile 1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--window-position=-2000,0",
    "--window-size=1280,800",
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
