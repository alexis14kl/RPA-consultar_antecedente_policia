import { chromium, Page, Browser, BrowserContext, Frame } from "playwright";
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import * as http from "http";
import * as path from "path";

const URL_SITE = "https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml";
// Carpeta del proyecto (donde vive este script) — multiplataforma Win/Mac/Linux.
const SCRIPT_DIR = __dirname;
// En Windows el binario es "python"; en Mac/Linux es "python3". Override con env PYTHON.
const PYTHON = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const CDP_PORT = 9223;
const SERVER_PORT = parseInt(process.env.PORT ?? "3000");
const CAPTCHA_TIMEOUT_MS = parseInt(process.env.CAPTCHA_TIMEOUT ?? "120") * 1000;

// ── Estado global del browser ──────────────────────────────────────────────
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let mainPage: Page | null = null;
let captchaResueltaAt: number = 0;

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

// Garantiza que Chrome tenga al menos una pestaña antes de conectar por CDP.
// Si Chrome quedó sin pestañas (p.ej. tras un browser.close() de browser.ts),
// connectOverCDP falla con "Browser context management is not supported".
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

// ── Inicializar browser (una vez al arrancar) ──────────────────────────────
async function initBrowser(): Promise<void> {
  if (!(await cdpActivo(CDP_PORT))) {
    throw new Error(`CDP no activo en puerto ${CDP_PORT}. Ejecuta start-server.bat.`);
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

  const pages = context.pages();
  mainPage = pages.find(p => p.url().includes("antecedentes.policia.gov.co")) ?? pages[0] ?? await context.newPage();
  for (const p of pages) {
    if (p !== mainPage) await p.close().catch(() => {});
  }

  // Cerrar tabs nuevas que extensiones abran
  const browserCdp = await browser.newBrowserCDPSession();
  await browserCdp.send("Target.setDiscoverTargets", { discover: true });
  browserCdp.on("Target.targetCreated", async (event: any) => {
    const t = event.targetInfo;
    if (t.type === "page" && !t.url.includes("antecedentes.policia.gov.co")) {
      await browserCdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    }
  });

  console.log("Browser inicializado.");
}

// Obtiene el Frame del challenge (bframe) de reCAPTCHA. El bframe corre OOPIF,
// por lo que page.frames() no lo lista de forma fiable; se accede vía el
// elemento <iframe src*="bframe"> + contentFrame().
async function getBframe(page: Page): Promise<Frame | null> {
  const h = await page.locator('iframe[src*="bframe"]').elementHandle().catch(() => null);
  if (!h) return null;
  return await h.contentFrame().catch(() => null);
}

// ── Resolver reCAPTCHA ─────────────────────────────────────────────────────
async function resolverCaptcha(page: Page): Promise<boolean> {
  // Click checkbox
  const recaptchaFrame = page.frameLocator('iframe[title="reCAPTCHA"]');
  await recaptchaFrame.locator("#recaptcha-anchor > div:first-child").waitFor({ state: "visible", timeout: 15000 });
  await recaptchaFrame.locator("#recaptcha-anchor > div:first-child").click();
  console.log("[CAPTCHA] Checkbox clickeado...");

  // Poll 8s — sale si pasa o si aparece challenge
  let passed = false;
  for (let i = 0; i < 16 && !passed; i++) {
    await esperar(500);
    if (await rcResuelto(page)) { console.log("[CAPTCHA] Pasó sin challenge."); passed = true; break; }
    const bframeTemp = await getBframe(page);
    if (bframeTemp) {
      const hasChallenge = await bframeTemp.locator(
        "#rc-imageselect, #rc-audiochallenge, #recaptcha-audio-button, #solver-button"
      ).isVisible().catch(() => false);
      if (hasChallenge) { console.log("[CAPTCHA] Challenge detectado."); break; }
    }
  }

  // Intentar Buster — su ícono es un overlay de extensión sobre .help-button-holder
  // dentro del bframe (NO es #solver-button, ni vive en el DOM del bframe). El bframe
  // corre OOPIF, así que se accede con getBframe() (contentFrame); se clic con
  // force:true porque el holder no pasa el chequeo de "actionability" de Playwright
  // y Playwright dispara el click en el centro del elemento (sin coordenadas fijas).
  let bframe: Frame | null = null;
  if (!passed) {
    bframe = await getBframe(page);
    if (bframe) {
      const holder = bframe.locator(".help-button-holder");
      const hasHolder = (await holder.count().catch(() => 0)) > 0;
      if (hasHolder) {
        console.log("[CAPTCHA] Clic en ícono Buster (.help-button-holder)...");
        await holder.click({ force: true, timeout: 8000 }).catch((e) => console.log("[CAPTCHA] click Buster:", (e as Error).message));
        for (let j = 0; j < 25 && !passed; j++) {
          await esperar(1000);
          if (await rcResuelto(page)) { console.log("[CAPTCHA] Buster resolvió."); passed = true; }
          if (j % 10 === 9) console.log(`[CAPTCHA] Buster trabajando... (${j + 1}s)`);
        }
      } else {
        console.log("[CAPTCHA] .help-button-holder no presente — Buster no disponible.");
      }
    }
  }

  // Intentar audio challenge
  if (!passed) {
    bframe = await getBframe(page);
    if (bframe) {
      const audioBtn = bframe.locator("#recaptcha-audio-button");
      const hasAudioBtn = await audioBtn.isVisible().catch(() => false);
      if (hasAudioBtn) {
        const disabled = await audioBtn.evaluate((el: any) => el.disabled || el.classList.contains("rc-button-disabled")).catch(() => false);
        if (disabled) {
          console.log("[CAPTCHA] Audio button deshabilitado (rate limit Google). Saltando audio.");
        } else {
          console.log("[CAPTCHA] Cambiando a audio challenge...");
          await audioBtn.click();
          await esperar(2000);
          bframe = await getBframe(page);
        }
      }

      // Capturar audio via CDP
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
          if (audioRequests.size > 0) {
            requestId = [...audioRequests.keys()][audioRequests.size - 1];
            break;
          }
          await esperar(500);
        }

        let audioBuffer: Buffer | null = null;

        if (requestId) {
          try {
            const resp = await cdpSession.send("Network.getResponseBody", { requestId });
            if (resp.body && resp.body.length > 10) {
              audioBuffer = Buffer.from(resp.body, resp.base64Encoded ? "base64" : "utf-8");
              console.log(`[CAPTCHA] Audio CDP: ${audioBuffer.length}b`);
            }
          } catch (e) {
            console.log("[CAPTCHA] CDP getResponseBody falló:", (e as Error).message);
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
              let s = "";
              u8.forEach(b => (s += String.fromCharCode(b)));
              return btoa(s);
            }, downloadHref);
            if (b64.length > 10) {
              audioBuffer = Buffer.from(b64, "base64");
              console.log(`[CAPTCHA] Audio iframe fetch: ${audioBuffer.length}b`);
            }
          } catch (e) {
            console.log("[CAPTCHA] iframe fetch falló:", (e as Error).message);
          }
        }

        if (audioBuffer && audioBuffer.length > 100) {
          const mp3Path = path.join(SCRIPT_DIR, "captcha_audio.mp3");
          writeFileSync(mp3Path, audioBuffer);
          try {
            const texto = execSync(
              `"${PYTHON}" "${path.join(SCRIPT_DIR, "transcribe.py")}" file "${mp3Path}"`,
              { encoding: "utf-8", timeout: 120000 }
            ).trim();
            console.log("[CAPTCHA] Transcripción:", texto);
            if (texto.length > 0) {
              await bframe.locator("#audio-response").fill(texto);
              await bframe.locator("#recaptcha-verify-button").click();
              await esperar(3000);
              passed = await rcResuelto(page);
            }
          } catch (e) {
            console.log("[CAPTCHA] Error transcripción:", (e as Error).message);
          }
        } else {
          console.log("[CAPTCHA] Audio bloqueado por Google (0 bytes).");
        }

        await cdpSession.detach().catch(() => {});
      }
    }
  }

  // Detección tardía
  if (!passed && await rcResuelto(page)) {
    console.log("[CAPTCHA] Resuelto (detección tardía).");
    passed = true;
  }

  // Timeout — esperar que Buster/extensión resuelva en background
  if (!passed) {
    console.log(`[CAPTCHA] Esperando resolución... timeout ${CAPTCHA_TIMEOUT_MS / 1000}s`);
    let waited = 0;
    while (waited < CAPTCHA_TIMEOUT_MS && !passed) {
      await esperar(2000);
      waited += 2000;
      if (await rcResuelto(page)) {
        console.log(`[CAPTCHA] Resuelto en background (${waited / 1000}s).`);
        passed = true;
        break;
      }
      if (waited % 20000 === 0) console.log(`[CAPTCHA] Esperando... ${waited / 1000}s/${CAPTCHA_TIMEOUT_MS / 1000}s`);
    }
  }

  if (passed) captchaResueltaAt = Date.now();
  return passed;
}

