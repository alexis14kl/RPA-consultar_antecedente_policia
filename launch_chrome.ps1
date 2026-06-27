# Lanzador Windows — alineado con launch_chrome.sh (Mac) y launch_chrome_linux.sh.
# Usa Chrome for Testing (o Chromium de Playwright) con --load-extension para cargar
# Buster desde buster-ext/, igual que Mac y Linux.
#
# IMPORTANTE: Chrome stable (>=137) ignora --load-extension.
# Por eso se detecta Chrome for Testing o el Chromium de Playwright.
# Si no se encuentra, cae a Chrome stable (Buster debe estar instalado en el perfil).

$CDP_PORT  = 9223
$URL       = "https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml"
$SCRIPT_DIR = $PSScriptRoot
$USER_DATA  = "$SCRIPT_DIR\chrome-cdp-profile"
$EXT_DIR    = "$SCRIPT_DIR\buster-ext"

# ── Detectar Chrome for Testing o Chromium de Playwright ──────────────────
function Find-Chromium {
    # Chrome for Testing (descargado manualmente o con npx @puppeteer/browsers)
    $cands = @(
        "$SCRIPT_DIR\chrome-win64\chrome.exe",
        "$SCRIPT_DIR\chrome-win\chrome.exe",
        "$env:LOCALAPPDATA\ms-playwright\chromium-*\chrome-win\chrome.exe"
    )
    foreach ($pattern in $cands) {
        $found = Get-Item $pattern -EA SilentlyContinue | Sort-Object Name | Select-Object -Last 1
        if ($found) { return $found.FullName }
    }
    # Playwright cache
    $pwBase = "$env:LOCALAPPDATA\ms-playwright"
    if (Test-Path $pwBase) {
        $pwChrome = Get-ChildItem "$pwBase\chromium-*\chrome-win\chrome.exe" -EA SilentlyContinue |
                    Sort-Object FullName | Select-Object -Last 1
        if ($pwChrome) { return $pwChrome.FullName }
    }
    # Fallback: Chrome stable (no soporta --load-extension desde v137)
    $stable = "C:\Program Files\Google\Chrome\Application\chrome.exe"
    if (Test-Path $stable) { return $stable }
    return $null
}

$CHROME = Find-Chromium
if (-not $CHROME) {
    Write-Host "ERROR: No se encontro Chrome for Testing ni Chrome stable."
    Write-Host "  Instala con:  npx playwright install chromium"
    Write-Host "            o:  npx @puppeteer/browsers install chrome@stable"
    exit 1
}
Write-Host "Chromium: $CHROME"

# ── Limpiar procesos y locks anteriores ───────────────────────────────────
Write-Host "[1] Limpiando procesos..."
Get-Process | Where-Object { $_.MainWindowTitle -eq "" -and $_.ProcessName -match "chrome" } |
    Stop-Process -Force -EA SilentlyContinue
Start-Sleep -Seconds 2
Remove-Item "$USER_DATA\Singleton*" -Force -EA SilentlyContinue

# ── Preparar perfil dedicado ───────────────────────────────────────────────
Write-Host "[2] Preparando perfil..."
New-Item -ItemType Directory -Force -Path $USER_DATA | Out-Null

if (-not (Test-Path $EXT_DIR)) {
    Write-Host "ERROR: No se encontro buster-ext en: $EXT_DIR"
    exit 1
}

# ── Lanzar Chromium ───────────────────────────────────────────────────────
Write-Host "[3] Lanzando Chromium con Buster (--load-extension)..."
$args = @(
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$CDP_PORT",
    "--remote-allow-origins=*",
    "--user-data-dir=$USER_DATA",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-web-security",
    "--ignore-certificate-errors",
    "--disable-features=SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure,IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests,PrivacySandboxSettings4",
    "--disable-extensions-except=$EXT_DIR",
    "--load-extension=$EXT_DIR",
    "--window-position=-2000,0",
    "--window-size=1280,800",
    $URL
)
Start-Process $CHROME -ArgumentList $args -WindowStyle Normal

# ── Esperar CDP ───────────────────────────────────────────────────────────
Write-Host "[4] Esperando CDP..."
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    try {
        Invoke-WebRequest "http://127.0.0.1:$CDP_PORT/json/version" -UseBasicParsing -TimeoutSec 1 | Out-Null
        Write-Host "CDP ACTIVO en $($i+1)s"
        $ok = $true
        break
    } catch {}
}
if (-not $ok) { Write-Host "ERROR: CDP no levanto"; exit 1 }
exit 0
