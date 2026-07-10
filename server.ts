import { chromium, Page, Browser, BrowserContext, Frame, CDPSession } from "playwright";
import { startHumanMouse } from "./helpers/humanMouse";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);
import { mkdirSync } from "fs";
import { writeFile, readFile, readdir, stat, unlink } from "fs/promises";
import * as http from "http";
import * as path from "path";

const URL_SITE = "https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml";
const SCRIPT_DIR = __dirname;
const PYTHON = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const CDP_PORT = 9223;
const SERVER_PORT = parseInt(process.env.PORT ?? "3000");
const SERVER_HOST = process.env.HOST ?? "127.0.0.1";   // 0.0.0.0 en Docker (env HOST) para que el puerto publicado funcione
const CAPTCHA_TIMEOUT_MS = parseInt(process.env.CAPTCHA_TIMEOUT ?? "35") * 1000;
const CAPTCHA_TIMEOUT_BLOCKED_MS = parseInt(process.env.CAPTCHA_TIMEOUT_BLOCKED ?? "10") * 1000;
// Reintentos del audio con Whisper local pidiendo challenge NUEVO (reload) cada vez.
// Cuando Buster falla ("could not be solved, try again after requesting a new challenge")
// hay audios confusos que solo Whisper saca → le damos varios audios frescos.
const AUDIO_MAX_ATTEMPTS = parseInt(process.env.AUDIO_MAX_ATTEMPTS ?? "3");
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${SERVER_PORT}`;
const MAX_WORKERS = parseInt(process.env.WORKERS ?? "2");
const LOTE_STREAM_MAX = parseInt(process.env.LOTE_STREAM_MAX ?? "200");
const MAX_INTENTOS = parseInt(process.env.MAX_INTENTOS ?? "2");
const POOL_TARGET = parseInt(process.env.POOL_TARGET ?? String(MAX_WORKERS * 3));
const POOL_SOLVERS = parseInt(process.env.POOL_SOLVERS ?? "2");
const TOKEN_MAX_AGE_MS = 100_000;
// Pool ADAPTATIVO a la demanda (anti-quemado de IP): en idle no tiene sentido resolver
// 6 captchas que vencen sin usarse (~216 solves/hora al pedo que flagean la IP). Si no
// hubo consulta en DEMAND_WINDOW, el objetivo baja a POOL_IDLE. Al llegar demanda, sube a
// POOL_TARGET. POOL_IDLE=1 → 1ª consulta instantánea + mínimo desperdicio. 0 = cero solves
// en idle (pero la 1ª consulta espera un solve). Desactivar: POOL_IDLE = POOL_TARGET.
const POOL_IDLE = parseInt(process.env.POOL_IDLE ?? "1");
const DEMAND_WINDOW_MS = parseInt(process.env.DEMAND_WINDOW ?? "120") * 1000;
let lastDemandAt = 0;
// Disponibilidad: NO atar la apertura del puerto al pool. El server escucha SIEMPRE
// (tras un warmup acotado para arrancar tibio); si no hay token, una consulta espera
// POOL_WAIT_MS y si no llega devuelve 503 (no cuelga 120s, no crash-loop de systemd).
const POOL_WARMUP_MS = parseInt(process.env.POOL_WARMUP ?? "20") * 1000; // espera tibia máx antes de escuchar igual
const POOL_WAIT_MS = parseInt(process.env.POOL_WAIT ?? "45") * 1000;     // máx que una consulta espera un token → si no, 503
const SCREENSHOTS_DIR = path.join(SCRIPT_DIR, "screenshots");
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ── Conexión CDP ───────────────────────────────────────────────────────────
// El browser/context/reconnecting viven encapsulados en la clase CdpConnection
// (instancia única `cdp`, definida más abajo junto a su ciclo de vida). Node ya
// garantiza 1 instancia por módulo; la clase solo le da un dueño con interfaz
// controlada (nadie fuera reasigna el context).

// ── Tracker de consultas activas (sin bloqueo — pool es el limitador) ──────
class Semaphore {
  private _active = 0;
  private _waiting = 0;
  trackStart() { this._active++; }
  trackEnd()   { this._active = Math.max(0, this._active - 1); }
  trackWait()  { this._waiting++; }
  trackReady() { this._waiting = Math.max(0, this._waiting - 1); }
  get active():  number { return this._active; }
  get waiting(): number { return this._waiting; }
}
let semaphore: Semaphore;

// ── Token pool — páginas con CAPTCHA ya resuelto, listas para usar ─────────
interface PoolPage {
  page: Page;
  solvedAt: number;
  expiresAt: number; // deadline precalculado con buffer incluido
}
const pool: PoolPage[] = [];
let poolManagerRunning = false;

// ── Reaper de páginas (anti-leak) ──────────────────────────────────────────
// Cada token del pool es una PÁGINA abierta; bajo carga/fallo el close() se
// atrasa (o Chrome restaura sesión) y las páginas se acumulan — vimos 18, que
// satura el CDP (2 cores) y parece firma de ataque. inFlight = páginas que un
// solver está resolviendo o una consulta está usando (fuera del pool[] en ese
// momento). El reaper cierra TODA página que no esté ni en pool[] ni en inFlight.
const inFlight = new Set<Page>();
const REAPER_INTERVAL_MS = parseInt(process.env.REAPER_INTERVAL ?? "20000");
const MAX_PAGES = POOL_TARGET + POOL_SOLVERS + 3;

// Cierre con timeout: si el renderer está colgado, no bloquea el loop (el reaper
// reintenta en la próxima pasada porque la página sigue fuera de pool/inFlight).
async function closePageSafe(page: Page): Promise<void> {
  await Promise.race([
    page.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
}

async function reapPages(): Promise<void> {
  const ctx = cdp.context;
  if (!ctx) return;
  const legit = new Set<Page>(pool.map((t) => t.page));
  for (const p of inFlight) legit.add(p);
  const all = ctx.pages();
  let closed = 0;
  for (const p of all) {
    if (legit.has(p)) continue;
    await closePageSafe(p);
    closed++;
  }
  const remaining = ctx.pages().length;
  if (closed > 0) {
    console.log(`[REAPER] cerró ${closed} página(s) huérfana(s) — abiertas: ${remaining} (pool: ${pool.length}, inFlight: ${inFlight.size})`);
  } else if (remaining > MAX_PAGES) {
    console.warn(`[REAPER] ⚠️ ${remaining} páginas abiertas (esperado ≤${MAX_PAGES})`);
  }
}

// ── Mutex de sesión policía ────────────────────────────────────────────────
// Todas las páginas del pool viven en el MISMO BrowserContext -> comparten el
// cookie JSESSIONID -> la sesión JSF del sitio de la policía es única. Si dos
// consultas envían el formulario a la vez, la sesión del servidor se pisa y los
// resultados se cruzan (una cédula recibe el antecedente de otra). Este lock
// serializa SOLO el tramo enviar->leer contra la policía; el pre-resuelto de
// CAPTCHAs del pool sigue corriendo en paralelo.
let _consultaLock: Promise<void> = Promise.resolve();
async function acquireConsultaLock(): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  const prev = _consultaLock;
  _consultaLock = prev.then(() => next);
  await prev;
  return release;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function esperar(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function cdpActivo(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function asegurarPagina(port: number): Promise<void> {
  const targets: any[] = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve([]); } });
    }).on("error", () => resolve([]));
  });
  if (targets.some((t) => t.type === "page")) return;
  await new Promise<void>((resolve) => {
    const req = http.request(
      `http://127.0.0.1:${port}/json/new?${URL_SITE}`,
      { method: "PUT" },
      (res) => { res.resume(); res.on("end", () => resolve()); }
    );
    req.on("error", () => resolve());
    req.end();
  });
}

