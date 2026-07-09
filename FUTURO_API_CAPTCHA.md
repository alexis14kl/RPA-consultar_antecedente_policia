# Implementación futura: API propia de tokens de captcha (Token Farm)

Diseño para evolucionar el solver actual hacia una **API interna de resolución de captchas**
— tu propio "Capsolver" self-hosted. Documento de roadmap; **hoy estamos armando infra**, esto
es la meta hacia donde crece.

> **Por qué:** ya rechazamos Capsolver (costo). Ya resolvemos reCAPTCHA de forma estable con
> infra propia. El siguiente paso natural es **generalizar** ese solver para que cualquier bot
> propio le pida tokens por API, en vez de tener la lógica de captcha acoplada a cada scraper.

---

## 1. El principio (lo que descubrimos, y en lo que se basa todo)

**reCAPTCHA v2/v3 NO es un ban binario: es un puntaje de riesgo ponderado.**

- Cada señal suma o resta "peso" a un score. Google no dice "sos un bot / no sos un bot";
  dice "**qué tan probable es que seas un bot**".
- El mensaje de **"IP baneada" es engañoso** — no te banean la IP, te asignan un **risk score
  alto**. Con la misma IP, si bajás el score, pasás (se comprobó: por VNC con mouse real pasaba,
  por robot no — misma IP).
- Cada capa humana **baja el peso**:

| Señal | Peso que aporta |
|---|---|
| `humanMouse.ts` moviendo el cursor de fondo | mouse "vivo" → baja el score |
| Extensión Buster decidiendo/resolviendo | comportamiento coherente |
| Client app nativo (XTEST) ejecutando el input | `isTrusted=true`, input real del OS |
| Perfil persistente + cookies + flags anti-automatización | reputación del browser |
| IP con peso bajo (residencial/móvil > datacenter) | reputación de red |

La suma de señales bajas → *"se ve sospechoso, pero es comportamiento humano → pasás"*. Esa
frase es, literalmente, el modelo mental correcto de reCAPTCHA.

---

## 2. Arquitectura objetivo (tu diagrama)

```
[Tu Bot] ──1. Envía SiteKey + URL──▶ [API de Captcha] ──2. Asigna a worker (browser+Buster)
   ▲                                                                    │
   │                                                                    ▼
[Tu Bot] ◀─4. Devuelve Token resuelto─ [API de Captcha] ◀─3. Obtiene g-recaptcha-response
```

Es el patrón clásico de 2captcha / Anti-Captcha / Capsolver, pero **con tus propios workers**.
Reemplaza al proveedor pago por un **farm de navegadores** que ya sabés humanizar.

```mermaid
flowchart LR
  Bot["Tu Bot / Scraper"] -->|createTask sitekey+url| API["API de Captcha (cola + pool)"]
  API -->|asigna| W1["Worker 1: Chrome+Xvfb+Buster+humanMouse+XTEST"]
  API -->|asigna| W2["Worker 2 ..."]
  API -->|asigna| Wn["Worker N ..."]
  W1 -->|g-recaptcha-response| API
  API -->|getTaskResult -> token| Bot
```

---

## 3. Cómo se construye SOBRE lo que ya tenés

El `server.ts` **ya mantiene un pool de tokens** (`POOL_TARGET=6`, workers resolviendo en
background). Eso ya ES el motor de esta API. Lo que falta es **desacoplarlo** del sitio de
policía y exponerlo genérico:

| Hoy (acoplado) | Futuro (API genérica) |
|---|---|
| El solver navega SIEMPRE al sitio de policía (hardcode) | Recibe `websiteURL` + `websiteKey` por parámetro |
| El token se usa internamente en la consulta | El token se **devuelve** al cliente por API |
| Un pool para un solo sitio | Pools por `(sitekey, dominio)` |
| `POST /consultar` | `POST /createTask` + `GET /getTaskResult` |

**Trabajo concreto:** extraer `resolverCaptcha()` a un módulo `solver/` que tome
`(page, sitekey, url)`, y montar una cola de tareas que asigne a los workers libres del pool
(la lógica rodante de workers que ya diseñamos en el plan del lote sirve tal cual).

---

## 4. Contrato de API propuesto (compatible-ish con Anti-Captcha/2captcha)

Reusar el formato de los proveedores conocidos → los clientes existentes casi no cambian.

