#!/usr/bin/env python3
"""uc_launch.py — Lanza un Google Chrome REAL "undetected" (undetected-chromedriver)
con remote-debugging en CDP 9223 y un perfil TIBIO persistente, y lo mantiene vivo
para que el server TS/Playwright se conecte por CDP igual que hoy.

Reemplaza a launch_chrome.sh (Chrome for Testing + Buster). Idea del descubrimiento:
Chrome real + UC + perfil persistente tibio pasa el reCAPTCHA gratis → sin Buster.

Arquitectura A: UC solo LANZA (aplica los flags/parches anti-detección al arrancar);
Playwright maneja por CDP. UC/Selenium se mantiene vivo (no hace driver.quit) para que
el Chrome no se cierre.

Env:
  CDP_PORT      (default 9223)
  UC_PROFILE    (default <este_dir>/uc-profile) — perfil persistente tibio
  RPA_URL       (default form de la policía) — navegación de calentamiento
  CHROME_MAIN   (default 149) — versión mayor de Chrome para el chromedriver de UC
"""
import os
import sys
import time
import signal

import undetected_chromedriver as uc

CDP_PORT = int(os.environ.get("CDP_PORT", "9223"))
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)  # chromium/ → raíz del proyecto
PROFILE = os.environ.get("UC_PROFILE", os.path.join(SCRIPT_DIR, "uc-profile"))
URL = os.environ.get("RPA_URL", "https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml")
CHROME_MAIN = int(os.environ.get("CHROME_MAIN", "149"))
# Buster (extensión) NO carga en Chrome real ≥137 aunque se re-habilite el switch, así que
# el fallback de Whisper se hace por motor STT (Google/Wit, en transcribe.py), no por la
# extensión. Default OFF: pasar --load-extension inútil sería una señal de bot de más.
# BUSTER=1 fuerza intentar cargarla (p. ej. si algún día se prueba con Chrome for Testing).
LOAD_BUSTER = os.environ.get("BUSTER", "0") != "0"
EXT_DIR = os.environ.get("BUSTER_EXT", os.path.join(PROJECT_DIR, "buster-ext"))


def main() -> int:
    os.makedirs(PROFILE, exist_ok=True)

    opts = uc.ChromeOptions()
    # Fijar el puerto CDP de Chrome a 9223: se pasa como `port=` a uc.Chrome() → UC lo usa
    # SOLO como debug_port (--remote-debugging-port). El chromedriver toma su propio puerto
    # libre aparte (ChromiumService sin port), así que no hay conflicto. NO usar
    # debugger_address (eso es "attach a Chrome existente" y cierra al no encontrarlo).
    opts.add_argument("--remote-allow-origins=*")
    opts.add_argument("--no-first-run")
    opts.add_argument("--no-default-browser-check")
    opts.add_argument("--window-size=1280,800")
    opts.add_argument("--window-position=-2000,0")  # fuera de vista (como el viejo)

    # Buster como fallback de Whisper: re-habilitar --load-extension en Chrome real ≥137.
    if LOAD_BUSTER and os.path.isdir(EXT_DIR):
        opts.add_argument("--disable-features=DisableLoadExtensionCommandLineSwitch")
        opts.add_argument(f"--disable-extensions-except={EXT_DIR}")
        opts.add_argument(f"--load-extension={EXT_DIR}")
        print(f"[uc] cargando Buster desde {EXT_DIR}", flush=True)
    elif LOAD_BUSTER:
        print(f"[uc] aviso: BUSTER=1 pero no existe {EXT_DIR} — sin Buster", flush=True)
    # NOTA: no seteamos --disable-blink-features=AutomationControlled ni tocamos
    # navigator.webdriver: UC ya se encarga de eso de forma más sigilosa.

    print(f"[uc] lanzando Chrome real (main={CHROME_MAIN}) — perfil: {PROFILE}", flush=True)
    driver = uc.Chrome(
        options=opts,
        user_data_dir=PROFILE,
        version_main=CHROME_MAIN,
        headless=False,
        port=CDP_PORT,        # debug_port de Chrome (--remote-debugging-port=9223)
        use_subprocess=True,  # Chrome sobrevive al proceso del driver
    )
    print(f"[uc] ✅ Chrome vivo. CDP en http://127.0.0.1:{CDP_PORT}", flush=True)

    try:
        driver.get(URL)
        print(f"[uc] navegado a {URL} (calentamiento)", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[uc] aviso: get() falló ({e}); Chrome sigue vivo igual", flush=True)

    # Mantener vivo hasta SIGTERM/SIGINT (NO driver.quit → Chrome queda para Playwright).
    stop = {"v": False}

    def _sig(_signum, _frame):
        stop["v"] = True

    signal.signal(signal.SIGTERM, _sig)
    signal.signal(signal.SIGINT, _sig)
    print("[uc] manteniendo vivo (SIGTERM/SIGINT para cerrar)...", flush=True)
    while not stop["v"]:
        time.sleep(2)

    print("[uc] cerrando Chrome...", flush=True)
    try:
        driver.quit()
    except Exception:  # noqa: BLE001
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
