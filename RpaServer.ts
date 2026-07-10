// RpaServer.ts — orquestador + servidor HTTP.
// Compone todas las piezas (CdpConnection, TokenPool, AntecedentesScraper, ResultCache,
// CachingScraperProxy), las cablea, arranca el browser y expone la API JSON.
import http from "http";
import path from "path";
import { readFile, readdir, stat, unlink } from "fs/promises";
import { CdpConnection } from "./core/CdpConnection";
import { ResultCache } from "./core/ResultCache";
import { TokenPool, TokenPoolConfig } from "./core/TokenPool";
import { AntecedentesScraper, AntecedentesConfig } from "./scrapers/AntecedentesScraper";
import { CachingScraperProxy } from "./scrapers/CachingScraperProxy";
import { IScraper } from "./scrapers/IScraper";

export interface RpaConfig extends AntecedentesConfig {
  serverPort: number;
  serverHost: string;
  cdpPort: number;
  maxWorkers: number;
  loteStreamMax: number;
  cacheTtlMs: number;
  consultaTimeoutMs: number;
  pool: Omit<TokenPoolConfig, "maxWorkers">;
}

const TIPOS_VALIDOS = ["cc", "cx", "pa", "dp"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export class RpaServer {
  private readonly cdp: CdpConnection;
  private readonly cache: ResultCache;
  private readonly scraper: AntecedentesScraper;
  private readonly pool: TokenPool;
  private readonly api: IScraper; // el proxy (caché + dedup) — a él le habla la HTTP
  private http!: http.Server;

  constructor(private readonly cfg: RpaConfig) {
    // Cableado (composición). El orden resuelve las deps: scraper → pool → setPool.
    this.cdp = new CdpConnection(cfg.cdpPort, cfg.urlSite, () => this.pool.descartarPoolMuerto());
    this.cache = new ResultCache(cfg.cacheTtlMs);
    this.scraper = new AntecedentesScraper(this.cdp, cfg);
    this.pool = new TokenPool(
      this.cdp,
      (page, hm, label) => this.scraper.solveOne(page, hm, label), // Strategy: cómo resolver
      (page) => this.scraper.rcResuelto(page),                     // validar token
      { ...cfg.pool, maxWorkers: cfg.maxWorkers },
    );
    this.scraper.setPool(this.pool);
    this.api = new CachingScraperProxy(this.scraper, this.cache, cfg.consultaTimeoutMs); // Proxy
  }

  // ── Arranque ──────────────────────────────────────────────────────────────
  async start(): Promise<void> {
    try { await this.initBrowser(); }
    catch (e: any) { console.error("ERROR init browser:", e.message); process.exit(1); }

    this.limpiarScreenshotsPeriodico();
    this.http = http.createServer((req, res) => this.handle(req, res).catch((e) => {
      console.error("[HTTP]", e?.message);
      if (!res.writableEnded) this.json(res, 500, { ok: false, error: "error interno" });
    }));

    const shutdown = async (signal: string) => {
      console.log(`\n[${signal}] Cerrando...`);
      this.http.close();
      await this.cdp.close();
      process.exit(0);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    this.http.listen(this.cfg.serverPort, this.cfg.serverHost, () => {
      console.log(`\nServidor activo en http://${this.cfg.serverHost}:${this.cfg.serverPort} — ${this.cfg.maxWorkers} worker(s)`);
      console.log('  POST /consultar              { "cedula": "1234567", "tipo": "cc" }');
      console.log('  POST /consultar-lote         { "cedulas": [{"cedula": "...", "tipo": "cc"}] }');
      console.log('  POST /consultar-lote-stream  { "cedulas": [{"cedula": "...", "tipo": "cc"}] }  (NDJSON)');
      console.log("  GET  /health");
      console.log(`\n  Tipos válidos: ${TIPOS_VALIDOS.map(t => `"${t}"`).join(" | ")}\n`);
    });
  }

  private async initBrowser(): Promise<void> {
    if (!(await this.cdp.cdpActivo())) throw new Error(`CDP no activo en puerto ${this.cfg.cdpPort}.`);
    console.log("CDP activo — conectando browser...");
    await this.cdp.connect();
    this.pool.start();
    console.log("Warmup del pool (esperando 1er token, luego escucho igual)...");
    const n = await this.pool.warmup();
    if (n > 0) console.log(`Pool listo con ${n} token(s) — semáforo de ${this.cfg.maxWorkers} slot(s).`);
    else console.log(`Sin token tras ${this.cfg.pool.warmupMs / 1000}s — abro el puerto igual (503 hasta que el pool llene).`);
  }

  // ── Router HTTP ───────────────────────────────────────────────────────────
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }

    if (req.method === "GET" && req.url === "/health") {
      return this.json(res, 200, { ok: true, cdp: this.cfg.cdpPort, ...this.pool.stats, cache: this.cache.stats });
    }
    if (req.method === "POST" && req.url === "/circuit/reset") {
      return this.json(res, 200, { ok: true, estaba_abierto: this.pool.resetCircuit() });
    }
    if (req.method === "GET" && req.url?.startsWith("/screenshot/")) return this.serveScreenshot(req, res);
    if (req.method === "POST" && req.url === "/consultar") return this.handleConsultar(req, res);
    if (req.method === "POST" && req.url === "/consultar-lote") return this.handleLote(req, res);
    if (req.method === "POST" && req.url === "/consultar-lote-stream") return this.handleLoteStream(req, res);

    this.json(res, 404, { ok: false, error: "Ruta no encontrada" });
  }

  private async handleConsultar(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: any;
    try { body = await this.parseBody(req); } catch { return this.json(res, 400, { ok: false, error: "JSON inválido" }); }
    const cedula = String(body.cedula ?? "").trim();
    const tipo = String(body.tipo ?? "cc").trim();
    if (!cedula) return this.json(res, 400, { ok: false, error: "cedula requerida" });
    if (!/^\d+$/.test(cedula)) return this.json(res, 400, { ok: false, error: "cedula debe contener solo numeros" });
    if (!TIPOS_VALIDOS.includes(tipo)) return this.json(res, 400, { ok: false, error: `tipo inválido — valores aceptados: ${TIPOS_VALIDOS.join(", ")}` });
    try {
      const result = await this.api.consultar(cedula, tipo);
      return this.json(res, 200, { ok: true, ...result });
    } catch (e: any) {
      const status = e.poolUnavailable ? 503 : 500;
      if (status === 503) console.warn("[503]", e.message); else console.error("[ERROR]", e.message);
      return this.json(res, status, { ok: false, cedula, error: e.message });
    }
  }

  private async handleLote(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: any;
    try { body = await this.parseBody(req); } catch { return this.json(res, 400, { ok: false, error: "JSON inválido" }); }
    const items = this.validarLote(body, 50);
    if ("error" in items) return this.json(res, 400, { ok: false, error: items.error });
    console.log(`[LOTE] ${items.length} consultas`);
    const resultados = await Promise.all(items.map(async (it) => {
      try { return { ok: true, ...await this.api.consultar(it.cedula, it.tipo) }; }
      catch (e: any) { return { ok: false, cedula: it.cedula, error: e.message }; }
    }));
    return this.json(res, 200, { ok: true, total: resultados.length, resultados });
  }

  private async handleLoteStream(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: any;
    try { body = await this.parseBody(req); } catch { return this.json(res, 400, { ok: false, error: "JSON inválido" }); }
    const items = this.validarLote(body, this.cfg.loteStreamMax);
    if ("error" in items) return this.json(res, 400, { ok: false, error: items.error });

    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", ...CORS });
    const write = (obj: any) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };
    console.log(`[LOTE-STREAM] ${items.length} cédulas`);
    write({ event: "start", total: items.length, workers: this.cfg.maxWorkers, pool: this.pool.stats.pool });
    let oks = 0;
    await Promise.all(items.map((it, idx) =>
      this.api.consultar(it.cedula, it.tipo)
        .then((r: any) => { oks++; write({ idx, ok: true, ...r }); })
        .catch((e: any) => write({ idx, ok: false, cedula: it.cedula, error: e.message }))
    ));
    if (!res.writableEnded) res.end(JSON.stringify({ event: "done", total: items.length, ok: oks }) + "\n");
  }

  // ── Helpers HTTP ──────────────────────────────────────────────────────────
  private validarLote(body: any, max: number): { cedula: string; tipo: string }[] | { error: string } {
    if (!Array.isArray(body.cedulas) || body.cedulas.length === 0) return { error: "cedulas debe ser un array no vacío" };
    if (body.cedulas.length > max) return { error: `máximo ${max} cédulas por lote` };
    const items = body.cedulas.map((it: any) => ({ cedula: String(it.cedula ?? "").trim(), tipo: String(it.tipo ?? "cc").trim() }));
    const invalidas = items.filter((i: any) => !i.cedula || !/^\d+$/.test(i.cedula));
    if (invalidas.length > 0) return { error: `Cédulas inválidas: ${invalidas.map((i: any) => i.cedula || "(vacía)").join(", ")}` };
    const tiposMal = items.filter((i: any) => !TIPOS_VALIDOS.includes(i.tipo));
    if (tiposMal.length > 0) return { error: `Tipos inválidos: ${tiposMal.map((i: any) => i.tipo).join(", ")} — valores aceptados: ${TIPOS_VALIDOS.join(", ")}` };
    return items;
  }

  private async serveScreenshot(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const filename = path.basename((req.url || "").replace("/screenshot/", ""));
    try {
      const data = await readFile(path.join(this.cfg.screenshotsDir, filename));
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": data.length, ...CORS });
      res.end(data);
    } catch { this.json(res, 404, { ok: false, error: "Screenshot no encontrado o expirado" }); }
  }

  private parseBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", d => (body += d));
      req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("JSON inválido")); } });
      req.on("error", reject);
    });
  }

  private json(res: http.ServerResponse, status: number, data: any): void {
    const body = JSON.stringify(data);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...CORS });
    res.end(body);
  }

  private limpiarScreenshotsPeriodico(): void {
    setInterval(async () => {
      const cutoff = Date.now() - 10 * 60 * 1000;
      try {
        for (const f of await readdir(this.cfg.screenshotsDir)) {
          const fp = path.join(this.cfg.screenshotsDir, f);
          if ((await stat(fp)).mtimeMs < cutoff) await unlink(fp);
        }
      } catch {}
    }, 60 * 1000);
  }
}