// ── Ir a formulario y aceptar términos ────────────────────────────────────
async function irAFormulario(page: Page): Promise<void> {
  await page.goto(URL_SITE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator('[id="aceptaOption:0"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[id="aceptaOption:0"]').click();
  await page.locator('[id="continuarBtn"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[id="continuarBtn"]').click();
  await page.locator("#cedulaInput").waitFor({ state: "visible", timeout: 15000 });
  console.log("[NAV] Formulario listo.");
}

// ── Parser de resultado ───────────────────────────────────────────────────
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
    return {
      datos: { cedula_consultada: cedula, nombre: null, tiene_antecedentes: false, estado: "NO DETERMINADO", fecha_consulta: null, hora_consulta: null },
      resultado_raw: extraido.texto.trim(),
    };
  }

  const texto = extraido.texto;

  // Parseo robusto desde el texto: NO depende de la posición de los <b>, que se
  // corre cuando el resultado no trae nombre (p.ej. cédula sin registro).
  const nombreMatch = texto.match(/Apellidos y Nombres:\s*(.+)/i);
  const nombre = nombreMatch ? nombreMatch[1].trim() : null;

  // Línea de resultado: la primera que menciona "ASUNTOS PENDIENTES" y NO forma
  // parte del descargo legal (que repite la frase entre comillas).
  const estadoLinea = texto
    .split("\n")
    .map(l => l.trim())
    .find(l => /ASUNTOS PENDIENTES/i.test(l) && !/leyenda|aplica para|conformidad|art[íi]culo|sentencia/i.test(l));
  const estado = estadoLinea || "NO DETERMINADO";
  const sinPendientes = /NO TIENE ASUNTOS PENDIENTES/i.test(estado);
  const tiene_antecedentes = /ASUNTOS PENDIENTES/i.test(estado) && !sinPendientes;

  return {
    datos: {
      cedula_consultada: cedula,
      nombre,
      tiene_antecedentes,
      estado,
      fecha_consulta: extraido.fecha_consulta,
      hora_consulta: extraido.hora_consulta,
    },
    resultado_raw: texto,
  };
}

