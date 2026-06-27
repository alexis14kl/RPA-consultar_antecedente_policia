import { chromium, Page, Browser, BrowserContext, Frame } from "playwright";
import { execSync } from "child_process";
import { writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import * as http from "http";
import * as path from "path";

const URL_SITE = "https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml";
const SCRIPT_DIR = __dirname;
const PYTHON = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const CDP_PORT = 9223;
const SERVER_PORT = parseInt(process.env.PORT ?? "3000");
const CAPTCHA_TIMEOUT_MS = parseInt(process.env.CAPTCHA_TIMEOUT ?? "35") * 1000;
// Si Google bloqueó el audio (0 bytes) ya decidió no dar token → abort rápido en
// vez de quemar el timeout completo esperando una resolución que no va a llegar.
const CAPTCHA_TIMEOUT_BLOCKED_MS = parseInt(process.env.CAPTCHA_TIMEOUT_BLOCKED ?? "10") * 1000;
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${SERVER_PORT}`;
const MAX_WORKERS = parseInt(process.env.WORKERS ?? "2");
const LOTE_STREAM_MAX = parseInt(process.env.LOTE_STREAM_MAX ?? "200");
// Reintentos ante fallo (ej. captcha no resuelto): reencola el item → otro worker
// libre lo reintenta (failover). Capado para no quedar en loop si todo falla.
const MAX_INTENTOS = parseInt(process.env.MAX_INTENTOS ?? "2");
const SCREENSHOTS_DIR = path.join(SCRIPT_DIR, "screenshots");
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ── Browser global ─────────────────────────────────────────────────────────
let browser: Browser | null = null;
let context: BrowserContext | null = null;

// ── Worker state ───────────────────────────────────────────────────────────
interface WorkerState {
  id: number;
  page: Page;
  captchaResueltaAt: number;
  goBackPending: Promise<void>;
  busy: boolean;
}
const workers: WorkerState[] = [];

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
  console.log("CDP sin pestañas — abriendo una nueva...");
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

// ── Warm-up: calentar un worker antes de aceptar tráfico ───────────────────
// Resuelve 1 captcha de prueba (sin enviar cédula) para: despertar el service
// worker de Buster (MV3 arranca dormido → cold-start) y dejar un token cacheado
// que la primera consulta real reusa. Si la página viene quemada, la reemplaza.
async function calentarWorker(worker: WorkerState): Promise<void> {
  for (let intento = 1; intento <= 2; intento++) {
    try {
      await irAFormulario(worker.page, worker.id);
      await acquireCaptchaMutex();
      let ok = false;
      try { ok = await resolverCaptcha(worker.page, worker.id); }
      finally { releaseCaptchaMutex(); }
      if (ok) {
        worker.captchaResueltaAt = Date.now();
        console.log(`[W${worker.id}][WARMUP] Caliente ✓ — Buster despierto + token cacheado.`);
        return;
      }
    } catch (e) {
      console.log(`[W${worker.id}][WARMUP] intento ${intento} falló: ${(e as Error).message}`);
    }
    if (intento < 2) {
      try {
        const pNueva = await context!.newPage();
        await worker.page.close().catch(() => {});
        worker.page = pNueva;
        console.log(`[W${worker.id}][WARMUP] Página quemada — reemplazada, reintentando...`);
      } catch {}
    }
  }
  console.log(`[W${worker.id}][WARMUP] No calentó (la primera consulta usará failover).`);
}

// ── Inicializar browser ────────────────────────────────────────────────────
async function initBrowser(): Promise<void> {
  if (!(await cdpActivo(CDP_PORT))) {
    throw new Error(`CDP no activo en puerto ${CDP_PORT}.`);
  }
  await asegurarPagina(CDP_PORT);
  console.log("CDP activo — conectando browser...");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctxList = browser.contexts();
  context = ctxList.length > 0 ? ctxList[0] : await browser.newContext();

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array;
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
    window.open = () => null;
  });

  // Worker 0 — reutilizar página existente
  const existingPages = context.pages();
  const page0 = existingPages.find(p => p.url().includes("antecedentes.policia.gov.co")) ?? existingPages[0] ?? await context.newPage();
  for (const p of existingPages) {
    if (p !== page0) await p.close().catch(() => {});
  }
  workers.push({ id: 0, page: page0, captchaResueltaAt: 0, goBackPending: Promise.resolve(), busy: false });

  // Workers 1..N — páginas nuevas, pre-navegar a URL para no quedar en about:blank
  for (let i = 1; i < MAX_WORKERS; i++) {
    const p = await context.newPage();
    p.goto(URL_SITE, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    workers.push({ id: i, page: p, captchaResueltaAt: 0, goBackPending: Promise.resolve(), busy: false });
  }

  // Cerrar tabs que extensiones abran DESPUÉS de crear nuestras páginas
  const browserCdp = await browser.newBrowserCDPSession();
  await browserCdp.send("Target.setDiscoverTargets", { discover: true });
  browserCdp.on("Target.targetCreated", async (event: any) => {
    const t = event.targetInfo;
    if (t.type === "page" && t.url !== "about:blank" && !t.url.includes("antecedentes.policia.gov.co")) {
      await browserCdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    }
  });

  console.log(`Browser inicializado — ${MAX_WORKERS} worker(s) listos.`);

  // Warm-up: dejar cada worker con Buster despierto + token cacheado, para que la
  // primera consulta real arranque caliente (sin cold-start de Buster ni failover).
  // Desactivable con WARMUP=0.
  if (process.env.WARMUP !== "0") {
    console.log("Calentando workers (Buster + token)...");
    await Promise.all(workers.map(w => calentarWorker(w)));
    console.log("Warm-up completo — workers calientes.");
  }

  // Arrancar loops de workers
  for (const w of workers) {
    startWorker(w);
  }
}

async function getBframe(page: Page): Promise<Frame | null> {
  const h = await page.locator('iframe[src*="bframe"]').elementHandle().catch(() => null);
  if (!h) return null;
  return await h.contentFrame().catch(() => null);
}

// ── Resolver reCAPTCHA ─────────────────────────────────────────────────────
async function resolverCaptcha(page: Page, wid: number): Promise<boolean> {
  await rateLimit.waitIfLimited(wid);   // backoff si Google viene bloqueando
  let audioBloqueado = false;
  const recaptchaFrame = page.frameLocator('iframe[title="reCAPTCHA"]');
  await recaptchaFrame.locator("#recaptcha-anchor > div:first-child").waitFor({ state: "visible", timeout: 15000 });
  await recaptchaFrame.locator("#recaptcha-anchor > div:first-child").click();
  console.log(`[W${wid}][CAPTCHA] Checkbox clickeado...`);

  let passed = false;
  for (let i = 0; i < 16 && !passed; i++) {
    await esperar(500);
    if (await rcResuelto(page)) { console.log(`[W${wid}][CAPTCHA] Pasó sin challenge.`); passed = true; break; }
    const bframeTemp = await getBframe(page);
    if (bframeTemp) {
      const hasChallenge = await bframeTemp.locator(
        "#rc-imageselect, #rc-audiochallenge, #recaptcha-audio-button, #solver-button"
      ).isVisible().catch(() => false);
      if (hasChallenge) { console.log(`[W${wid}][CAPTCHA] Challenge detectado.`); break; }
    }
  }

  let bframe: Frame | null = null;
  if (!passed) {
    // Esperar que aparezca el bframe Y que Buster inyecte su botón (puede tardar ~12s)
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
        console.log(`[W${wid}][CAPTCHA] Clic en ícono Buster (.help-button-holder)...`);
        await holder.click({ force: true, timeout: 8000 }).catch((e) => console.log(`[W${wid}][CAPTCHA] click Buster:`, (e as Error).message));
        for (let j = 0; j < 25 && !passed; j++) {
          await esperar(1000);
          if (await rcResuelto(page)) { console.log(`[W${wid}][CAPTCHA] Buster resolvió.`); passed = true; }
          if (j % 10 === 9) console.log(`[W${wid}][CAPTCHA] Buster trabajando... (${j + 1}s)`);
        }
      } else {
        console.log(`[W${wid}][CAPTCHA] .help-button-holder no presente — Buster no disponible.`);
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
        if (disabled) {
          console.log(`[W${wid}][CAPTCHA] Audio button deshabilitado (rate limit Google).`);
        } else {
          console.log(`[W${wid}][CAPTCHA] Cambiando a audio challenge...`);
          await audioBtn.click();
          await esperar(2000);
          bframe = await getBframe(page);
        }
      }

      const cdpSession = await context!.newCDPSession(page);
      await cdpSession.send("Network.enable");
      const audioRequests: Map<string, string> = new Map();
      cdpSession.on("Network.responseReceived", (evt: any) => {
        const url: string = evt.response?.url || "";
        const ct: string = evt.response?.mimeType || evt.response?.headers?.["content-type"] || "";
        if (url.includes("payload") && (ct.includes("audio") || url.includes("audio.mp3"))) {
          audioRequests.set(evt.requestId, url);
        }
      });

      bframe = await getBframe(page);
      if (bframe) {
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
              console.log(`[W${wid}][CAPTCHA] Audio CDP: ${audioBuffer.length}b`);
            }
          } catch (e) {
            console.log(`[W${wid}][CAPTCHA] CDP getResponseBody falló:`, (e as Error).message);
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
              console.log(`[W${wid}][CAPTCHA] Audio iframe fetch: ${audioBuffer.length}b`);
            }
          } catch (e) {
            console.log(`[W${wid}][CAPTCHA] iframe fetch falló:`, (e as Error).message);
          }
        }

        if (audioBuffer && audioBuffer.length > 100) {
          const mp3Path = path.join(SCRIPT_DIR, `captcha_audio_w${wid}.mp3`);
          writeFileSync(mp3Path, audioBuffer);
          try {
            const texto = execSync(
              `"${PYTHON}" "${path.join(SCRIPT_DIR, "transcribe.py")}" file "${mp3Path}"`,
              { encoding: "utf-8", timeout: 120000 }
            ).trim();
            console.log(`[W${wid}][CAPTCHA] Transcripción:`, texto);
            if (texto.length > 0) {
              await bframe.locator("#audio-response").fill(texto);
              await bframe.locator("#recaptcha-verify-button").click();
              await esperar(3000);
              passed = await rcResuelto(page);
            }
          } catch (e) {
            console.log(`[W${wid}][CAPTCHA] Error transcripción:`, (e as Error).message);
          }
        } else {
          console.log(`[W${wid}][CAPTCHA] Audio bloqueado por Google (0 bytes).`);
          audioBloqueado = true;
          rateLimit.record();
        }
        await cdpSession.detach().catch(() => {});
      }
    }
  }

  if (!passed && await rcResuelto(page)) {
    console.log(`[W${wid}][CAPTCHA] Resuelto (detección tardía).`);
    passed = true;
  }

  if (!passed) {
    // Timeout dinámico: si Google bloqueó el audio, abort rápido; si no, el normal.
    const maxWait = audioBloqueado ? CAPTCHA_TIMEOUT_BLOCKED_MS : CAPTCHA_TIMEOUT_MS;
    console.log(`[W${wid}][CAPTCHA] Esperando resolución... timeout ${maxWait / 1000}s${audioBloqueado ? " (audio bloqueado — abort rápido)" : ""}`);
    let waited = 0;
    while (waited < maxWait && !passed) {
      await esperar(2000);
      waited += 2000;
      if (await rcResuelto(page)) {
        console.log(`[W${wid}][CAPTCHA] Resuelto en background (${waited / 1000}s).`);
        passed = true;
        break;
      }
      if (waited % 20000 === 0) console.log(`[W${wid}][CAPTCHA] Esperando... ${waited / 1000}s/${maxWait / 1000}s`);
    }
  }

  if (passed) rateLimit.reset();   // éxito → resetea el contador de bloqueos
  return passed;
}

// ── Formulario ─────────────────────────────────────────────────────────────
async function irAFormulario(page: Page, wid: number): Promise<void> {
  await page.goto(URL_SITE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator('[id="aceptaOption:0"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[id="aceptaOption:0"]').click();
  await page.locator('[id="continuarBtn"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[id="continuarBtn"]').click();
  await page.locator("#cedulaInput").waitFor({ state: "visible", timeout: 15000 });
  console.log(`[W${wid}][NAV] Formulario listo.`);
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
    // ViewExpiredException de JSF: el servidor descartó la vista y redirigió a
    // index o mostró una página de error. Lanzar excepción para que el worker
    // reemplace la página y reintente, en vez de quedarse con NO DETERMINADO.
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

  // Respuesta definitiva del sistema de la policía: no se puede generar online.
  // No reintentar — es una limitación del sistema, no un error transitorio.
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

// ── Consulta individual (por worker) ──────────────────────────────────────
async function ejecutarConsulta(
  worker: WorkerState,
  cedula: string,
  tipo: string = "cc"
): Promise<{ cedula: string; tipo: string; datos: DatosConsulta; resultado_raw: string; url: string; screenshot_url: string }> {
  const { id: wid, page } = worker;

  await worker.goBackPending;

  const tokenAge = Date.now() - worker.captchaResueltaAt;
  const tokenFresco = worker.captchaResueltaAt > 0 && tokenAge < 110_000;
  let enFormulario = false;

  if (tokenFresco) {
    enFormulario = await page.locator("#cedulaInput").isVisible({ timeout: 2000 }).catch(() => false);
    if (enFormulario) console.log(`[W${wid}][CAPTCHA] Token fresco (${Math.round(tokenAge / 1000)}s) — reutilizando.`);
  }

  if (!enFormulario) {
    await irAFormulario(page, wid);
  }

  // Verificar CAPTCHA ANTES de llenar el formulario: el selectOption("#cedulaTipo")
  // dispara un AJAX de JSF que resetea el widget reCAPTCHA, invalidando el token
  // cacheado si la verificación se hace después del llenado.
  let captchaOk = false;
  if (enFormulario && tokenFresco) {
    captchaOk = await rcResuelto(page);
    if (captchaOk) console.log(`[W${wid}][CAPTCHA] Token reutilizado OK.`);
  }

  await page.locator("#cedulaTipo").selectOption(tipo);
  await page.locator("#cedulaInput").fill(cedula);
  console.log(`[W${wid}][CONSULTA] ${tipo.toUpperCase()} ${cedula}`);
  if (!captchaOk) {
    await acquireCaptchaMutex();
    try {
      // Recheck tras obtener mutex — otro worker pudo haber resuelto mientras esperábamos
      captchaOk = await rcResuelto(page);
      if (!captchaOk) {
        captchaOk = await resolverCaptcha(page, wid);
        if (captchaOk) {
          worker.captchaResueltaAt = Date.now();
        }
      }
    } finally {
      releaseCaptchaMutex();
    }
  }
  if (!captchaOk) throw new Error("reCAPTCHA no resuelto dentro del timeout.");

  await page.locator("#j_idt17").click();
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});

  const url = page.url();
  const { datos, resultado_raw } = await parsearPagina(page, cedula);
  console.log(`[W${wid}][CONSULTA] OK — ${datos.nombre ?? "?"} | ${datos.estado}`);

  // Screenshot completo
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
  console.log(`[W${wid}][SCREENSHOT] ${screenshot_url}`);

  // waitUntil:"commit" en vez de "domcontentloaded": el sitio es JSF y el back
  // (POST/bfcache) NUNCA dispara domcontentloaded → antes agotaba el timeout de
  // 10s en CADA consulta. Con "commit" retorna en ~0.07s y el form queda listo.
  worker.goBackPending = page.goBack({ waitUntil: "commit", timeout: 10000 }).then(() => {}).catch(() => {});

  return { cedula, tipo, datos, resultado_raw, url, screenshot_url };
}

// ── Colas por worker ───────────────────────────────────────────────────────
interface QueueItem {
  cedula: string;
  tipo: string;
  resolve: (v: any) => void;
  reject: (e: any) => void;
  intentos?: number;
}
// Cola COMPARTIDA (pool rodante): cualquier worker libre toma la siguiente
// cédula. Reparte parejo solo — el worker que termina rápido jala más trabajo,
// en vez del round-robin estático que dejaba a un worker ocioso.
const cola: QueueItem[] = [];

// Dedup de consultas EN VUELO: si la misma cédula+tipo ya se está procesando, se
// reusa su misma promesa en vez de encolar otro job. Evita el doble-trabajo si el
// cliente/proxy reenvía la request (timeout) → un documento = un solo worker.
const enVuelo = new Map<string, Promise<any>>();

function encolarConsulta(cedula: string, tipo: string): Promise<any> {
  const key = `${tipo}:${cedula}`;
  const existente = enVuelo.get(key);
  if (existente) {
    console.log(`[DEDUP] ${cedula} ya en vuelo — reusando resultado (no se re-encola)`);
    return existente;
  }
  const p = new Promise((resolve, reject) => {
    cola.push({ cedula, tipo, resolve, reject });
  });
  enVuelo.set(key, p);
  p.then(() => enVuelo.delete(key), () => enVuelo.delete(key));
  return p;
}

function encolarLote(items: { cedula: string; tipo: string }[]): Promise<any>[] {
  return items.map(item => encolarConsulta(item.cedula, item.tipo));
}

function colaTotal(): number { return cola.length; }

// ── Backoff de rate-limit — si Google bloquea el audio varias veces seguidas,
// pausar para que su ventana se resetee (evita la cascada de bloqueos).
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
  async waitIfLimited(wid: number) {
    if (this.blocked >= this.MAX_BLOCKED) {
      console.log(`[W${wid}][RATE-LIMIT] ${this.blocked} bloqueos en <60s — pausando ${this.PAUSE_MS / 1000}s`);
      await esperar(this.PAUSE_MS);
      this.blocked = 0;
      this.windowStart = Date.now();
    }
  },
};

// ── Mutex CAPTCHA — solo 1 worker resuelve CAPTCHA a la vez ───────────────
let captchaMutexFree = true;
async function acquireCaptchaMutex(): Promise<void> {
  while (!captchaMutexFree) await esperar(500);
  captchaMutexFree = false;
}
function releaseCaptchaMutex(): void { captchaMutexFree = true; }

// ── Worker loop ────────────────────────────────────────────────────────────
function startWorker(worker: WorkerState): void {
  let lastKeepaliveAt = 0;
  let lastConsultaAt  = 0;         // última consulta real (no warmup)
  const KEEPALIVE_MS  = 18_000;   // ping JSF cada 18s (timeout del servidor ~30s)
  const REWARM_MS     = 95_000;   // re-solver CAPTCHA antes de que expire el token (110s)
  const REWARM_VENTANA_MS = 300_000; // solo rewarm si hubo consulta real en los últimos 5 min

  const loop = async () => {
    while (true) {
      const item = cola.shift();   // pool rodante: el worker libre toma la siguiente
      if (!item) {
        // Keepalive: solo cuando idle y ya hubo actividad (warmup o consulta previa).
        // No afecta procesos en curso — si llega un item, el worker lo toma en el
        // próximo ciclo (la cola lo retiene mientras dura el ping de ~1s).
        const hayTrabajo = cola.length > 0 || workers.some(w => w.busy);
        if (worker.captchaResueltaAt > 0 && Date.now() - lastKeepaliveAt > KEEPALIVE_MS) {
          lastKeepaliveAt = Date.now();
          const tokenAge = Date.now() - worker.captchaResueltaAt;
          const idleHaceRato = Date.now() - lastConsultaAt > REWARM_VENTANA_MS;
          if (tokenAge > REWARM_MS && !hayTrabajo && !idleHaceRato) {
            // Token próximo a expirar: re-resolver CAPTCHA.
            // Si el formulario sigue visible (sesión JSF activa), resolver sin
            // crear una vista nueva (evita quemar el límite de ~15 vistas/sesión).
            // Solo hacer irAFormulario si la sesión ya expiró.
            const formVisible = await worker.page.locator("#cedulaInput").isVisible({ timeout: 2000 }).catch(() => false);
            if (formVisible) {
              console.log(`[W${worker.id}][KEEPALIVE] Re-calentando CAPTCHA sin re-navegar (token ${Math.round(tokenAge / 1000)}s)...`);
              await acquireCaptchaMutex();
              let ok = false;
              try { ok = await resolverCaptcha(worker.page, worker.id); } finally { releaseCaptchaMutex(); }
              if (ok) {
                worker.captchaResueltaAt = Date.now();
                console.log(`[W${worker.id}][KEEPALIVE] Caliente ✓ (sin nueva vista JSF).`);
              } else {
                await calentarWorker(worker).catch(() => {});
              }
            } else {
              console.log(`[W${worker.id}][KEEPALIVE] Sesión expirada — re-navegando...`);
              await calentarWorker(worker).catch(() => {});
            }
          } else {
            // Solo mantener sesión JSF viva con un ping silencioso (sin navegar)
            await worker.page.evaluate((url: string) =>
              fetch(url, {
                method: "HEAD",
                credentials: "include",
                cache: "no-store",
                headers: {
                  "Faces-Request": "partial/ajax",
                  "X-Requested-With": "XMLHttpRequest",
                },
              }).catch(() => {})
            , URL_SITE).catch(() => {});
          }
        }
        await esperar(100);
        continue;
      }
      worker.busy = true;
      try {
        let result = await ejecutarConsulta(worker, item.cedula, item.tipo);
        if (result.datos.estado === "NO DETERMINADO") {
          console.log(`[W${worker.id}][RETRY] NO DETERMINADO — reintentando...`);
          await esperar(3000);
          result = await ejecutarConsulta(worker, item.cedula, item.tipo);
        }
        lastConsultaAt = Date.now();
        item.resolve(result);
      } catch (e) {
        item.intentos = (item.intentos ?? 0) + 1;
        if (item.intentos < MAX_INTENTOS) {
          console.log(`[W${worker.id}][RETRY] fallo intento ${item.intentos}/${MAX_INTENTOS} — reencolando (failover): ${(e as Error).message}`);
          // Página quemada (reCAPTCHA en estado de error): reemplazar por una fresca
          try {
            const pNueva = await context!.newPage();
            await worker.page.close().catch(() => {});
            worker.page = pNueva;
            worker.captchaResueltaAt = 0;
            worker.goBackPending = Promise.resolve();
            console.log(`[W${worker.id}][RETRY] Página reemplazada por una fresca.`);
          } catch {}
          cola.push(item);   // failover: cualquier worker libre lo reintenta
        } else {
          item.reject(e);
        }
      } finally {
        worker.busy = false;
      }
    }
  };
  loop().catch(e => {
    console.error(`[W${worker.id}] Loop crashed: ${e.message} — reiniciando en 3s`);
    worker.busy = false;
    setTimeout(() => startWorker(worker), 3000);
  });
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

function jsonResp(res: http.ServerResponse, status: number, data: any) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return jsonResp(res, 200, {
      ok: true,
      cdp: CDP_PORT,
      en_cola: colaTotal(),
      workers: workers.map(w => ({ id: w.id, busy: w.busy })),
      procesando: workers.some(w => w.busy),
    });
  }

  if (req.method === "GET" && req.url?.startsWith("/screenshot/")) {
    const filename = path.basename(req.url.replace("/screenshot/", ""));
    const filePath = path.join(SCREENSHOTS_DIR, filename);
    try {
      const data = readFileSync(filePath);
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": data.length });
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

    try {
      const result = await encolarConsulta(cedula, tipo);
      return jsonResp(res, 200, { ok: true, ...result });
    } catch (e: any) {
      console.error("[ERROR]", e.message);
      return jsonResp(res, 500, { ok: false, cedula, error: e.message });
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

    console.log(`[LOTE] ${items.length} consultas distribuidas en ${Math.min(MAX_WORKERS, items.length)} workers`);
    const promesas = encolarLote(items);
    const resultados = await Promise.all(
      promesas.map(async (p: Promise<any>, idx: number) => {
        try {
          const r = await p;
          return { ok: true, ...r };
        } catch (e: any) {
          return { ok: false, cedula: items[idx].cedula, error: e.message };
        }
      })
    );
    return jsonResp(res, 200, { ok: true, total: resultados.length, resultados });
  }

  // ── Lote en STREAM (NDJSON) — para cargas masivas (Excel 100+) ──────────────
  // Una línea JSON por resultado, apenas se completa. Mantiene la conexión viva
  // → evita el timeout (~100s) de Cloudflare en lotes grandes → soporta 100+.
  // Feed continuo al pool rodante (sin barrera por olas) = máxima velocidad; los
  // resultados salen en stream en orden de finalización. El cliente lee línea a línea.
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

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",   // evita buffering de proxies
    });
    const write = (obj: any) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };
    console.log(`[LOTE-STREAM] ${items.length} cédulas — streaming por el pool (${MAX_WORKERS} workers)`);
    write({ event: "start", total: items.length, workers: MAX_WORKERS });

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

  // Keep-alive JSF (25 min inactividad)
  const KEEPALIVE_INTERVAL = 5 * 60 * 1000;
  const KEEPALIVE_IDLE_THRESHOLD = 25 * 60 * 1000;
  setInterval(async () => {
    if (workers.some(w => w.busy) || colaTotal() > 0) return;
    const lastActivity = Math.max(...workers.map(w => w.captchaResueltaAt), 0);
    const idle = Date.now() - (lastActivity || Date.now());
    if (idle < KEEPALIVE_IDLE_THRESHOLD) return;
    const w = workers[0];
    if (!w) return;
    try {
      await w.page.evaluate(() =>
        fetch("https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml", { method: "HEAD", credentials: "include" }).catch(() => {})
      );
      console.log("[KEEPALIVE] Sesión JSF renovada.");
    } catch {}
  }, KEEPALIVE_INTERVAL);

  // Limpiar screenshots > 10 min
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    try {
      for (const f of readdirSync(SCREENSHOTS_DIR)) {
        const fp = path.join(SCREENSHOTS_DIR, f);
        if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp);
      }
    } catch {}
  }, 60 * 1000);

  server.listen(SERVER_PORT, "127.0.0.1", () => {
    console.log(`\nServidor activo en http://127.0.0.1:${SERVER_PORT} — ${MAX_WORKERS} worker(s)`);
    console.log("  POST /consultar        { \"cedula\": \"1234567\", \"tipo\": \"cc\" }");
    console.log("  POST /consultar-lote   { \"cedulas\": [{\"cedula\": \"...\", \"tipo\": \"cc\"}] }");
    console.log("  GET  /health\n");
  });
})();
