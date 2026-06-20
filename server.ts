import { chromium, Page, Browser, BrowserContext } from "playwright";
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import * as http from "http";

const URL_SITE = "https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml";
const SCRIPT_DIR = "C:\\Users\\NyGsoft\\Desktop\\antecedente de policia";
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
    const bframeTemp = page.frames().find(f => f.url().includes("bframe"));
    if (bframeTemp) {
      const hasChallenge = await bframeTemp.locator(
        "#rc-imageselect, #rc-audiochallenge, #recaptcha-audio-button, #solver-button"
      ).isVisible().catch(() => false);
      if (hasChallenge) { console.log("[CAPTCHA] Challenge detectado."); break; }
    }
  }

  // Intentar Buster
  let bframe = page.frames().find(f => f.url().includes("bframe"));
  if (!passed && bframe) {
    console.log("[CAPTCHA] Buscando Buster...");
    for (let i = 0; i < 5 && !passed; i++) {
      bframe = page.frames().find(f => f.url().includes("bframe"));
      if (bframe) {
        const visible = await bframe.locator("#solver-button").isVisible().catch(() => false);
        if (visible) {
          console.log(`[CAPTCHA] Buster encontrado (${i + 1}s). Clickeando...`);
          await bframe.locator("#solver-button").click();
          for (let j = 0; j < 60 && !passed; j++) {
            await esperar(1000);
            if (await rcResuelto(page)) { console.log("[CAPTCHA] Buster resolvió."); passed = true; }
            if (j % 10 === 9) console.log(`[CAPTCHA] Buster trabajando... (${j + 1}s)`);
          }
          break;
        }
      }
      await esperar(1000);
    }
  }

  // Intentar audio challenge
  if (!passed) {
    bframe = page.frames().find(f => f.url().includes("bframe"));
    if (bframe) {
      const hasAudioBtn = await bframe.locator("#recaptcha-audio-button").isVisible().catch(() => false);
      if (hasAudioBtn) {
        console.log("[CAPTCHA] Cambiando a audio challenge...");
        await bframe.locator("#recaptcha-audio-button").click();
        await esperar(2000);
        bframe = page.frames().find(f => f.url().includes("bframe"));
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

      bframe = page.frames().find(f => f.url().includes("bframe"));
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
          const mp3Path = `${SCRIPT_DIR}\\captcha_audio.mp3`;
          writeFileSync(mp3Path, audioBuffer);
          try {
            const texto = execSync(
              `python "${SCRIPT_DIR}\\transcribe.py" file "${mp3Path}"`,
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
    if (!container) return null;
    const bolds = Array.from(container.querySelectorAll("b")).map(b => (b as HTMLElement).innerText.trim());
    const texto = container.innerText;
    const fechaMatch = texto.match(/siendo las\s+([\d:]+\s*[AP]M)\s+horas del\s+([\d\/]+)/i);
    return {
      bolds,
      texto,
      hora_consulta: fechaMatch ? fechaMatch[1].trim() : null,
      fecha_consulta: fechaMatch ? fechaMatch[2].trim() : null,
    };
  });

  if (!extraido) {
    const fallback = await page.locator("body").innerText();
    return {
      datos: { cedula_consultada: cedula, nombre: null, tiene_antecedentes: false, estado: "NO DETERMINADO", fecha_consulta: null, hora_consulta: null },
      resultado_raw: fallback.trim(),
    };
  }

  // bolds[0]=título informa, bolds[1]=cedula, bolds[2]=nombre, bolds[3]=estado
  const nombre = extraido.bolds[2] ?? null;
  const estadoRaw = extraido.bolds[3] ?? "";
  const sinPendientes = /NO TIENE ASUNTOS PENDIENTES/i.test(estadoRaw);
  const estado = estadoRaw || "NO DETERMINADO";
  const tiene_antecedentes = !sinPendientes && /ASUNTOS PENDIENTES/i.test(estadoRaw);

  return {
    datos: {
      cedula_consultada: cedula,
      nombre,
      tiene_antecedentes,
      estado,
      fecha_consulta: extraido.fecha_consulta,
      hora_consulta: extraido.hora_consulta,
    },
    resultado_raw: extraido.texto,
  };
}

// ── Consulta individual ───────────────────────────────────────────────────
async function ejecutarConsulta(cedula: string, tipo: string = "cc"): Promise<{ cedula: string; tipo: string; datos: DatosConsulta; resultado_raw: string; url: string }> {
  const page = mainPage!;

  // Navegar al formulario
  await irAFormulario(page);
  await page.locator("#cedulaTipo").selectOption(tipo);
  await page.locator("#cedulaInput").fill(cedula);
  console.log(`[CONSULTA] ${tipo.toUpperCase()} ${cedula}`);

  // reCAPTCHA — reutilizar si token < 110s
  const tokenAge = Date.now() - captchaResueltaAt;
  let captchaOk = false;
  if (tokenAge < 110_000 && captchaResueltaAt > 0) {
    captchaOk = await rcResuelto(page);
    if (captchaOk) console.log(`[CAPTCHA] Token reutilizado (${Math.round(tokenAge / 1000)}s).`);
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

  // Volver para próxima consulta
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});

  return { cedula, tipo, datos, resultado_raw, url };
}

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
    const result = await ejecutarConsulta(item.cedula, item.tipo);
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

  server.listen(SERVER_PORT, "127.0.0.1", () => {
    console.log(`\nServidor activo en http://127.0.0.1:${SERVER_PORT}`);
    console.log("  POST /consultar  { \"cedula\": \"1234567\", \"tipo\": \"cc\" }");
    console.log("  GET  /health\n");
  });
})();