// ── Consulta individual ───────────────────────────────────────────────────
async function ejecutarConsulta(cedula: string, tipo: string = "cc"): Promise<{ cedula: string; tipo: string; datos: DatosConsulta; resultado_raw: string; url: string }> {
  const page = mainPage!;

  // Esperar goBack de consulta anterior antes de empezar
  await goBackPending;

  // Verificar si ya estamos en el formulario con token vivo (evitar goto innecesario)
  const tokenAge = Date.now() - captchaResueltaAt;
  const tokenFresco = captchaResueltaAt > 0 && tokenAge < 110_000;
  let enFormulario = false;

  if (tokenFresco) {
    enFormulario = await page.locator("#cedulaInput").isVisible({ timeout: 2000 }).catch(() => false);
    if (enFormulario) console.log(`[CAPTCHA] Token fresco (${Math.round(tokenAge / 1000)}s) — reutilizando sesión.`);
  }

  if (!enFormulario) {
    await irAFormulario(page);
  }

  await page.locator("#cedulaTipo").selectOption(tipo);
  await page.locator("#cedulaInput").fill(cedula);
  console.log(`[CONSULTA] ${tipo.toUpperCase()} ${cedula}`);

  // Captcha — solo resolver si el token no está activo
  let captchaOk = false;
  if (enFormulario && tokenFresco) {
    captchaOk = await rcResuelto(page);
    if (captchaOk) console.log(`[CAPTCHA] Token reutilizado OK.`);
  }
  if (!captchaOk) {
    captchaOk = await resolverCaptcha(page);
  }
  if (!captchaOk) throw new Error("reCAPTCHA no resuelto dentro del timeout.");

  // Enviar formulario
  await page.locator("#j_idt17").click();
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});

  const url = page.url();
  const { datos, resultado_raw } = await parsearPagina(page, cedula);
  console.log(`[CONSULTA] OK — ${datos.nombre ?? "?"} | ${datos.estado}`);

  // goBack en background — respuesta HTTP se envía inmediatamente
  goBackPending = page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).then(() => {}).catch(() => {});

  return { cedula, tipo, datos, resultado_raw, url };
}

