// scrapers/AntecedentesScraper.ts — SUBCLASE (sujeto real, específico policía Colombia).
// Hereda el motor de captcha de WebScraper; define la navegación del sitio, la consulta
// (llenar cédula → submit → parsear) y el parseo del resultado. Implementa IScraper.
import { Page } from "playwright";
import path from "path";
import { CdpConnection } from "../core/CdpConnection";
import { HumanMouse } from "../core/HumanMouse";
import { Mutex } from "../core/Mutex";
import { TokenPool } from "../core/TokenPool";
import { esperar } from "../core/util";
import { WebScraper, WebScraperConfig } from "./WebScraper";
import { IScraper } from "./IScraper";

export interface AntecedentesConfig extends WebScraperConfig {
  urlSite: string;
  screenshotsDir: string;
  baseUrl: string;
  maxIntentos: number;
}

export interface DatosConsulta {
  cedula_consultada: string;
  nombre: string | null;
  tiene_antecedentes: boolean;
  estado: string;
  fecha_consulta: string | null;
  hora_consulta: string | null;
}

export class AntecedentesScraper extends WebScraper implements IScraper {
  private pool!: TokenPool;                 // inyectado tras construir (setPool)
  private readonly mutex = new Mutex();     // serializa el submit contra la sesión JSF
  private reqCounter = 0;

  constructor(cdp: CdpConnection, protected readonly cfg: AntecedentesConfig) { super(cdp, cfg); }

  /** El TokenPool se crea DESPUÉS (necesita solveOne de este scraper) → se inyecta acá. */
  setPool(pool: TokenPool): void { this.pool = pool; }

  // ── Navegación del sitio (implementa el abstracto de WebScraper) ──────────
  protected async irAFormulario(page: Page, hm: HumanMouse, label: string): Promise<void> {
    await page.goto(this.cfg.urlSite, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.locator('[id="aceptaOption:0"]').waitFor({ state: "visible", timeout: 10000 });
    await hm.click(page.locator('[id="aceptaOption:0"]'));   // aceptar términos
    await page.locator('[id="continuarBtn"]').waitFor({ state: "visible", timeout: 10000 });
    await hm.click(page.locator('[id="continuarBtn"]'));     // continuar
    await page.locator("#cedulaInput").waitFor({ state: "visible", timeout: 15000 });
    console.log(`[${label}][NAV] Formulario listo.`);
  }

  // ── IScraper.consultar: reintenta ante NO DETERMINADO / fallos transitorios ──
  async consultar(cedula: string, tipo: string = "cc"): Promise<any> {
    const wid = ++this.reqCounter;
    this.pool.semaphore.trackStart();
    try {
      let intentos = 0;
      while (true) {
        try {
          const result = await this.ejecutarConsulta(wid, cedula, tipo);
          if (result.datos.estado === "NO DETERMINADO" && intentos < this.cfg.maxIntentos - 1) {
            console.log(`[R${wid}][RETRY] NO DETERMINADO — reintentando...`);
            await esperar(2000);
            intentos++;
            continue;
          }
          return result;
        } catch (e) {
          if ((e as any).poolUnavailable) throw e; // pool vacío → 503, reintentar no ayuda
          intentos++;
          if (intentos < this.cfg.maxIntentos) {
            console.log(`[R${wid}][RETRY] fallo intento ${intentos}/${this.cfg.maxIntentos}: ${(e as Error).message}`);
            await esperar(1000);
          } else throw e;
        }
      }
    } finally {
      this.pool.semaphore.trackEnd();
    }
  }

  // ── Una consulta: token del pool → submit (con lock) → parsear → screenshot ──
  private async ejecutarConsulta(wid: number, cedula: string, tipo: string) {
    const { page, expiresAt } = await this.pool.getToken();
    console.log(`[W${wid}][CONSULTA] ${tipo.toUpperCase()} ${cedula} — token TTL: ${Math.round((expiresAt - Date.now()) / 1000)}s`);
    try {
      const release = await this.mutex.acquire();
      let url: string, datos: DatosConsulta, resultado_raw: string;
      try {
        const currentTipo = await page.locator("#cedulaTipo").inputValue().catch(() => "cc");
        if (currentTipo !== tipo) {
          await page.locator("#cedulaTipo").selectOption(tipo);
          if (!(await this.rcResuelto(page))) throw new Error("Token del pool expiró tras selectOption");
        }
        const hmC = new HumanMouse(page); // tipeo/click humano de la consulta
        await hmC.type(page.locator("#cedulaInput"), cedula);
        await hmC.click(page.getByRole("button", { name: /consultar/i }));
        hmC.stop();
        await Promise.race([
          page.waitForLoadState("networkidle", { timeout: 20000 }),
          page.locator("#form\\:mensajeCiudadano").waitFor({ state: "visible", timeout: 20000 }),
        ]).catch(() => {});
        url = page.url();
        ({ datos, resultado_raw } = await this.parsearResultado(page, cedula));
      } finally { release(); }
      console.log(`[W${wid}][CONSULTA] OK — ${datos.nombre ?? "?"} | ${datos.estado}`);

      const screenshot_url = await this.capturarPantalla(page, cedula);
      return { cedula, tipo, datos, resultado_raw, url, screenshot_url };
    } finally {
      await this.pool.discard(page);
    }
  }

  private async capturarPantalla(page: Page, cedula: string): Promise<string> {
    await page.locator("#form\\:mensajeCiudadano").waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0));
    await esperar(300);
    const file = `${Date.now()}_${cedula}.png`;
    const dest = path.join(this.cfg.screenshotsDir, file);
    try {
      const dims = await page.evaluate(() => ({
        w: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
        h: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      }));
      await page.setViewportSize({ width: Math.max(dims.w, 1280), height: Math.min(dims.h, 8000) });
      await esperar(400);
      await page.screenshot({ path: dest });
      await page.setViewportSize({ width: 1280, height: 800 });
    } catch {
      await page.screenshot({ path: dest, fullPage: true }).catch(() => {});
    }
    return `${this.cfg.baseUrl}/screenshot/${file}`;
  }

  private async parsearResultado(page: Page, cedula: string): Promise<{ datos: DatosConsulta; resultado_raw: string }> {
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
      if (esViewExpired) throw new Error(`ViewExpiredException — sesión JSF expirada (url: ${url.split("/").pop()})`);
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
    const estadoLinea = texto.split("\n").map(l => l.trim())
      .find(l => /ASUNTOS PENDIENTES/i.test(l) && !/leyenda|aplica para|conformidad|art[íi]culo|sentencia/i.test(l));
    const estado = estadoLinea || "NO DETERMINADO";
    const sinPendientes = /NO TIENE ASUNTOS PENDIENTES/i.test(estado);
    const tiene_antecedentes = /ASUNTOS PENDIENTES/i.test(estado) && !sinPendientes;

    return {
      datos: { cedula_consultada: cedula, nombre, tiene_antecedentes, estado, fecha_consulta: extraido.fecha_consulta, hora_consulta: extraido.hora_consulta },
      resultado_raw: texto,
    };
  }
}
