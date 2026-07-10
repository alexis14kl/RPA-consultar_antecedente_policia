// core/CdpConnection.ts
// Dueño único del browser/context vía CDP + reconexión automática. Encapsula el
// ciclo de vida: conectar, entregar páginas del context VIVO, y reconectar solo si
// Chrome se cae (sin morir el proceso). Desacoplado del pool: al desconectarse llama
// el callback `onDeadContext` para que el TokenPool limpie sus páginas muertas.
import { chromium, Browser, BrowserContext, Page, CDPSession } from "playwright";
import http from "http";
import { esperar } from "./util";

export class CdpConnection {
  private _browser: Browser | null = null;
  private _context: BrowserContext | null = null;
  private _reconnecting = false; // guard: un solo loop de reconexión a la vez
  private readonly siteHost: string;

  constructor(
    private readonly cdpPort: number,
    private readonly siteUrl: string,
    private readonly onDeadContext: () => void, // limpiar el pool muerto al desconectar
  ) {
    let h = siteUrl;
    try { h = new URL(siteUrl).hostname; } catch {}
    this.siteHost = h;
  }

  // Nullable a propósito: el reaper lo consulta y hace no-op si aún no hay context.
  get context(): BrowserContext | null { return this._context; }

  // Páginas SIEMPRE del context vivo. Lanzan si estamos reconectando (el llamador
  // ya trata el error como fallo transitorio).
  async newPage(): Promise<Page> {
    if (!this._context) throw new Error("CDP sin context (reconectando)");
    return this._context.newPage();
  }
  async newCDPSession(page: Page): Promise<CDPSession> {
    if (!this._context) throw new Error("CDP sin context (reconectando)");
    return this._context.newCDPSession(page);
  }

  // Conecta (o reconecta), toma el context, aplica el init-script anti-automatización
  // y el handler que cierra tabs espurias (deja solo about:blank y las del sitio).
  async connect(): Promise<void> {
    await this.asegurarPagina();
    this._browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`);
    const ctxList = this._browser.contexts();
    this._context = ctxList.length > 0 ? ctxList[0] : await this._browser.newContext();

    await this._context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
      window.open = () => null;
    });

    const host = this.siteHost;
    const browserCdp = await this._browser.newBrowserCDPSession();
    await browserCdp.send("Target.setDiscoverTargets", { discover: true });
    browserCdp.on("Target.targetCreated", async (event: any) => {
      const t = event.targetInfo;
      if (t.type === "page" && t.url !== "about:blank" && !t.url.includes(host)) {
        await browserCdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
      }
    });

    this._browser.on("disconnected", () => this.onDisconnect());
  }

  private onDisconnect(): void {
    if (this._reconnecting) return;
    this._reconnecting = true;
    console.warn("[CDP] Browser desconectado — descarto pool muerto y reconecto...");
    this.onDeadContext();
    this.reconnect();
  }

  private async reconnect(): Promise<void> {
    let intento = 0;
    while (true) {
      intento++;
      try {
        if (await this.cdpActivo()) {
          await this.connect(); // connect ya hace asegurarPagina
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

  // Cierre a propósito (SIGTERM): latchea reconnecting para que "disconnected" no
  // dispare reconexión mientras el proceso se apaga.
  async close(): Promise<void> {
    this._reconnecting = true;
    await this._browser?.close().catch(() => {});
  }

  // ¿El endpoint HTTP del CDP responde? (lo usa el arranque y la reconexión).
  async cdpActivo(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${this.cdpPort}/json/version`, (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on("error", () => resolve(false));
      req.end();
    });
  }

  private async asegurarPagina(): Promise<void> {
    const targets: any[] = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${this.cdpPort}/json`, (res) => {
        let data = ""; res.on("data", (d) => (data += d));
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve([]); } });
      }).on("error", () => resolve([]));
    });
    if (targets.some((t) => t.type === "page")) return;
    await new Promise<void>((resolve) => {
      const req = http.request(`http://127.0.0.1:${this.cdpPort}/json/new?${this.siteUrl}`, { method: "PUT" }, (res) => { res.resume(); res.on("end", () => resolve()); });
      req.on("error", () => resolve());
      req.end();
    });
  }
}
