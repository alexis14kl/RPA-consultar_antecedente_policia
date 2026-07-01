# ============================================================
# Dockerfile — App de consulta de antecedentes (Policía)
# Adaptado del repo docker funcional (fintech-police-scrapping).
# Diferencias clave:
#   - Usa npm (la app tiene package-lock.json), no pnpm.
#   - Corre con ts-node en runtime (así corre la app), no compilado.
#
# IMPORTANTE: el build context es la RAÍZ del proyecto (..), no dockertApp/,
# porque este Dockerfile vive en la subcarpeta. Ver dockertApp/docker-compose.yml.
#
# Runtime: Node + Chromium (CDP) + Xvfb + Python (pydub/SpeechRecognition).
# La app se conecta por CDP al Chromium del sistema (connectOverCDP) → NO descarga
# los navegadores de Playwright (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1).
# ============================================================
FROM node:24-bookworm

WORKDIR /app

# Chromium del sistema + Xvfb + Python (transcripción del audio del captcha).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      tini \
      ca-certificates \
      curl \
      chromium \
      xvfb \
      xauth \
      dbus-x11 \
      python3 \
      python3-pip \
      ffmpeg \
      flac \
      pulseaudio \
      pulseaudio-utils \
      fonts-liberation \
      fonts-noto-core \
      fonts-noto-color-emoji \
      fonts-freefont-ttf && \
    pip3 install --no-cache-dir --break-system-packages pydub SpeechRecognition && \
    rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*

# Dependencias node (npm). Se instalan TODAS incluyendo devDeps: ts-node y
# typescript son necesarios en runtime (la app corre con ts-node).
# Además se baja Chrome for Testing (build de Google) — Google confía en él y NO le
# bloquea el audio del reCAPTCHA como al chromium de Debian. Se usa vía CHROME_BIN.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
RUN npm install --include=dev && \
    npx playwright install chromium && \
    chmod -R a+rX /ms-playwright && \
    npm cache clean --force

# Código de la app (rutas relativas a la raíz del proyecto = build context).
COPY tsconfig.json ./
COPY server.ts browser.ts transcribe.py launch_chrome_linux.sh ./
COPY buster-ext ./buster-ext
COPY chrome-cdp-profile ./chrome-cdp-profile
COPY dockertApp/docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x /app/docker-entrypoint.sh /app/launch_chrome_linux.sh && \
    mkdir -p /app/chrome-cdp-profile /app/screenshots && \
    chown -R node:node /app

# HOST=0.0.0.0 → necesario para que el puerto publicado del contenedor funcione.
# (server.ts bindea process.env.HOST ?? "127.0.0.1".)
ENV HOST=0.0.0.0 \
    PORT=3004 \
    PYTHON=python3

USER node

EXPOSE 3004

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3004/health >/dev/null || exit 1

# tini como PID 1 (señales/zombies). El entrypoint levanta Chromium+Xvfb y luego
# corre el CMD (la app con ts-node).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["npx", "ts-node", "server.ts"]
