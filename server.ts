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
const CAPTCHA_TIMEOUT_BLOCKED_MS = parseInt(process.env.CAPTCHA_TIMEOUT_BLOCKED ?? "10") * 1000;
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${SERVER_PORT}`;
const MAX_WORKERS = parseInt(process.env.WORKERS ?? "2");
const LOTE_STREAM_MAX = parseInt(process.env.LOTE_STREAM_MAX ?? "200");
const MAX_INTENTOS = parseInt(process.env.MAX_INTENTOS ?? "2");
const POOL_TARGET = parseInt(process.env.POOL_TARGET ?? String(MAX_WORKERS * 3));
const POOL_SOLVERS = parseInt(process.env.POOL_SOLVERS ?? "2");
const TOKEN_MAX_AGE_MS = 100_000;
const SCREENSHOTS_DIR = path.join(SCRIPT_DIR, "screenshots");
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ── Browser global ─────────────────────────────────────────────────────────
let browser: Browser | null = null;
let context: BrowserContext | null = null;

// ── Worker state ───────────────────────────────────────────────────────────
interface WorkerState {
  id: number;
  busy: boolean;
}
const workers: WorkerState[] = [];

// ── Token pool — páginas con CAPTCHA ya resuelto, listas para usar ─────────
interface PoolPage {
  page: Page;
  solvedAt: number;
}
const pool: PoolPage[] = [];
let poolManagerRunning = false;

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
          const mp3Path = path.join(SCRIPT_DIR, `captcha_audio_${label.replace(/[^a-z0-9]/gi, "_")}.mp3`);
          writeFileSync(mp3Path, audioBuffer);
          try {
            const texto = execSync(
              `"${PYTHON}" "${path.join(SCRIPT_DIR, "transcribe.py")}" file "${mp3Path}"`,
              { encoding: "utf-8", timeout: 120000 }
            ).trim();
            console.log(`[${label}][CAPTCHA] Transcripción:`, texto);
            if (texto.length > 0) {
              await bframe.locator("#audio-response").fill(texto);
              await bframe.locator("#recaptcha-verify-button").click();
              await esperar(3000);
              passed = await rcResuelto(page);
            }
          } catch (e) {
            console.log(`[${label}][CAPTCHA] Error transcripción:`, (e as Error).message);
          }
        } else {
          console.log(`[${label}][CAPTCHA] Audio bloqueado por Google (0 bytes).`);
          audioBloqueado = true;
          rateLimit.record();
        }
        await cdpSession.detach().catch(() => {});
      }
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
        if (now - pool[i].solvedAt > TOKEN_MAX_AGE_MS) {
          await pool[i].page.close().catch(() => {});
          pool.splice(i, 1);
          expired++;
        }
      }
      if (expired > 0) console.log(`[${label}] ${expired} token(s) expirados (pool: ${pool.length})`);

      // Si el pool está lleno, esperar
      if (pool.length >= POOL_TARGET) {
        await esperar(500);
        continue;
      }

      // Resolver un CAPTCHA nuevo
      console.log(`[${label}] Resolviendo CAPTCHA... (pool: ${pool.length}/${POOL_TARGET})`);
      const page = await context!.newPage();
      try {
        await irAFormulario(page, label);
        const ok = await resolverCaptcha(page, label);
        if (ok) {
          pool.push({ page, solvedAt: Date.now() });
          console.log(`[${label}] Token listo ✓ (pool: ${pool.length}/${POOL_TARGET})`);
        } else {
          await page.close().catch(() => {});
          console.log(`[${label}] CAPTCHA no resuelto — reintentando en 3s`);
          await esperar(3000);
        }
      } catch (e) {
        await page.close().catch(() => {});
        console.log(`[${label}] Error: ${(e as Error).message} — reintentando en 3s`);
        await esperar(3000);
      }
    } catch (e) {
      console.error(`[${label}] Error inesperado: ${(e as Error).message}`);
      await esperar(5000);
    }
  }
}

// ── Obtener página del pool (espera si está vacío) ─────────────────────────
async function getPoolPage(): Promise<PoolPage> {
  while (true) {
    // Descartar expirados del frente
    while (pool.length > 0 && Date.now() - pool[0].solvedAt > TOKEN_MAX_AGE_MS) {
      const p = pool.shift()!;
      await p.page.close().catch(() => {});
      console.log(`[POOL] Token expirado al dequeuar — descartado`);
    }
    if (pool.length > 0) return pool.shift()!;
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
  const { page, solvedAt } = await getPoolPage();
  const tokenAge = Date.now() - solvedAt;
  console.log(`[W${wid}][CONSULTA] ${tipo.toUpperCase()} ${cedula} — token del pool (${Math.round(tokenAge / 1000)}s)`);

  try {
    await page.locator("#cedulaTipo").selectOption(tipo);
    await page.locator("#cedulaInput").fill(cedula);

    // Verificar que el token sigue válido tras el AJAX de selectOption
    if (!await rcResuelto(page)) {
      throw new Error("Token del pool expiró tras selectOption");
    }

    await page.locator("#j_idt17").click();
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});

    const url = page.url();
    const { datos, resultado_raw } = await parsearPagina(page, cedula);
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
    await page.close().catch(() => {});
  }
}

// ── Cola compartida ────────────────────────────────────────────────────────
interface QueueItem {
  cedula: string;
  tipo: string;
  resolve: (v: any) => void;
  reject: (e: any) => void;
  intentos?: number;
}
const cola: QueueItem[] = [];
const enVuelo = new Map<string, Promise<any>>();

const CONSULTA_TIMEOUT_MS = parseInt(process.env.CONSULTA_TIMEOUT ?? "120") * 1000;

function encolarConsulta(cedula: string, tipo: string): Promise<any> {
  const key = `${tipo}:${cedula}`;
  const existente = enVuelo.get(key);
  if (existente) {
    console.log(`[DEDUP] ${cedula} ya en vuelo — reusando resultado`);
    return existente;
  }
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout: consulta excedió ${CONSULTA_TIMEOUT_MS / 1000}s`)), CONSULTA_TIMEOUT_MS)
  );
  const p = Promise.race([
    new Promise((resolve, reject) => { cola.push({ cedula, tipo, resolve, reject }); }),
    timeout,
  ]);
  enVuelo.set(key, p);
  p.then(() => enVuelo.delete(key), () => enVuelo.delete(key));
  return p;
}

