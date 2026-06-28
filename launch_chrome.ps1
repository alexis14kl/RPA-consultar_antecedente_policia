# Lanzador Windows — alineado con launch_chrome.sh (Mac) y launch_chrome_linux.sh.
#
# Modo A — Chrome for Testing / Chromium de Playwright:
#   Usa --load-extension=buster-ext/ y perfil dedicado chrome-cdp-profile/
#
# Modo B — Chrome stable (fallback):
#   Chrome stable ignora --load-extension desde v137.
#   Usa Profile 1 donde Buster ya debe estar instalado como extensión normal.

$CDP_PORT   = 9223
$URL        = "https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml"
$SCRIPT_DIR = $PSScriptRoot
$EXT_DIR    = "$SCRIPT_DIR\buster-ext"

# ── Detectar Chrome for Testing o Chromium de Playwright ──────────────────
function Find-ChromiumForTesting {
    $cands = @(
        "$SCRIPT_DIR\chrome-win64\chrome.exe",
        "$SCRIPT_DIR\chrome-win\chrome.exe"
    )
    foreach ($p in $cands) {
        if (Test-Path $p) { return $p }
    }
    $pwBase = "$env:LOCALAPPDATA\ms-playwright"
    if (Test-Path $pwBase) {
        $found = Get-ChildItem "$pwBase\chromium-*\chrome-win\chrome.exe" -EA SilentlyContinue |
                 Sort-Object FullName | Select-Object -Last 1
        if ($found) { return $found.FullName }
    }
    return $null
}

$CHROME_FT = Find-ChromiumForTesting
$CHROME_STABLE = "C:\Program Files\Google\Chrome\Application\chrome.exe"

if ($CHROME_FT) {
    $CHROME    = $CHROME_FT
    $USER_DATA = "$SCRIPT_DIR\chrome-cdp-profile"
    $USE_EXT   = $true
    Write-Host "Modo A — Chrome for Testing: $CHROME"
} elseif (Test-Path $CHROME_STABLE) {
    $CHROME    = $CHROME_STABLE
    $USER_DATA = "$env:LOCALAPPDATA\Google\Chrome\User Data"
    $PROFILE   = "Profile 1"
    $USE_EXT   = $false
    Write-Host "Modo B — Chrome stable (Buster debe estar instalado en Profile 1): $CHROME"
    Write-Host "  Para usar --load-extension instala Chrome for Testing:"
    Write-Host "    npx playwright install chromium"
} else {
    Write-Host "ERROR: No se encontro Chrome for Testing ni Chrome stable."
    Write-Host "  Instala con:  npx playwright install chromium"
    exit 1
}

# ── Limpiar procesos y locks ───────────────────────────────────────────────
Write-Host "[1] Limpiando procesos..."
Get-Process chrome -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Start-Sleep -Seconds 2
Remove-Item "$USER_DATA\Singleton*" -Force -EA SilentlyContinue

# ── Preparar perfil ────────────────────────────────────────────────────────
Write-Host "[2] Preparando perfil..."
New-Item -ItemType Directory -Force -Path $USER_DATA | Out-Null

# ── Construir flags ────────────────────────────────────────────────────────
$chromeArgs = @(
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
    "--window-size=1280,800"
)

if ($USE_EXT) {
    if (-not (Test-Path $EXT_DIR)) {
        Write-Host "ERROR: No se encontro buster-ext en: $EXT_DIR"
        exit 1
    }
    $chromeArgs += "--disable-extensions-except=$EXT_DIR"
    $chromeArgs += "--load-extension=$EXT_DIR"
    Write-Host "[3] Lanzando con --load-extension (Buster desde buster-ext/)..."
} else {
    $chromeArgs += "--profile-directory=$PROFILE"
    $chromeArgs += "--disable-session-crashed-bubble"
    Write-Host "[3] Lanzando con Profile 1 (Buster instalado en el perfil)..."
}

$chromeArgs += $URL
Start-Process $CHROME -ArgumentList $chromeArgs -WindowStyle Minimized

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
