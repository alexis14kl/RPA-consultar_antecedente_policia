# dockertApp — Docker de la app de antecedentes

Setup Docker de **esta** app (rama `sistema_v2_semaforos`: pool de tokens +
semáforo). Adaptado del repo docker funcional, pero para **esta** app: usa
**npm** (no pnpm) y corre con **ts-node**.

## Qué hay acá
| Archivo | Qué es |
|---|---|
| `Dockerfile` | Imagen: Node + Chromium + Xvfb + Python + la app (ts-node). |
| `docker-entrypoint.sh` | Levanta Xvfb+Chromium (Buster) vía `launch_chrome_linux.sh` y arranca la app. |
| `docker-compose.yml` | Build + run (puerto 3004, `restart: unless-stopped`, volúmenes, healthcheck). |
| `Dockerfile.dockerignore` | Evita mandar `node_modules`, mp3s, etc. al build context. |

> El **build context es la raíz del proyecto** (`..`), no esta carpeta — por eso
> el Dockerfile puede copiar `server.ts`, `transcribe.py`, `buster-ext`, etc.

## Cómo levantarlo (necesita Colima/Docker corriendo)
```bash
# 1. arrancar el docker daemon (Colima)
colima start

# 2. build + up (desde la raíz del proyecto)
docker compose -f dockertApp/docker-compose.yml up --build -d

# 3. ver logs (warm-up del pool, etc.)
docker compose -f dockertApp/docker-compose.yml logs -f

# 4. probar
curl http://localhost:3004/health
curl -X POST http://localhost:3004/consultar \
  -H 'Content-Type: application/json' \
  -d '{"cedula":"1007601001","tipo":"cc"}'

# parar
docker compose -f dockertApp/docker-compose.yml down
```

## Notas importantes
- **`server.ts` bindea `HOST` (env):** se agregó `SERVER_HOST = process.env.HOST ?? "127.0.0.1"`.
  En local sigue en `127.0.0.1` (sin cambios); el compose pone `HOST=0.0.0.0` para
  que el puerto publicado del contenedor sea alcanzable. Sin esto, `localhost:3004`
  no llega a la app dentro del contenedor.
- **Puerto 3004** por defecto (como el ecosistema del DBA). Si corrés a la vez el
  otro contenedor (`ct-police-scrapping-dev`), van a chocar en 3004 — cambiá el
  `PORT`/`ports` de uno.
- **IP / rate-limit:** este contenedor sale por la IP de la máquina donde corre
  (residencial si es tu Mac). Para volumen 24/7 sostenido conviene **proxy
  residencial rotativo** (evita el rate-limit de Google que ya vimos).
- **Config por env** (todas opcionales): `PORT`, `WORKERS`, `POOL_TARGET`,
  `POOL_SOLVERS`, `CAPTCHA_TIMEOUT`, `BASE_URL`.

## Endpoints
- `GET  /health`
- `POST /consultar` — `{ "cedula": "...", "tipo": "cc" }`
- `POST /consultar-lote` — `{ "cedulas": [...] }`
- `POST /consultar-lote-stream` — NDJSON, carga masiva