async function rcResuelto(page: Page): Promise<boolean> {
  const token = await page.evaluate(() => {
    const t = document.getElementById("g-recaptcha-response") as HTMLTextAreaElement;
    return t?.value ?? "";
  }).catch(() => "");
  if (token.length > 50) return true;

  const rcIframe = page.frames().find(f =>
    f.url().includes("recaptcha") && f.url().includes("anchor") && !f.url().includes("bframe")
  );
  if (rcIframe) {
    const state = await rcIframe.evaluate(() => {
      const a = document.getElementById("recaptcha-anchor");
      return {
        ariaChecked: a?.getAttribute("aria-checked") ?? "null",
        hasCheckedClass: !!document.querySelector(".recaptcha-checkbox-checked"),
      };
    }).catch(() => ({ ariaChecked: "err", hasCheckedClass: false }));
    if (state.ariaChecked === "true" || state.hasCheckedClass) return true;
  }
  return false;
}

async function getBframe(page: Page): Promise<Frame | null> {
  const h = await page.locator('iframe[src*="bframe"]').elementHandle().catch(() => null);
  if (!h) return null;
  return await h.contentFrame().catch(() => null);
}

// ── Backoff rate-limit Google ──────────────────────────────────────────────
const rateLimit = {
  blocked: 0,
  windowStart: 0,
  WINDOW_MS: 60_000,
  MAX_BLOCKED: 3,
  PAUSE_MS: 30_000,
  record() {
    const now = Date.now();
    if (now - this.windowStart > this.WINDOW_MS) { this.blocked = 0; this.windowStart = now; }
    this.blocked++;
  },
  reset() { this.blocked = 0; },
  async waitIfLimited() {
    if (this.blocked >= this.MAX_BLOCKED) {
      console.log(`[POOL] ${this.blocked} bloqueos en <60s — pausando ${this.PAUSE_MS / 1000}s`);
      await esperar(this.PAUSE_MS);
      this.blocked = 0;
      this.windowStart = Date.now();
    }
  },
};