function encolarLote(items: { cedula: string; tipo: string }[]): Promise<any>[] {
  return items.map(item => encolarConsulta(item.cedula, item.tipo));
}

function colaTotal(): number { return cola.length; }

// ── Worker loop ────────────────────────────────────────────────────────────
function startWorker(worker: WorkerState): void {
  const loop = async () => {
    while (true) {
      const item = cola.shift();
      if (!item) { await esperar(100); continue; }

      worker.busy = true;
      try {
        let result = await ejecutarConsulta(worker.id, item.cedula, item.tipo);
        if (result.datos.estado === "NO DETERMINADO") {
          console.log(`[W${worker.id}][RETRY] NO DETERMINADO — reintentando...`);
          await esperar(2000);
          result = await ejecutarConsulta(worker.id, item.cedula, item.tipo);
        }
        item.resolve(result);
      } catch (e) {
        item.intentos = (item.intentos ?? 0) + 1;
        if (item.intentos < MAX_INTENTOS) {
          console.log(`[W${worker.id}][RETRY] fallo intento ${item.intentos}/${MAX_INTENTOS} — reencolando: ${(e as Error).message}`);
          cola.push(item);
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

  // Cerrar tabs que extensiones abran automáticamente
  const browserCdp = await browser.newBrowserCDPSession();
  await browserCdp.send("Target.setDiscoverTargets", { discover: true });
  browserCdp.on("Target.targetCreated", async (event: any) => {
    const t = event.targetInfo;
    if (t.type === "page" && t.url !== "about:blank" && !t.url.includes("antecedentes.policia.gov.co")) {
      await browserCdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    }
  });

  // Crear workers
  for (let i = 0; i < MAX_WORKERS; i++) {
    workers.push({ id: i, busy: false });
  }

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

  // Esperar al menos 1 token en el pool antes de aceptar tráfico
  console.log("Esperando primer token del pool...");
  while (pool.length === 0) await esperar(500);
  console.log(`Pool listo — ${MAX_WORKERS} worker(s) arrancando.`);

  for (const w of workers) startWorker(w);
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
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    try {
      for (const f of readdirSync(SCREENSHOTS_DIR)) {
        const fp = path.join(SCREENSHOTS_DIR, f);
        if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp);
      }
    } catch {}
  }, 60 * 1000);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] Cerrando...`);
    server.close();
    await browser?.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  server.listen(SERVER_PORT, "127.0.0.1", () => {
    console.log(`\nServidor activo en http://127.0.0.1:${SERVER_PORT} — ${MAX_WORKERS} worker(s)`);
    console.log("  POST /consultar              { \"cedula\": \"1234567\", \"tipo\": \"cc\" }");
    console.log("  POST /consultar-lote         { \"cedulas\": [{\"cedula\": \"...\", \"tipo\": \"cc\"}] }");
    console.log("  POST /consultar-lote-stream  { \"cedulas\": [{\"cedula\": \"...\", \"tipo\": \"cc\"}] }  (NDJSON)");
    console.log("  GET  /health");
    console.log(`\n  Tipos válidos: ${TIPOS_VALIDOS.map(t => `"${t}"`).join(" | ")}\n`);
  });
})();