// goBack en background — se completa antes de que empiece la siguiente consulta
let goBackPending: Promise<void> = Promise.resolve();

// ── Cola serializada ───────────────────────────────────────────────────────
interface QueueItem {
  cedula: string;
  tipo: string;
  resolve: (v: any) => void;
  reject: (e: any) => void;
}
const cola: QueueItem[] = [];
let procesando = false;

async function procesarCola() {
  if (procesando || cola.length === 0) return;
  procesando = true;
  const item = cola.shift()!;
  try {
    let result = await ejecutarConsulta(item.cedula, item.tipo);
    if (result.datos.estado === "NO DETERMINADO") {
      console.log(`[RETRY] Resultado NO DETERMINADO — reintentando...`);
      await new Promise(r => setTimeout(r, 3000));
      result = await ejecutarConsulta(item.cedula, item.tipo);
    }
    item.resolve(result);
  } catch (e) {
    item.reject(e);
  } finally {
    procesando = false;
    procesarCola();
  }
}

function encolarConsulta(cedula: string, tipo: string): Promise<any> {
  return new Promise((resolve, reject) => {
    cola.push({ cedula, tipo, resolve, reject });
    procesarCola();
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
    return jsonResp(res, 200, { ok: true, cdp: CDP_PORT, en_cola: cola.length, procesando });
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

  // ── Keep-alive sesión JSF (cada 5 min, actúa si hay 25+ min de inactividad) ──
  const KEEPALIVE_INTERVAL = 5 * 60 * 1000;
  const KEEPALIVE_IDLE_THRESHOLD = 25 * 60 * 1000;
  setInterval(async () => {
    if (procesando || cola.length > 0) return;
    const idle = Date.now() - (captchaResueltaAt || Date.now());
    if (idle < KEEPALIVE_IDLE_THRESHOLD) return;
    try {
      if (!mainPage) return;
      await mainPage.evaluate(() =>
        fetch("https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml", {
          method: "HEAD",
          credentials: "include",
        }).catch(() => {})
      );
      console.log("[KEEPALIVE] Sesión JSF renovada.");
    } catch (e) {}
  }, KEEPALIVE_INTERVAL);

  server.listen(SERVER_PORT, "127.0.0.1", () => {
    console.log(`\nServidor activo en http://127.0.0.1:${SERVER_PORT}`);
    console.log("  POST /consultar  { \"cedula\": \"1234567\", \"tipo\": \"cc\" }");
    console.log("  GET  /health\n");
  });
})();