// ── Resolver reCAPTCHA ─────────────────────────────────────────────────────
async function resolverCaptcha(page: Page, label: string): Promise<boolean> {
  await rateLimit.waitIfLimited();
  let audioBloqueado = false;
  const recaptchaFrame = page.frameLocator('iframe[title="reCAPTCHA"]');
  await recaptchaFrame.locator("#recaptcha-anchor > div:first-child").waitFor({ state: "visible", timeout: 15000 });
  await recaptchaFrame.locator("#recaptcha-anchor > div:first-child").click();
  console.log(`[${label}][CAPTCHA] Checkbox clickeado...`);

  let passed = false;
  for (let i = 0; i < 16 && !passed; i++) {
    await esperar(500);
    if (await rcResuelto(page)) { console.log(`[${label}][CAPTCHA] Pasó sin challenge.`); passed = true; break; }
    const bframeTemp = await getBframe(page);
    if (bframeTemp) {
      const hasChallenge = await bframeTemp.locator(
        "#rc-imageselect, #rc-audiochallenge, #recaptcha-audio-button, #solver-button"
      ).isVisible().catch(() => false);
      if (hasChallenge) { console.log(`[${label}][CAPTCHA] Challenge detectado.`); break; }
    }
  }

  let bframe: Frame | null = null;
  if (!passed) {
    let hasHolder = false;
    for (let w = 0; w < 15 && !hasHolder; w++) {
      await esperar(1000);
      bframe = await getBframe(page);
      if (bframe) {
        hasHolder = (await bframe.locator(".help-button-holder").count().catch(() => 0)) > 0;
      }
    }
    if (bframe) {
      const holder = bframe.locator(".help-button-holder");
      if (hasHolder) {
        console.log(`[${label}][CAPTCHA] Clic en ícono Buster...`);
        await holder.click({ force: true, timeout: 8000 }).catch((e) => console.log(`[${label}][CAPTCHA] click Buster:`, (e as Error).message));
        for (let j = 0; j < 25 && !passed; j++) {
          await esperar(1000);
          if (await rcResuelto(page)) { console.log(`[${label}][CAPTCHA] Buster resolvió.`); passed = true; }
          if (j % 10 === 9) console.log(`[${label}][CAPTCHA] Buster trabajando... (${j + 1}s)`);
        }
      }
    }
  }

  if (!passed) {
    bframe = await getBframe(page);
    if (bframe) {
      const audioBtn = bframe.locator("#recaptcha-audio-button");
      const hasAudioBtn = await audioBtn.isVisible().catch(() => false);
      if (hasAudioBtn) {
        const disabled = await audioBtn.evaluate((el: any) => el.disabled || el.classList.contains("rc-button-disabled")).catch(() => false);
        if (!disabled) {
          console.log(`[${label}][CAPTCHA] Cambiando a audio challenge...`);
          await audioBtn.click();
          await esperar(2000);
          bframe = await getBframe(page);
        }
      }

      const cdpSession = await cdp.newCDPSession(page);
      await cdpSession.send("Network.enable");
      const audioRequests: Map<string, string> = new Map();
      cdpSession.on("Network.responseReceived", (evt: any) => {
        const url: string = evt.response?.url || "";
        const ct: string = evt.response?.mimeType || evt.response?.headers?.["content-type"] || "";
        if (url.includes("payload") && (ct.includes("audio") || url.includes("audio.mp3"))) {
          audioRequests.set(evt.requestId, url);
        }
      });

      // Loop de audio: capturar → Whisper → verificar. Si falla (audio confuso que
      // Buster no pudo, o respuesta incorrecta), pedir un audio NUEVO (reload) y reintentar.
      let capturaVacia = 0;
      for (let intento = 0; intento < AUDIO_MAX_ATTEMPTS && !passed; intento++) {
        bframe = await getBframe(page);
        if (!bframe) break;

        // Pedir audio FRESCO: en reintentos, o en el 1er intento si Buster ya gastó el
        // challenge (mensaje de error visible). Esto es el "request a new challenge".
        const reloadBtn = bframe.locator("#recaptcha-reload-button");
        const errVisible = await bframe.locator(".rc-audiochallenge-error-message").isVisible().catch(() => false);
        if ((intento > 0 || errVisible) && await reloadBtn.isVisible().catch(() => false)) {
          console.log(`[${label}][CAPTCHA] Pidiendo audio nuevo (intento ${intento + 1}/${AUDIO_MAX_ATTEMPTS})...`);
          audioRequests.clear();
          await reloadBtn.click().catch(() => {});
          await esperar(1500);
          bframe = await getBframe(page);
          if (!bframe) break;
        }

        const downloadHref = await bframe.locator(".rc-audiochallenge-tdownload-link, a[href*='payload']").getAttribute("href").catch(() => null);
        let requestId: string | null = null;
        for (let i = 0; i < 16; i++) {
          if (audioRequests.size > 0) { requestId = [...audioRequests.keys()][audioRequests.size - 1]; break; }
          await esperar(500);
        }

        let audioBuffer: Buffer | null = null;
        if (requestId) {
          try {
            const resp = await cdpSession.send("Network.getResponseBody", { requestId });
            if (resp.body && resp.body.length > 10) {
              audioBuffer = Buffer.from(resp.body, resp.base64Encoded ? "base64" : "utf-8");
              console.log(`[${label}][CAPTCHA] Audio CDP: ${audioBuffer.length}b`);
            }
          } catch (e) {
            console.log(`[${label}][CAPTCHA] CDP getResponseBody falló:`, (e as Error).message);
          }
        }

        if (!audioBuffer && downloadHref) {
          try {
            const b64 = await bframe.evaluate(async (url: string) => {
              const r = await fetch(url, { credentials: "include" });
              if (!r.ok) return "";
              const ab = await r.arrayBuffer();
              if (ab.byteLength === 0) return "";
              const u8 = new Uint8Array(ab);
              let s = ""; u8.forEach(b => (s += String.fromCharCode(b)));
              return btoa(s);
            }, downloadHref);
            if (b64.length > 10) {
              audioBuffer = Buffer.from(b64, "base64");
              console.log(`[${label}][CAPTCHA] Audio iframe fetch: ${audioBuffer.length}b`);
            }
          } catch (e) {
            console.log(`[${label}][CAPTCHA] iframe fetch falló:`, (e as Error).message);
          }
        }

        if (audioBuffer && audioBuffer.length > 100) {
          capturaVacia = 0;
          const mp3Path = path.join(SCRIPT_DIR, `captcha_audio_${label.replace(/[^a-z0-9]/gi, "_")}.mp3`);
          await writeFile(mp3Path, audioBuffer);
          try {
            const { stdout } = await execFileAsync(
              PYTHON,
              [path.join(SCRIPT_DIR, "transcribe.py"), "file", mp3Path],
              { encoding: "utf-8", timeout: 120000 }
            );
            const texto = stdout.trim();
            console.log(`[${label}][CAPTCHA] Transcripción (Whisper):`, texto);
            if (texto.length > 0) {
              await bframe.locator("#audio-response").fill(texto);
              await bframe.locator("#recaptcha-verify-button").click();
              await esperar(3000);
              passed = await rcResuelto(page);
              if (passed) { console.log(`[${label}][CAPTCHA] Whisper resolvió el audio.`); break; }
              console.log(`[${label}][CAPTCHA] Audio incorrecto — pido uno nuevo y reintento.`);
            }
          } catch (e) {
            console.log(`[${label}][CAPTCHA] Error transcripción:`, (e as Error).message);
          }
        } else {
          // Sin audio: si Google bloquea el audio (0 bytes) repetido, no insistir.
          capturaVacia++;
          console.log(`[${label}][CAPTCHA] Audio no capturado (${capturaVacia}).`);
          if (capturaVacia >= 2) {
            console.log(`[${label}][CAPTCHA] Audio bloqueado por Google (0 bytes).`);
            audioBloqueado = true;
            rateLimit.record();
            break;
          }
        }
      }
      await cdpSession.detach().catch(() => {});
    }
  }

  if (!passed && await rcResuelto(page)) { passed = true; }

  if (!passed) {
    const maxWait = audioBloqueado ? CAPTCHA_TIMEOUT_BLOCKED_MS : CAPTCHA_TIMEOUT_MS;
    console.log(`[${label}][CAPTCHA] Esperando resolución... timeout ${maxWait / 1000}s`);
    let waited = 0;
    while (waited < maxWait && !passed) {
      await esperar(2000);
      waited += 2000;
      if (await rcResuelto(page)) { passed = true; break; }
    }
  }

  if (passed) rateLimit.reset();
  return passed;
}

