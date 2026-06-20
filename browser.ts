import { chromium, Page } from "playwright";
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import * as http from "http";

const URL_SITE = "https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml";
const SCRIPT_DIR = "C:\\Users\\NyGsoft\\Desktop\\antecedente de policia";
const CDP_PORT = 9223;

async function esperar(ms: number) {
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


async function run(): Promise<void> {
  // Verificar CDP — si no está activo, el usuario debe usar run.bat
  if (!(await cdpActivo(CDP_PORT))) {
    console.error(`\nERROR: CDP no activo en puerto ${CDP_PORT}.`);
    console.error("Usa run.bat para lanzar Chrome + consulta en un solo paso.\n");
    process.exit(1);
  }
  console.log("CDP activo — conectando...");

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctxList = browser.contexts();
  const context = ctxList.length > 0 ? ctxList[0] : await browser.newContext();

  // Parchar navigator.webdriver
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array;
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
  });

  const pages = context.pages();
  // Buscar tab del sitio; si no existe, usar el primero o crear uno
  let page = pages.find(p => p.url().includes("antecedentes.policia.gov.co")) ?? pages[0] ?? await context.newPage();
  // Cerrar tabs extra (extensiones o sesion restaurada)
  for (const p of pages) {
    if (p !== page) await p.close().catch(() => {});
  }

  // Activar Network via CDP para capturar audio
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");

  // Mapa: requestId → { url, requestId }
  const audioRequests: Map<string, string> = new Map();
  cdp.on("Network.responseReceived", (evt: any) => {
    const url: string = evt.response?.url || "";
    const ct: string = evt.response?.mimeType || evt.response?.headers?.["content-type"] || "";
    if (url.includes("payload") && (ct.includes("audio") || url.includes("audio.mp3"))) {
      console.log(`[CDP] Audio response capturado: ${url.substring(0, 80)}`);
      audioRequests.set(evt.requestId, url);
    }
  });

  console.log("Navegando al sitio...");
  await page.goto(URL_SITE, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Aceptar términos
  await page.locator('[id="aceptaOption:0"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[id="aceptaOption:0"]').click();
  console.log("Términos aceptados");

  await page.locator('[id="continuarBtn"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[id="continuarBtn"]').click();
  console.log("Continuar clicado");

  // Llenar formulario
  await page.locator("#cedulaInput").waitFor({ state: "visible", timeout: 15000 });
  await page.locator("#cedulaTipo").selectOption("cc");
  await page.locator("#cedulaInput").fill("1007601001");
  console.log("Formulario: CC 1007601001");

  // Click reCAPTCHA checkbox
  const recaptchaFrame = page.frameLocator('iframe[title="reCAPTCHA"]');
  await recaptchaFrame.locator("#recaptcha-anchor > div:first-child").waitFor({ state: "visible", timeout: 15000 });
  await recaptchaFrame.locator("#recaptcha-anchor > div:first-child").click();
  console.log("reCAPTCHA checkbox clickeado...");

  // Helper: detecta reCAPTCHA resuelto por múltiples métodos
  async function rcResuelto(): Promise<boolean> {
    // Método 1: token en host page DOM
    const token = await page.evaluate(() => {
      const t = document.getElementById("g-recaptcha-response") as HTMLTextAreaElement;
      return t?.value ?? "";
    }).catch(() => "");
    if (token.length > 50) { console.log(`  [RC] token detectado (${token.length} chars)`); return true; }

    // Método 2: evaluate dentro del iframe anchor (más confiable que frameLocator en CDP)
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
      console.log(`  [RC] aria-checked=${state.ariaChecked} checkedClass=${state.hasCheckedClass}`);
      if (state.ariaChecked === "true" || state.hasCheckedClass) return true;
    }
    return false;
  }

  // Poll hasta 8s — sale apenas pase O aparezca challenge
  let passed = false;
  for (let i = 0; i < 16 && !passed; i++) {
    await esperar(500);
    if (await rcResuelto()) {
      console.log("reCAPTCHA pasó sin challenge — consultando directamente...");
      passed = true;
      break;
    }
    // Si el challenge ya está abierto (bframe con botones visibles), salir del poll
    const bframeTemp = page.frames().find(f => f.url().includes("bframe"));
    if (bframeTemp) {
      const hasChallenge = await bframeTemp.locator("#recaptcha-audio-button, #solver-button").isVisible().catch(() => false);
      if (hasChallenge) { console.log("Challenge detectado — saliendo del poll."); break; }
    }
    if (i % 4 === 3) console.log(`  Poll ${i + 1}/16...`);
  }

  // PASO 1: Cambiar a audio challenge + intentar Buster inmediato
  let bframe = page.frames().find(f => f.url().includes("bframe"));
  if (!passed && bframe) {
    // Cambiar a audio mode si aún está en imagen
    const hasAudioBtn = await bframe.locator("#recaptcha-audio-button").isVisible().catch(() => false);
    if (hasAudioBtn) {
      console.log("Cambiando a audio challenge...");
      await bframe.locator("#recaptcha-audio-button").click();
      await esperar(2000);
    }

    // Verificar Buster inmediato (max 5s)
    console.log("Buscando Buster (#solver-button)...");
    let busterFound = false;
    for (let i = 0; i < 5; i++) {
      bframe = page.frames().find(f => f.url().includes("bframe"));
      if (bframe) {
        const visible = await bframe.locator("#solver-button").isVisible().catch(() => false);
        if (visible) {
          console.log(`Buster encontrado (${i + 1}s). Clickeando...`);
          await bframe.locator("#solver-button").click();
          busterFound = true;
          // Esperar resolución (hasta 60s)
          for (let j = 0; j < 60; j++) {
            await esperar(1000);
            if (await rcResuelto()) { console.log("Buster resolvió."); passed = true; break; }
            if (j % 10 === 9) console.log(`  Buster trabajando... (${j + 1}s)`);
          }
          break;
        }
      }
      await esperar(1000);
    }
    if (!busterFound && !passed) console.log("Buster no disponible — fallback audio.");
  }

  // INTENTO 3: Capturar audio via CDP si Buster no funcionó
  if (!passed) {
    console.log("Buster no inyectó. Intentando captura audio CDP...");
    bframe = page.frames().find(f => f.url().includes("bframe"));
    if (bframe) {
      // Click botón descarga directa (div[6]) para desencadenar audio sin reproducir
      const btnDescarga = bframe.locator("xpath=/html/body/div/div/div[8]/div[2]/div[1]/div[1]/div[6]//button");
      const hasDescarga = await btnDescarga.isVisible().catch(() => false);
      console.log(`Botón descarga directa visible: ${hasDescarga}`);
      if (hasDescarga) {
        await btnDescarga.click().catch(() => {});
        await esperar(2000);
      }

      // Buscar enlace de descarga
      const downloadHref = await bframe.locator(".rc-audiochallenge-tdownload-link, a[href*='payload']").getAttribute("href").catch(() => null);
      console.log(`Download href: ${downloadHref ? downloadHref.substring(0, 80) : "undefined"}`);

      // Esperar que CDP capture el audio (hasta 8s)
      let requestId: string | null = null;
      for (let i = 0; i < 16; i++) {
        if (audioRequests.size > 0) {
          requestId = [...audioRequests.keys()][audioRequests.size - 1];
          break;
        }
        await esperar(500);
      }

      let audioBuffer: Buffer | null = null;

      // Método 1: CDP getResponseBody
      if (requestId) {
        try {
          const resp = await cdp.send("Network.getResponseBody", { requestId });
          if (resp.body && resp.body.length > 10) {
            audioBuffer = Buffer.from(resp.body, resp.base64Encoded ? "base64" : "utf-8");
            console.log(`Audio via CDP getResponseBody: ${audioBuffer.length}b`);
          }
        } catch (e) {
          console.log("CDP getResponseBody falló:", (e as Error).message);
        }
      }

      // Método 2: fetch desde bframe con downloadHref
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
            console.log(`Audio via iframe fetch: ${audioBuffer.length}b`);
          }
        } catch (e) {
          console.log("iframe fetch falló:", (e as Error).message);
        }
      }

      // Procesar audio si lo tenemos
      if (audioBuffer && audioBuffer.length > 100) {
        const mp3Path = `${SCRIPT_DIR}\\captcha_audio.mp3`;
        writeFileSync(mp3Path, audioBuffer);
        console.log(`Audio guardado: ${mp3Path} (${audioBuffer.length}b)`);
        try {
          const texto = execSync(
            `python "${SCRIPT_DIR}\\transcribe.py" file "${mp3Path}"`,
            { encoding: "utf-8", timeout: 120000 }
          ).trim();
          console.log("Transcripción:", texto);
          if (texto.length > 0) {
            await bframe.locator("#audio-response").fill(texto);
            await bframe.locator("#recaptcha-verify-button").click();
            await esperar(3000);
            passed = true;
          }
        } catch (e) {
          console.log("Error transcripción:", (e as Error).message);
        }
      } else {
        console.log("Audio bloqueado por Google (0 bytes). Google bloquea descargas de audio desde este IP.");
      }
    }
  }

  // Verificación final — captura pases que el poll no detectó
  if (!passed && await rcResuelto()) {
    console.log("reCAPTCHA ya resuelto (detección tardía). Consultando...");
    passed = true;
  }

  // FALLBACK: manual
  if (!passed) {
    console.log("\n⚠️  El captcha no pudo resolverse automáticamente.");
    console.log("   El navegador está abierto. Resuelve el reCAPTCHA manualmente.");
    console.log("   NOTA: Si ves 'Buster' en el navegador, úsalo desde allí.");
    console.log("   Presiona ENTER aquí cuando el captcha esté resuelto...\n");
    const { createInterface } = await import("readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>(r => rl.question("", () => { rl.close(); r(); }));
    for (let i = 0; i < 20; i++) {
      if (await rcResuelto()) { passed = true; break; }
      await esperar(1000);
    }
  }

  if (!passed) {
    console.log("Captcha no resuelto. Abortando.");
    await browser.close();
    return;
  }

  // Enviar formulario
  await page.locator("#j_idt17").click();
  console.log("Consultando...");

  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  const result = await page.locator("body").innerText();
  console.log(`\nURL: ${page.url()}`);
  console.log("\n=== RESULTADO ===");
  console.log(result.trim());

  // Volver atrás (botón ← del navegador) para nueva consulta
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
  console.log(`\nVolvió a: ${page.url()}`);

  await browser.close();
}

run().catch(console.error);
