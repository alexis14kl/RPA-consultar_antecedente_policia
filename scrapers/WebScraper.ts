// scrapers/WebScraper.ts — CLASE BASE (motor genérico de reCAPTCHA v2).
// Contiene todo lo NO específico de un sitio: click humano del checkbox, detección de
// challenge, Buster, y el fallback de audio (captura por CDP → Whisper → verificar).
// La navegación al formulario (irAFormulario) es ABSTRACTA: la define cada subclase.
import { Page, Frame } from "playwright";
import path from "path";
import { writeFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { CdpConnection } from "../core/CdpConnection";
import { HumanMouse } from "../core/HumanMouse";
import { esperar } from "../core/util";

const execFileAsync = promisify(execFile);

export interface WebScraperConfig {
  scriptDir: string;
  python: string;
  audioMaxAttempts: number;
  captchaTimeoutMs: number;
  captchaTimeoutBlockedMs: number;
  useBuster: boolean;   // Buster oye español con oídos ingleses y en Chrome real (UC) ni existe.
}

// Backoff ante bloqueos repetidos de Google (pausa si N bloqueos en <60s).
class RateLimiter {
  private blocked = 0;
  private windowStart = 0;
  private readonly WINDOW_MS = 60_000;
  private readonly MAX_BLOCKED = 3;
  private readonly PAUSE_MS = 30_000;
  record() {
    const now = Date.now();
    if (now - this.windowStart > this.WINDOW_MS) { this.blocked = 0; this.windowStart = now; }
    this.blocked++;
  }
  reset() { this.blocked = 0; }
  async waitIfLimited() {
    if (this.blocked >= this.MAX_BLOCKED) {
      console.log(`[POOL] ${this.blocked} bloqueos en <60s — pausando ${this.PAUSE_MS / 1000}s`);
      await esperar(this.PAUSE_MS);
      this.blocked = 0;
      this.windowStart = Date.now();
    }
  }
}

export abstract class WebScraper {
  private readonly rateLimit = new RateLimiter();

  constructor(protected readonly cdp: CdpConnection, protected readonly cfg: WebScraperConfig) {}

  /** Navega hasta dejar el formulario con el reCAPTCHA visible. Específico del sitio. */
  protected abstract irAFormulario(page: Page, hm: HumanMouse, label: string): Promise<void>;

  /** Flujo completo que produce un token: navegar + resolver el captcha. Lo usa el TokenPool. */
  async solveOne(page: Page, hm: HumanMouse, label: string): Promise<boolean> {
    await this.irAFormulario(page, hm, label);
    return this.resolverCaptcha(page, hm, label);
  }

  /** ¿El reCAPTCHA está resuelto? (token en g-recaptcha-response o checkbox verde). */
  async rcResuelto(page: Page): Promise<boolean> {
    const token = await page.evaluate(() => {
      const t = document.getElementById("g-recaptcha-response") as HTMLTextAreaElement;
      return t?.value ?? "";
    }).catch(() => "");
    if (token.length > 50) return true;

    // Fallback: aria-checked del anchor vía frameLocator. NO usar page.frames()+url():
    // el reCAPTCHA es un OOPIF y sobre connectOverCDP su frame.url() llega VACÍA, así que
    // buscar el frame por url nunca lo encuentra. frameLocator lo resuelve por el <iframe>.
    const aria = await page.frameLocator('iframe[title="reCAPTCHA"]')
      .locator("#recaptcha-anchor")
      .getAttribute("aria-checked", { timeout: 1500 })
      .catch(() => null);
    return aria === "true";
  }

  protected async getBframe(page: Page): Promise<Frame | null> {
    const h = await page.locator('iframe[src*="bframe"]').elementHandle().catch(() => null);
    if (!h) return null;
    return await h.contentFrame().catch(() => null);
  }

  // engine: whisper (local) | google | wit (motores de Buster) | auto (cadena completa).
  private async transcribir(mp3Path: string, engine = "auto"): Promise<string> {
    const { stdout } = await execFileAsync(
      this.cfg.python,
      [path.join(this.cfg.scriptDir, "transcribe.py"), "file", mp3Path, engine],
      { encoding: "utf-8", timeout: 120000 },
    );
    return stdout.trim();
  }

  /** Motor del reCAPTCHA: checkbox humano → (verde | Buster | audio+Whisper). */
  async resolverCaptcha(page: Page, hm: HumanMouse, label: string): Promise<boolean> {
    await this.rateLimit.waitIfLimited();
    let audioBloqueado = false;
    const recaptchaFrame = page.frameLocator('iframe[title="reCAPTCHA"]');
    await recaptchaFrame.locator("#recaptcha-anchor > div:first-child").waitFor({ state: "visible", timeout: 15000 });
    // Click HUMANO del checkbox (aproximación con curva + hover + presión real).
    await hm.click(recaptchaFrame.locator("#recaptcha-anchor > div:first-child"));
    console.log(`[${label}][CAPTCHA] Checkbox clickeado (humano, perfil: ${hm.profile.name})...`);

    let passed = false;
    for (let i = 0; i < 16 && !passed; i++) {
      await esperar(500);
      if (await this.rcResuelto(page)) { console.log(`[${label}][CAPTCHA] Pasó sin challenge.`); passed = true; break; }
      const bframeTemp = await this.getBframe(page);
      if (bframeTemp) {
        const hasChallenge = await bframeTemp.locator(
          "#rc-imageselect, #rc-audiochallenge, #recaptcha-audio-button, #solver-button"
        ).isVisible().catch(() => false);
        if (hasChallenge) { console.log(`[${label}][CAPTCHA] Challenge detectado.`); break; }
      }
    }

    // Buster: solo si USE_BUSTER=1 (y con extensión cargada). Con UC (Chrome real) NO hay
    // Buster: el `.help-button-holder` es el botón NATIVO del reCAPTCHA → clickearlo pierde
    // ~20s en vano. Por eso, apagado, saltamos directo a audio+Whisper.
    let bframe: Frame | null = null;
    if (this.cfg.useBuster && !passed) {
      let hasHolder = false;
      for (let w = 0; w < 15 && !hasHolder; w++) {
        await esperar(1000);
        bframe = await this.getBframe(page);
        if (bframe) hasHolder = (await bframe.locator(".help-button-holder").count().catch(() => 0)) > 0;
      }
      if (bframe) {
        const holder = bframe.locator(".help-button-holder");
        if (hasHolder) {
          console.log(`[${label}][CAPTCHA] Clic en ícono Buster...`);
          await holder.click({ force: true, timeout: 8000 }).catch((e) => console.log(`[${label}][CAPTCHA] click Buster:`, (e as Error).message));
          for (let j = 0; j < 25 && !passed; j++) {
            await esperar(1000);
            if (await this.rcResuelto(page)) { console.log(`[${label}][CAPTCHA] Buster resolvió.`); passed = true; }
            if (j % 10 === 9) console.log(`[${label}][CAPTCHA] Buster trabajando... (${j + 1}s)`);
          }
        }
      }
    }

    if (!passed) {
      bframe = await this.getBframe(page);
      if (bframe) {
        const audioBtn = bframe.locator("#recaptcha-audio-button");
        const hasAudioBtn = await audioBtn.isVisible().catch(() => false);
        if (hasAudioBtn) {
          const disabled = await audioBtn.evaluate((el: any) => el.disabled || el.classList.contains("rc-button-disabled")).catch(() => false);
          if (!disabled) {
            console.log(`[${label}][CAPTCHA] Cambiando a audio challenge...`);
            await audioBtn.click();
            await esperar(2000);
            bframe = await this.getBframe(page);
          }
        }

        const cdpSession = await this.cdp.newCDPSession(page);
        await cdpSession.send("Network.enable");
        const audioRequests: Map<string, string> = new Map();
        cdpSession.on("Network.responseReceived", (evt: any) => {
          const url: string = evt.response?.url || "";
          const ct: string = evt.response?.mimeType || evt.response?.headers?.["content-type"] || "";
          if (url.includes("payload") && (ct.includes("audio") || url.includes("audio.mp3"))) audioRequests.set(evt.requestId, url);
        });

        let capturaVacia = 0;
        // Fallback de motor por intento (cada intento recarga un audio FRESCO): Whisper
        // primero; si reCAPTCHA lo rechaza, el próximo audio va a Google STT (el motor de
        // Buster) y, si hay WIT_AI_TOKEN, a Wit.ai. Así "Whisper falla → Buster".
        const engines = ["whisper", "google", ...(process.env.WIT_AI_TOKEN ? ["wit"] : [])];
        for (let intento = 0; intento < this.cfg.audioMaxAttempts && !passed; intento++) {
          const engine = engines[Math.min(intento, engines.length - 1)];
          bframe = await this.getBframe(page);
          if (!bframe) break;

          const reloadBtn = bframe.locator("#recaptcha-reload-button");
          const errVisible = await bframe.locator(".rc-audiochallenge-error-message").isVisible().catch(() => false);
          if ((intento > 0 || errVisible) && await reloadBtn.isVisible().catch(() => false)) {
            console.log(`[${label}][CAPTCHA] Pidiendo audio nuevo (intento ${intento + 1}/${this.cfg.audioMaxAttempts})...`);
            audioRequests.clear();
            await reloadBtn.click().catch(() => {});
            await esperar(1500);
            bframe = await this.getBframe(page);
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
            } catch (e) { console.log(`[${label}][CAPTCHA] CDP getResponseBody falló:`, (e as Error).message); }
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
            } catch (e) { console.log(`[${label}][CAPTCHA] iframe fetch falló:`, (e as Error).message); }
          }

          if (audioBuffer && audioBuffer.length > 100) {
            capturaVacia = 0;
            const mp3Path = path.join(this.cfg.scriptDir, `captcha_audio_${label.replace(/[^a-z0-9]/gi, "_")}.mp3`);
            await writeFile(mp3Path, audioBuffer);
            try {
              const texto = await this.transcribir(mp3Path, engine);
              console.log(`[${label}][CAPTCHA] Transcripción (${engine}):`, texto);
              if (texto.length > 0) {
                await bframe.locator("#audio-response").fill(texto);
                await bframe.locator("#recaptcha-verify-button").click();
                await esperar(3000);
                passed = await this.rcResuelto(page);
                if (passed) { console.log(`[${label}][CAPTCHA] ${engine} resolvió el audio.`); break; }
                console.log(`[${label}][CAPTCHA] ${engine} incorrecto — próximo audio con otro motor.`);
              }
            } catch (e) { console.log(`[${label}][CAPTCHA] Error transcripción (${engine}):`, (e as Error).message); }
          } else {
            capturaVacia++;
            console.log(`[${label}][CAPTCHA] Audio no capturado (${capturaVacia}).`);
            if (capturaVacia >= 2) {
              console.log(`[${label}][CAPTCHA] Audio bloqueado por Google (0 bytes).`);
              audioBloqueado = true;
              this.rateLimit.record();
              break;
            }
          }
        }
        await cdpSession.detach().catch(() => {});
      }
    }

    if (!passed && await this.rcResuelto(page)) passed = true;

    if (!passed) {
      const maxWait = audioBloqueado ? this.cfg.captchaTimeoutBlockedMs : this.cfg.captchaTimeoutMs;
      console.log(`[${label}][CAPTCHA] Esperando resolución... timeout ${maxWait / 1000}s`);
      let waited = 0;
      while (waited < maxWait && !passed) {
        await esperar(2000);
        waited += 2000;
        if (await this.rcResuelto(page)) { passed = true; break; }
      }
    }

    if (passed) this.rateLimit.reset();
    return passed;
  }
}