// ── Formulario ─────────────────────────────────────────────────────────────
async function irAFormulario(page: Page, label: string): Promise<void> {
  await page.goto(URL_SITE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator('[id="aceptaOption:0"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[id="aceptaOption:0"]').click();
  await page.locator('[id="continuarBtn"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[id="continuarBtn"]').click();
  await page.locator("#cedulaInput").waitFor({ state: "visible", timeout: 15000 });
  console.log(`[${label}][NAV] Formulario listo.`);
}

// ── Token Pool Manager — loop en background ────────────────────────────────
async function runPoolManager(sid: number = 0): Promise<void> {
  poolManagerRunning = true;
  const label = `POOL-${sid}`;
  console.log(`[${label}] Solver iniciado — objetivo: ${POOL_TARGET} tokens listos`);

  while (true) {
    try {
      // Descartar tokens expirados
      const now = Date.now();
      let expired = 0;
      for (let i = pool.length - 1; i >= 0; i--) {
        if (now > pool[i].expiresAt) {
          await pool[i].page.close().catch(() => {});
          pool.splice(i, 1);
          expired++;
        }
      }
      if (expired > 0) console.log(`[${label}] ${expired} token(s) expirados (pool: ${pool.length})`);

      // Objetivo ADAPTATIVO: POOL_TARGET si hubo demanda reciente, si no POOL_IDLE.
      // Evita quemar la IP resolviendo tokens que nadie va a usar en idle.
      const target = (Date.now() - lastDemandAt < DEMAND_WINDOW_MS) ? POOL_TARGET : POOL_IDLE;
      if (pool.length >= target) {
        await esperar(500);
        continue;
      }

      // Resolver un CAPTCHA nuevo
      console.log(`[${label}] Resolviendo CAPTCHA... (pool: ${pool.length}/${POOL_TARGET})`);
      const page = await cdp.newPage();
      inFlight.add(page);
      const stopMouse = startHumanMouse(page);
      try {
        await irAFormulario(page, label);
        const ok = await resolverCaptcha(page, label);
        stopMouse();
        if (ok) {
          const solvedAt = Date.now();
          pool.push({ page, solvedAt, expiresAt: solvedAt + TOKEN_MAX_AGE_MS - TOKEN_MIN_BUFFER_MS });
          console.log(`[${label}] Token listo ✓ (pool: ${pool.length}/${POOL_TARGET})`);
        } else {
          await closePageSafe(page);
          console.log(`[${label}] CAPTCHA no resuelto — reintentando en 3s`);
          await esperar(3000);
        }
      } catch (e) {
        stopMouse();
        await closePageSafe(page);
        console.log(`[${label}] Error: ${(e as Error).message} — reintentando en 3s`);
        await esperar(3000);
      } finally {
        inFlight.delete(page); // si quedó en pool[], el pool lo trackea; si no, se cerró
      }
    } catch (e) {
      console.error(`[${label}] Error inesperado: ${(e as Error).message}`);
      await esperar(5000);
    }
  }
}

// ── Obtener página del pool (espera si está vacío) ─────────────────────────
const TOKEN_MIN_BUFFER_MS = 3_000;

async function getPoolPage(): Promise<PoolPage> {
  lastDemandAt = Date.now(); // hay una consulta pidiendo token → el pool sube a POOL_TARGET
  let waited = false;
  const deadline = Date.now() + POOL_WAIT_MS; // si no llega token en este tiempo → 503
  while (true) {
    // Limpiar expirados del frente (los más viejos)
    while (pool.length > 0 && Date.now() > pool[0].expiresAt) {
      const p = pool.shift()!;
      await p.page.close().catch(() => {});
      console.log(`[POOL] Token expirado descartado`);
    }
    if (pool.length > 0) {
      const token = pool.pop()!; // LIFO — toma el más reciente (fresco)
      inFlight.add(token.page);  // ya no está en pool[] → protegerlo del reaper
      if (!await rcResuelto(token.page)) {
        inFlight.delete(token.page);
        await closePageSafe(token.page);
        console.log(`[POOL] Token inválido descartado (rcResuelto=false)`);
        continue;
      }
      if (waited) semaphore.trackReady();
      return token; // ejecutarConsulta lo saca de inFlight al cerrarlo
    }
    if (Date.now() > deadline) {
      if (waited) semaphore.trackReady(); // balancear el contador de espera del semáforo
      const err: any = new Error("Sin tokens disponibles (pool vacío) — reintentá en unos segundos");
      err.poolUnavailable = true; // → el handler devuelve 503, no 500 (no cuelga 120s)
      throw err;
    }
    if (!waited) { semaphore.trackWait(); waited = true; }
    await esperar(300);
  }
}

// ── Parser de resultado ────────────────────────────────────────────────────
interface DatosConsulta {
  cedula_consultada: string;
  nombre: string | null;
  tiene_antecedentes: boolean;
  estado: string;
  fecha_consulta: string | null;
  hora_consulta: string | null;
}

async function parsearPagina(page: Page, cedula: string): Promise<{ datos: DatosConsulta; resultado_raw: string }> {
  const extraido = await page.evaluate(() => {
    const container = document.querySelector("#form\\:mensajeCiudadano") as HTMLElement | null;
    const texto = (container ?? document.body).innerText;
    const fechaMatch = texto.match(/siendo las\s+([\d:]+\s*[AP]M)\s+horas del\s+([\d\/]+)/i);
    return {
      tieneContainer: !!container,
      texto,
      hora_consulta: fechaMatch ? fechaMatch[1].trim() : null,
      fecha_consulta: fechaMatch ? fechaMatch[2].trim() : null,
    };
  });

  if (!extraido.tieneContainer) {
    const url = page.url();
    const esViewExpired = url.includes("index.xhtml") || url.includes("error") ||
      /ViewExpired|La sesi[oó]n ha expirado|Session.*expired/i.test(extraido.texto);
    if (esViewExpired) {
      throw new Error(`ViewExpiredException — sesión JSF expirada (url: ${url.split("/").pop()})`);
    }
    return {
      datos: { cedula_consultada: cedula, nombre: null, tiene_antecedentes: false, estado: "NO DETERMINADO", fecha_consulta: null, hora_consulta: null },
      resultado_raw: extraido.texto.trim(),
    };
  }

  const texto = extraido.texto;

  if (/no puede ser generado/i.test(texto)) {
    return {
      datos: { cedula_consultada: cedula, nombre: null, tiene_antecedentes: false, estado: "CONSULTAR_PRESENCIALMENTE", fecha_consulta: extraido.fecha_consulta, hora_consulta: extraido.hora_consulta },
      resultado_raw: texto,
    };
  }

  const nombreMatch = texto.match(/Apellidos y Nombres:\s*(.+)/i);
  const nombre = nombreMatch ? nombreMatch[1].trim() : null;
  const estadoLinea = texto
    .split("\n")
    .map(l => l.trim())
    .find(l => /ASUNTOS PENDIENTES/i.test(l) && !/leyenda|aplica para|conformidad|art[íi]culo|sentencia/i.test(l));
  const estado = estadoLinea || "NO DETERMINADO";
  const sinPendientes = /NO TIENE ASUNTOS PENDIENTES/i.test(estado);
  const tiene_antecedentes = /ASUNTOS PENDIENTES/i.test(estado) && !sinPendientes;

  return {
    datos: { cedula_consultada: cedula, nombre, tiene_antecedentes, estado, fecha_consulta: extraido.fecha_consulta, hora_consulta: extraido.hora_consulta },
    resultado_raw: texto,
  };
}

// ── Consulta individual ────────────────────────────────────────────────────
async function ejecutarConsulta(
  wid: number,
  cedula: string,
  tipo: string = "cc"
): Promise<{ cedula: string; tipo: string; datos: DatosConsulta; resultado_raw: string; url: string; screenshot_url: string }> {

  // Obtener página con CAPTCHA ya resuelto del pool
  const { page, expiresAt } = await getPoolPage();
  const tokenTTL = Math.round((expiresAt - Date.now()) / 1000);
  console.log(`[W${wid}][CONSULTA] ${tipo.toUpperCase()} ${cedula} — token TTL: ${tokenTTL}s`);

  try {
    // Sección crítica serializada: enviar el formulario y leer el resultado
    // contra la sesión JSF compartida (JSESSIONID único del context). Fuera de
    // este lock dos consultas concurrentes se pisan y cruzan resultados.
    const release = await acquireConsultaLock();
    let url: string;
    let datos: DatosConsulta;
    let resultado_raw: string;
    try {
      // Solo cambiar tipo si es distinto al default (cc) — evita AJAX innecesario
      const currentTipo = await page.locator("#cedulaTipo").inputValue().catch(() => "cc");
      if (currentTipo !== tipo) {
        await page.locator("#cedulaTipo").selectOption(tipo);
        if (!await rcResuelto(page)) {
          throw new Error("Token del pool expiró tras selectOption");
        }
      }

      await page.locator("#cedulaInput").fill(cedula);

      await page.getByRole("button", { name: /consultar/i }).click();
      await Promise.race([
        page.waitForLoadState("networkidle", { timeout: 20000 }),
        page.locator("#form\\:mensajeCiudadano").waitFor({ state: "visible", timeout: 20000 }),
      ]).catch(() => {});

      url = page.url();
      ({ datos, resultado_raw } = await parsearPagina(page, cedula));
    } finally {
      release();
    }
    console.log(`[W${wid}][CONSULTA] OK — ${datos.nombre ?? "?"} | ${datos.estado}`);

    // Screenshot
    await page.locator("#form\\:mensajeCiudadano").waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0));
    await esperar(300);
    const screenshotFile = `${Date.now()}_${cedula}.png`;
    const screenshotPath = path.join(SCREENSHOTS_DIR, screenshotFile);
    try {
      const dims = await page.evaluate(() => ({
        w: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
        h: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      }));
      await page.setViewportSize({ width: Math.max(dims.w, 1280), height: Math.min(dims.h, 8000) });
      await esperar(400);
      await page.screenshot({ path: screenshotPath });
      await page.setViewportSize({ width: 1280, height: 800 });
    } catch {
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    }
    const screenshot_url = `${BASE_URL}/screenshot/${screenshotFile}`;

    return { cedula, tipo, datos, resultado_raw, url, screenshot_url };
  } finally {
    // Página usada — cerrar (pool manager crea nuevas)
    inFlight.delete(page);
    await closePageSafe(page);
  }
}