```http
POST /createTask
{ "type": "RecaptchaV2TaskProxyless",
  "websiteURL": "https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml",
  "websiteKey": "6LcsIwQaAAAAAFCsaI-dkR6hgKsZwwJRsmE0tIJH" }
→ { "taskId": "abc123" }
```
```http
GET /getTaskResult?taskId=abc123
→ { "status": "processing" }                # todavía resolviendo
→ { "status": "ready", "solution": { "gRecaptchaResponse": "03AGdBq26..." } }
```

Auth por **API key** propia (header). Rate limit por key. Métricas de éxito/tiempo por sitekey.

---

## 5. El "solver farm" (los workers)

- N navegadores idénticos al actual: **Chrome + Xvfb + Buster (con client app) + humanMouse**.
- Cada worker toma una tarea, navega a `websiteURL`, resuelve el reCAPTCHA con las capas
  humanas, **extrae el `g-recaptcha-response`** (del textarea `#g-recaptcha-response` o vía
  el callback) y lo entrega a la cola.
- **Gestión de risk score** = el corazón del negocio:
  - Pool de **IPs** (residencial/móvil pesa menos que datacenter). Rotar y "enfriar" las que
    acumulan peso alto (el `rpa-proxy-watchdog` ya hace la primera versión de esto).
  - Throttle por IP (no 6 solves simultáneos desde la misma IP).
  - Perfiles persistentes por worker (reputación acumulada).

---

## 6. Límites honestos (para no diseñar sobre un mito)

- **El token está atado al dominio.** Un `g-recaptcha-response` se valida server-side con el
  *secret key* del dueño del sitio (`siteverify`). Si el sitio tiene activada la **verificación
  de dominio/origen**, el token debe resolverse en un contexto que Google asocie a ese dominio
  → el worker debe cargar el **sitio real** (o un harness con el referer correcto). Muchos sitios
  la tienen **desactivada** y ahí un token resuelto "remoto" es aceptado. **Hay que probarlo por
  sitekey** — no asumir que un token de cualquier lado sirve.
- **reCAPTCHA v3 es distinto:** no hay challenge, es **puro score** generado con la acción. No
  se "resuelve" con un click; depende de la **reputación acumulada** (browser/IP/cookies/historial).
  Este farm resuelve muy bien **v2 (checkbox + challenge)**; para v3 la estrategia es mantener
  browsers "con reputación" (uso real, cookies, edad), no resolver un puzzle.
- **Enterprise vs normal:** el sitio de policía usa reCAPTCHA **Enterprise**; el flujo de token
  es el mismo, pero el score puede ponderar más señales. Nuestra config ya lo pasa.
- **Uso:** esto es para **tu propia infra** de consultas a servicios públicos (antecedentes),
  no un servicio abierto a terceros. Mantenerlo interno y autenticado.

---

## 7. Roadmap por fases

- **Fase 0 — hoy ✅:** pool de tokens acoplado al sitio de policía, estable 5/5. (`server.ts`)
- **Fase 1:** extraer `resolverCaptcha()` a `solver/` genérico `(page, sitekey, url)`.
- **Fase 2:** API `createTask` / `getTaskResult` + cola de tareas + auth por API key.
- **Fase 3:** farm multi-worker + **multi-IP** (pool de proxies residencial/móvil), con métricas
  de éxito y risk score por IP/sitekey.
- **Fase 4:** dashboard de operación (éxito %, tiempo medio, IPs "quemadas"), rate limiting,
  auto-scaling de workers.

---

## 8. Piezas que YA existen y se reusan

| Pieza actual | Rol en la API futura |
|---|---|
| Pool de tokens de `server.ts` | motor de resolución (Fase 1) |
| `helpers/humanMouse.ts` | capa humana de cada worker |
| `deploy/install_buster_client.sh` + native host | input real (XTEST) de cada worker |
| `rpa-proxy-watchdog` + `hide-my-ip` | gestión de IP / risk score (v1) |
| systemd 24/7 (`deploy/`) | mantener el farm arriba |
| `transcribe.py` (whisper local) | audio challenge sin depender de remoto |

**No arrancás de cero.** La infra que armamos para el RPA de antecedentes **es** el prototipo
de esta API — solo hay que generalizarla y exponerla. Ver `ANTIBAN_VPS.md` para el detalle de
cada capa.