// ── Concurrencia controlada por semáforo ──────────────────────────────────
const enVuelo = new Map<string, Promise<any>>();
const CONSULTA_TIMEOUT_MS = parseInt(process.env.CONSULTA_TIMEOUT ?? "120") * 1000;
let reqCounter = 0;

// ── Caché de resultados ────────────────────────────────────────────────────
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL ?? "30") * 60 * 1000; // default 30 min
interface CacheEntry { result: any; expiresAt: number; }
const resultCache = new Map<string, CacheEntry>();
let cacheHits = 0;
let cacheMisses = 0;

function cacheGet(key: string): any | null {
  const entry = resultCache.get(key);
  if (!entry) { cacheMisses++; return null; }
  if (Date.now() > entry.expiresAt) { resultCache.delete(key); cacheMisses++; return null; }
  cacheHits++;
  return entry.result;
}

function cacheSet(key: string, result: any) {
  resultCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function ejecutarConReintentos(cedula: string, tipo: string): Promise<any> {
  // Sin semáforo aquí — el pool es el limitador natural de concurrencia.
  // Cada query espera su token libremente sin bloquear slots a otros.
  const wid = ++reqCounter;
  semaphore.trackStart();
  try {
    let intentos = 0;
    while (true) {
      try {
        const result = await ejecutarConsulta(wid, cedula, tipo);
        if (result.datos.estado === "NO DETERMINADO" && intentos < MAX_INTENTOS - 1) {
          console.log(`[R${wid}][RETRY] NO DETERMINADO — reintentando...`);
          await esperar(2000);
          intentos++;
          continue;
        }
        return result;
      } catch (e) {
        if ((e as any).poolUnavailable) throw e; // pool vacío: reintentar no ayuda → propagar 503
        intentos++;
        if (intentos < MAX_INTENTOS) {
          console.log(`[R${wid}][RETRY] fallo intento ${intentos}/${MAX_INTENTOS}: ${(e as Error).message}`);
          await esperar(1000);
        } else {
          throw e;
        }
      }
    }
  } finally {
    semaphore.trackEnd();
  }
}

function encolarConsulta(cedula: string, tipo: string): Promise<any> {
  const key = `${tipo}:${cedula}`;

  // Caché hit — devolver resultado guardado sin tocar la policía
  const cached = cacheGet(key);
  if (cached) {
    console.log(`[CACHE] HIT ${tipo.toUpperCase()} ${cedula}`);
    return Promise.resolve({ ...cached, cached: true });
  }

  const existente = enVuelo.get(key);
  if (existente) {
    console.log(`[DEDUP] ${cedula} ya en vuelo — reusando resultado`);
    return existente;
  }
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout: consulta excedió ${CONSULTA_TIMEOUT_MS / 1000}s`)), CONSULTA_TIMEOUT_MS)
  );
  const p = Promise.race([ejecutarConReintentos(cedula, tipo), timeout]);
  enVuelo.set(key, p);
  p.then((result) => {
    enVuelo.delete(key);
    cacheSet(key, result); // guardar en caché al completar
  }, () => enVuelo.delete(key));
  return p;
}

function encolarLote(items: { cedula: string; tipo: string }[]): Promise<any>[] {
  return items.map(item => encolarConsulta(item.cedula, item.tipo));
}

// ── CdpConnection — dueño único del browser/context + reconexión ───────────
// Encapsula el ciclo de vida del CDP: conectar, entregar páginas del context
// vivo, y reconectar solo si Chrome se cae. Instancia única `cdp` (abajo).
class CdpConnection {
  private _browser: Browser | null = null;
  private _context: BrowserContext | null = null;
  private _reconnecting = false; // guard: un solo loop de reconexión a la vez

  // Nullable a propósito: el reaper lo consulta y hace no-op si aún no hay context.
  get context(): BrowserContext | null { return this._context; }

  // Páginas SIEMPRE del context vivo. Lanzan si estamos sin conexión (arranque
  // o reconexión en curso) — el llamador ya trata el error como fallo transitorio.
  async newPage(): Promise<Page> {
    if (!this._context) throw new Error("CDP sin context (reconectando)");
    return this._context.newPage();
  }
  async newCDPSession(page: Page): Promise<CDPSession> {
    if (!this._context) throw new Error("CDP sin context (reconectando)");
    return this._context.newCDPSession(page);
  }

  // Conecta (o reconecta) al Chrome vía CDP, toma el context, aplica el
  // init-script anti-automatización y el handler que cierra tabs espurias.
  async connect(): Promise<void> {
    this._browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const ctxList = this._browser.contexts();
    this._context = ctxList.length > 0 ? ctxList[0] : await this._browser.newContext();

    await this._context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
      window.open = () => null;
    });

    // Cerrar tabs que extensiones abran automáticamente
    const browserCdp = await this._browser.newBrowserCDPSession();
    await browserCdp.send("Target.setDiscoverTargets", { discover: true });
    browserCdp.on("Target.targetCreated", async (event: any) => {
      const t = event.targetInfo;
      if (t.type === "page" && t.url !== "about:blank" && !t.url.includes("antecedentes.policia.gov.co")) {
        await browserCdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
      }
    });

    // Desacople runtime: si rpa-chrome reinicia/cae, NO morir → reconectar al CDP.
    this._browser.on("disconnected", () => this.onDisconnect());
  }

  // Chrome se desconectó (crash, `systemctl restart rpa-chrome`, CDP caído). Los
  // tokens del pool son páginas de un Chrome que ya no existe → inservibles: se
  // descartan y arranca el loop de reconexión (el guard evita loops paralelos).
  private onDisconnect(): void {
    if (this._reconnecting) return;
    this._reconnecting = true;
    console.warn("[CDP] Browser desconectado — descarto pool muerto y reconecto...");
    pool.length = 0;
    inFlight.clear();
    this.reconnect();
  }

  // Reintenta connectOverCDP hasta que el CDP vuelva. Los solvers siguen vivos en
  // su loop; al reasignarse el context interno reanudan solos (vía cdp.newPage()).
  private async reconnect(): Promise<void> {
    let intento = 0;
    while (true) {
      intento++;
      try {
        if (await cdpActivo(CDP_PORT)) {
          await asegurarPagina(CDP_PORT);
          await this.connect();
          this._reconnecting = false;
          console.log(`[CDP] Reconectado ✓ (intento ${intento}) — los solvers reanudan.`);
          return;
        }
      } catch (e) {
        console.warn(`[CDP] Reconexión intento ${intento} falló: ${(e as Error).message}`);
      }
      await esperar(3000);
    }
  }

  // Cierre a propósito (SIGTERM): latchea reconnecting para que "disconnected"
  // NO dispare una reconexión mientras el proceso se apaga.
  async close(): Promise<void> {
    this._reconnecting = true;
    await this._browser?.close().catch(() => {});
  }
}
const cdp = new CdpConnection();

// ── Inicializar browser ────────────────────────────────────────────────────
async function initBrowser(): Promise<void> {
  if (!(await cdpActivo(CDP_PORT))) {
    throw new Error(`CDP no activo en puerto ${CDP_PORT}.`);
  }
  await asegurarPagina(CDP_PORT);
  console.log("CDP activo — conectando browser...");
  await cdp.connect();

  semaphore = new Semaphore();

  // Arrancar solvers escalonados (5s entre cada uno para no saturar Google)
  for (let sid = 0; sid < POOL_SOLVERS; sid++) {
    const startSolver = (id: number) => {
      runPoolManager(id).catch(e => {
        console.error(`[POOL-${id}] Crashed: ${e.message} — reiniciando en 5s`);
        setTimeout(() => startSolver(id), 5000);
      });
    };
    setTimeout(() => startSolver(sid), sid * 5000);
  }

  // Reaper anti-leak: cierra páginas huérfanas (close colgado, sesión restaurada)
  // cada REAPER_INTERVAL_MS. Garantiza que solo queden abiertas las de pool+inFlight.
  setInterval(() => { reapPages().catch(() => {}); }, REAPER_INTERVAL_MS);

  // Warmup ACOTADO: esperar el 1er token para arrancar tibio, pero NO bloquear la
  // apertura del puerto. Si no llena en POOL_WARMUP_MS, initBrowser retorna igual → el
  // server escucha y devuelve 503 hasta que llene. Mata el 502 total + crash-loop.
  console.log("Warmup del pool (esperando 1er token, luego escucho igual)...");
  const warmupDeadline = Date.now() + POOL_WARMUP_MS;
  while (pool.length === 0 && Date.now() < warmupDeadline) await esperar(500);
  if (pool.length > 0) console.log(`Pool listo con ${pool.length} token(s) — semáforo de ${MAX_WORKERS} slot(s).`);
  else console.log(`Sin token tras ${POOL_WARMUP_MS / 1000}s — abro el puerto igual (503 hasta que el pool llene).`);
}

// ── Servidor HTTP ──────────────────────────────────────────────────────────
function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("JSON inválido")); }
    });
    req.on("error", reject);
  });
}

const TIPOS_VALIDOS = ["cc", "cx", "pa", "dp"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResp(res: http.ServerResponse, status: number, data: any) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...CORS_HEADERS });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    return jsonResp(res, 200, {
      ok: true,
      cdp: CDP_PORT,
      pool: pool.length,
      pool_target: POOL_TARGET,
      activas: semaphore.active,
      esperando: semaphore.waiting,
      max_workers: MAX_WORKERS,
      cache: { entradas: resultCache.size, hits: cacheHits, misses: cacheMisses, ttl_min: CACHE_TTL_MS / 60000 },
    });
  }

  if (req.method === "GET" && req.url?.startsWith("/screenshot/")) {
    const filename = path.basename(req.url.replace("/screenshot/", ""));
    const filePath = path.join(SCREENSHOTS_DIR, filename);
    try {
      const data = await readFile(filePath);
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": data.length, ...CORS_HEADERS });
      res.end(data);
    } catch {
      jsonResp(res, 404, { ok: false, error: "Screenshot no encontrado o expirado" });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/consultar") {
    let body: any;
    try { body = await parseBody(req); } catch (e) {
      return jsonResp(res, 400, { ok: false, error: "JSON inválido" });
    }
    const cedula = String(body.cedula ?? "").trim();
    const tipo = String(body.tipo ?? "cc").trim();
    if (!cedula) return jsonResp(res, 400, { ok: false, error: "cedula requerida" });
    if (!/^\d+$/.test(cedula)) return jsonResp(res, 400, { ok: false, error: "cedula debe contener solo numeros" });
    if (!TIPOS_VALIDOS.includes(tipo)) return jsonResp(res, 400, { ok: false, error: `tipo inválido — valores aceptados: ${TIPOS_VALIDOS.join(", ")}` });

    try {
      const result = await encolarConsulta(cedula, tipo);
      return jsonResp(res, 200, { ok: true, ...result });
    } catch (e: any) {
      // Pool vacío → 503 (Service Unavailable, reintentable) en vez de 500. Nunca 502 total.
      const status = e.poolUnavailable ? 503 : 500;
      if (status === 503) console.warn("[503]", e.message);
      else console.error("[ERROR]", e.message);
      return jsonResp(res, status, { ok: false, cedula, error: e.message });
    }
  }

  if (req.method === "POST" && req.url === "/consultar-lote") {
    let body: any;
    try { body = await parseBody(req); } catch (e) {
      return jsonResp(res, 400, { ok: false, error: "JSON inválido" });
    }
    if (!Array.isArray(body.cedulas) || body.cedulas.length === 0)
      return jsonResp(res, 400, { ok: false, error: "cedulas debe ser un array no vacío" });
    if (body.cedulas.length > 50)
      return jsonResp(res, 400, { ok: false, error: "máximo 50 cédulas por lote" });

    const items = body.cedulas.map((item: any) => ({
      cedula: String(item.cedula ?? "").trim(),
      tipo: String(item.tipo ?? "cc").trim(),
    }));
    const invalidas = items.filter((i: any) => !i.cedula || !/^\d+$/.test(i.cedula));
    if (invalidas.length > 0)
      return jsonResp(res, 400, { ok: false, error: `Cédulas inválidas: ${invalidas.map((i: any) => i.cedula || "(vacía)").join(", ")}` });
    const tiposInvalidos = items.filter((i: any) => !TIPOS_VALIDOS.includes(i.tipo));
    if (tiposInvalidos.length > 0)
      return jsonResp(res, 400, { ok: false, error: `Tipos inválidos: ${tiposInvalidos.map((i: any) => i.tipo).join(", ")} — valores aceptados: ${TIPOS_VALIDOS.join(", ")}` });

    console.log(`[LOTE] ${items.length} consultas`);
    const promesas = encolarLote(items);
    const resultados = await Promise.all(
      promesas.map(async (p: Promise<any>, idx: number) => {
        try { return { ok: true, ...await p }; }
        catch (e: any) { return { ok: false, cedula: items[idx].cedula, error: e.message }; }
      })
    );
    return jsonResp(res, 200, { ok: true, total: resultados.length, resultados });
  }

  if (req.method === "POST" && req.url === "/consultar-lote-stream") {
    let body: any;
    try { body = await parseBody(req); } catch (e) {
      return jsonResp(res, 400, { ok: false, error: "JSON inválido" });
    }
    if (!Array.isArray(body.cedulas) || body.cedulas.length === 0)
      return jsonResp(res, 400, { ok: false, error: "cedulas debe ser un array no vacío" });
    if (body.cedulas.length > LOTE_STREAM_MAX)
      return jsonResp(res, 400, { ok: false, error: `máximo ${LOTE_STREAM_MAX} cédulas por lote` });

    const items = body.cedulas.map((item: any) => ({
      cedula: String(item.cedula ?? "").trim(),
      tipo: String(item.tipo ?? "cc").trim(),
    }));
    const invalidas = items.filter((i: any) => !i.cedula || !/^\d+$/.test(i.cedula));
    if (invalidas.length > 0)
      return jsonResp(res, 400, { ok: false, error: `Cédulas inválidas: ${invalidas.map((i: any) => i.cedula || "(vacía)").join(", ")}` });
    const tiposInvalidos = items.filter((i: any) => !TIPOS_VALIDOS.includes(i.tipo));
    if (tiposInvalidos.length > 0)
      return jsonResp(res, 400, { ok: false, error: `Tipos inválidos: ${tiposInvalidos.map((i: any) => i.tipo).join(", ")} — valores aceptados: ${TIPOS_VALIDOS.join(", ")}` });

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      ...CORS_HEADERS,
    });
    const write = (obj: any) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };
    console.log(`[LOTE-STREAM] ${items.length} cédulas`);
    write({ event: "start", total: items.length, workers: MAX_WORKERS, pool: pool.length });

    let oks = 0;
    await Promise.all(items.map((item: any, idx: number) =>
      encolarConsulta(item.cedula, item.tipo)
        .then((r: any) => { oks++; write({ idx, ok: true, ...r }); })
        .catch((e: any) => { write({ idx, ok: false, cedula: item.cedula, error: e.message }); })
    ));
    if (!res.writableEnded) res.end(JSON.stringify({ event: "done", total: items.length, ok: oks }) + "\n");
    return;
  }

  jsonResp(res, 404, { ok: false, error: "Ruta no encontrada" });
});

// ── Arranque ───────────────────────────────────────────────────────────────
(async () => {
  try {
    await initBrowser();
  } catch (e: any) {
    console.error("ERROR init browser:", e.message);
    process.exit(1);
  }

  // Limpiar screenshots > 10 min
  setInterval(async () => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    try {
      for (const f of await readdir(SCREENSHOTS_DIR)) {
        const fp = path.join(SCREENSHOTS_DIR, f);
        if ((await stat(fp)).mtimeMs < cutoff) await unlink(fp);
      }
    } catch {}
  }, 60 * 1000);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] Cerrando...`);
    server.close();
    await cdp.close(); // latchea reconnecting → "disconnected" no reconecta al apagar
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  server.listen(SERVER_PORT, SERVER_HOST, () => {
    console.log(`\nServidor activo en http://${SERVER_HOST}:${SERVER_PORT} — ${MAX_WORKERS} worker(s)`);
    console.log("  POST /consultar              { \"cedula\": \"1234567\", \"tipo\": \"cc\" }");
    console.log("  POST /consultar-lote         { \"cedulas\": [{\"cedula\": \"...\", \"tipo\": \"cc\"}] }");
    console.log("  POST /consultar-lote-stream  { \"cedulas\": [{\"cedula\": \"...\", \"tipo\": \"cc\"}] }  (NDJSON)");
    console.log("  GET  /health");
    console.log(`\n  Tipos válidos: ${TIPOS_VALIDOS.map(t => `"${t}"`).join(" | ")}\n`);
  });
})();
